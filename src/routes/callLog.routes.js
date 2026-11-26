import { Router } from "express";
import mongoose from "mongoose";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { CallLog } from "../models/CallLog.js";
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";
import { RmCallingAssignment } from "../models/RmCallingAssignment.js";
import { LeadSheetAudit } from "../models/LeadSheetAudit.js";
import { normalizePhoneToTen } from "../utils/phoneNormalize.js";
import { activeUsersFilter } from "../utils/activeUsersFilter.js";
import { activeApplicationsFilter } from "../utils/activeApplicationsFilter.js";
import { inferLoanTypeFromText, parseSheetNumber } from "../utils/metaLeadSheet.js";

const router = Router();

// POST /api/calls/log — Record a call from Android app or Web dialer (tracks OUTGOING, INCOMING, MISSED)
router.post(
  "/log",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.ASM, ROLES.RM),
  async (req, res) => {
    try {
      const {
        targetPhone,
        targetName,
        contactType,
        callType = "OUTGOING",
        callStartTime,
        callEndTime,
        durationSeconds = 0,
        feedback = "",
        notes = "",
        source = "android_native",
      } = req.body;

      const cleanPhone = normalizePhoneToTen(targetPhone);
      if (!cleanPhone || cleanPhone.length !== 10) {
        return res.status(400).json({ message: "A valid 10-digit target phone number is required" });
      }

      const duration = Math.max(0, parseInt(durationSeconds, 10) || 0);
      const isVerifiedRealCall = duration > 0 && (callType === "OUTGOING" || callType === "INCOMING");

      const rmUser = req.user;
      const rmName = `${rmUser.firstName || ""} ${rmUser.lastName || ""}`.trim() || rmUser.name || "RM";

      // Identify target contact in User or Application
      let contactId = null;
      let identifiedContactType = contactType || "unknown";
      let resolvedTargetName = targetName || "";
      let applicationId = null;

      const userMatch = await User.findOne(
        activeUsersFilter({
          $or: [{ phone: cleanPhone }, { alternatePhone: cleanPhone }],
        })
      )
        .select("_id firstName lastName name role employeeId")
        .lean();

      if (userMatch) {
        contactId = userMatch._id;
        identifiedContactType = userMatch.role === "partner" ? "partner" : "customer";
        if (!resolvedTargetName) {
          resolvedTargetName = `${userMatch.firstName || ""} ${userMatch.lastName || ""}`.trim() || userMatch.name || "";
        }
      } else {
        const appMatch = await Application.findOne(
          activeApplicationsFilter({
            $or: [{ "customer.phone": cleanPhone }, { "customer.alternatePhone": cleanPhone }],
          })
        )
          .select("_id appNo customer.name customer.phone customerId")
          .lean();

        if (appMatch) {
          applicationId = appMatch._id;
          contactId = appMatch.customerId || null;
          identifiedContactType = "customer";
          if (!resolvedTargetName) {
            resolvedTargetName = appMatch.customer?.name || "";
          }
        }
      }

      const log = await CallLog.create({
        rmId: rmUser._id,
        rmName,
        targetPhone: cleanPhone,
        targetName: resolvedTargetName || "Unknown Contact",
        contactType: identifiedContactType,
        contactId,
        applicationId,
        callType: ["OUTGOING", "INCOMING", "MISSED", "REJECTED"].includes(callType) ? callType : "OUTGOING",
        callStartTime: callStartTime ? new Date(callStartTime) : new Date(),
        callEndTime: callEndTime ? new Date(callEndTime) : new Date(),
        durationSeconds: duration,
        isVerifiedRealCall,
        feedback,
        notes,
        source,
      });

      // Auto-update all assigned calling sheets for this RM where this phone exists
      try {
        const rmAssignments = await RmCallingAssignment.find({
          rmId: rmUser._id,
          "contacts.phone": cleanPhone,
        });

        for (const activeAssignment of rmAssignments) {
          let contactUpdated = false;

          for (const c of activeAssignment.contacts) {
            if (c.phone === cleanPhone) {
              c.callCount = (c.callCount || 0) + 1;
              c.lastCallTime = callStartTime ? new Date(callStartTime) : new Date();
              c.lastCallDuration = duration;
              c.lastCallType = callType;
              c.isVerified = isVerifiedRealCall;

              if (isVerifiedRealCall) {
                if (!c.status || c.status === "PENDING" || c.status === "UNANSWERED" || c.status === "RINGING") {
                  c.status = "CONNECTED";
                }
              } else if (callType === "MISSED") {
                if (!c.status || c.status === "PENDING") {
                  c.status = "CALL_BACK";
                }
              } else if (!c.status || c.status === "PENDING") {
                c.status = "UNANSWERED";
              }

              contactUpdated = true;
            }
          }

          if (contactUpdated) {
            const total = activeAssignment.contacts.length;
            const called = activeAssignment.contacts.filter((c) => c.status && c.status !== "PENDING").length;
            const connected = activeAssignment.contacts.filter((c) =>
              ["CONNECTED", "INTERESTED", "DOCUMENTS_PENDING"].includes(c.status)
            ).length;
            const pending = total - called;
            const totalTalkTime = activeAssignment.contacts.reduce((acc, c) => acc + (c.lastCallDuration || 0), 0);

            activeAssignment.stats = {
              total,
              called,
              connected,
              pending,
              totalTalkTimeSeconds: totalTalkTime,
            };

            await activeAssignment.save();
          }
        }
      } catch (assignErr) {
        console.warn("Failed to update assigned calling sheet on call:", assignErr);
      }

      return res.status(201).json({
        success: true,
        message: "Call log saved successfully",
        data: log,
      });
    } catch (err) {
      console.error("Failed to save call log:", err);
      return res.status(500).json({ message: err.message || "Failed to record call log" });
    }
  }
);

// POST /api/calls/assignments/create — Assign leads or partners to an RM with daily target
router.post(
  "/assignments/create",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.ASM),
  async (req, res) => {
    try {
      const {
        rmId,
        assignmentType = "CUSTOMER", // 'CUSTOMER' | 'PARTNER'
        sheetName = "Calling Sheet",
        dailyTarget = 25,
        date = new Date().toISOString().slice(0, 10),
        contacts = [],
      } = req.body;

      if (!rmId) {
        return res.status(400).json({ message: "RM ID is required" });
      }

      const rmUser = await User.findById(rmId).select("firstName lastName name role employeeId").lean();
      if (!rmUser) {
        return res.status(404).json({ message: "RM user not found" });
      }
      const rmName = `${rmUser.firstName || ""} ${rmUser.lastName || ""}`.trim() || rmUser.name || "RM";

      const cleanContacts = [];
      const seenPhones = new Set();

      for (const item of contacts) {
        const phone = normalizePhoneToTen(item.phone);
        if (!phone || phone.length !== 10 || seenPhones.has(phone)) continue;
        seenPhones.add(phone);

        cleanContacts.push({
          name: item.name || "—",
          phone,
          contactType: assignmentType === "PARTNER" ? "partner" : "customer",
          partnerId: item.partnerId || null,
          customerId: item.customerId || null,
          city: item.city || "",
          loanType: item.loanType || item.metaLoanType || inferLoanTypeFromText(sheetName) || "",
          loanAmount: parseSheetNumber(item.loanAmount || item.metaLoanAmount || 0),
          loanAmountText: String(item.metaLoanAmount || "").trim(),
          salary: parseSheetNumber(item.salary || item.metaSalary || 0),
          salaryText: String(item.metaSalary || "").trim(),
          leadSource: item.leadSource || "Meta Ads",
          status: "PENDING",
          notes: item.notes || "",
        });
      }

      if (!cleanContacts.length) {
        return res.status(400).json({ message: "No valid contacts provided to assign" });
      }

      const adminUser = req.user;
      const assignedByName = `${adminUser.firstName || ""} ${adminUser.lastName || ""}`.trim() || adminUser.name || "Admin";

      const assignment = await RmCallingAssignment.create({
        rmId: rmUser._id,
        rmName,
        assignedBy: adminUser._id,
        assignedByName,
        assignmentType: assignmentType === "PARTNER" ? "PARTNER" : "CUSTOMER",
        sheetName,
        date,
        dailyTarget: parseInt(dailyTarget, 10) || 25,
        contacts: cleanContacts,
        stats: {
          total: cleanContacts.length,
          called: 0,
          connected: 0,
          pending: cleanContacts.length,
          totalTalkTimeSeconds: 0,
        },
      });

      return res.status(201).json({
        success: true,
        message: `Successfully assigned ${cleanContacts.length} contacts to ${rmName}`,
        data: assignment,
      });
    } catch (err) {
      console.error("Failed to create calling assignment:", err);
      return res.status(500).json({ message: err.message || "Failed to create calling assignment" });
    }
  }
);

// POST /api/calls/assignments/bulk-split — Split and assign leads across multiple RMs
router.post(
  "/assignments/bulk-split",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.ASM),
  async (req, res) => {
    try {
      const {
        sheetName = "Calling Sheet",
        assignmentType = "CUSTOMER",
        dailyTarget = 25,
        date = new Date().toISOString().slice(0, 10),
        allocations = [], // Array of { rmId, contacts: [...] }
      } = req.body;

      if (!Array.isArray(allocations) || allocations.length === 0) {
        return res.status(400).json({ message: "No RM allocations provided." });
      }

      const adminUser = req.user;
      const assignedByName = `${adminUser.firstName || ""} ${adminUser.lastName || ""}`.trim() || adminUser.name || "Admin";

      const createdAssignments = [];
      let totalContactsAssigned = 0;

      for (const alloc of allocations) {
        const { rmId, contacts = [] } = alloc;
        if (!rmId || !contacts.length) continue;

        const rmUser = await User.findById(rmId).select("firstName lastName name employeeId").lean();
        if (!rmUser) continue;

        const rmName = `${rmUser.firstName || ""} ${rmUser.lastName || ""}`.trim() || rmUser.name || "RM";

        const cleanContacts = [];
        const seenPhones = new Set();
        for (const item of contacts) {
          const phone = normalizePhoneToTen(item.phone);
          if (!phone || phone.length !== 10 || seenPhones.has(phone)) continue;
          seenPhones.add(phone);

          cleanContacts.push({
            name: item.name || "—",
            phone,
            contactType: assignmentType === "PARTNER" ? "partner" : "customer",
            partnerId: item.partnerId || null,
            customerId: item.customerId || null,
            city: item.city || "",
            loanType: item.loanType || item.metaLoanType || inferLoanTypeFromText(sheetName) || "",
            loanAmount: parseSheetNumber(item.loanAmount || item.metaLoanAmount || 0),
            loanAmountText: String(item.metaLoanAmount || "").trim(),
            salary: parseSheetNumber(item.salary || item.metaSalary || 0),
            salaryText: String(item.metaSalary || "").trim(),
            leadSource: item.leadSource || sheetName || "Meta Ads",
            status: "PENDING",
            notes: item.notes || "",
          });
        }

        if (!cleanContacts.length) continue;

        const assignment = await RmCallingAssignment.create({
          rmId: rmUser._id,
          rmName,
          assignedBy: adminUser._id,
          assignedByName,
          assignmentType: assignmentType === "PARTNER" ? "PARTNER" : "CUSTOMER",
          sheetName: `${sheetName} (${rmName})`,
          date,
          dailyTarget: parseInt(dailyTarget, 10) || 25,
          contacts: cleanContacts,
          stats: {
            total: cleanContacts.length,
            called: 0,
            connected: 0,
            pending: cleanContacts.length,
            totalTalkTimeSeconds: 0,
          },
        });

        createdAssignments.push({
          rmId: rmUser._id,
          rmName,
          contactsCount: cleanContacts.length,
          assignmentId: assignment._id,
        });
        totalContactsAssigned += cleanContacts.length;
      }

      return res.status(201).json({
        success: true,
        message: `Successfully allocated ${totalContactsAssigned} leads across ${createdAssignments.length} RM(s)`,
        assignments: createdAssignments,
      });
    } catch (err) {
      console.error("Failed to create bulk split calling assignment:", err);
      return res.status(500).json({ message: err.message || "Failed to split calling assignment" });
    }
  }
);

// GET /api/calls/assignments/admin-overview — Daily target tracking across all RMs (or single RM)
router.get(
  "/assignments/admin-overview",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.ASM, ROLES.RM),
  async (req, res) => {
    try {
      const { date = new Date().toISOString().slice(0, 10), rmId } = req.query;

      const userId = req.user?.sub || req.user?._id;
      const assignmentFilter = {};
      if (req.user.role === ROLES.RM) {
        assignmentFilter.rmId = userId;
      } else if (rmId) {
        assignmentFilter.rmId = rmId;
      }

      if (req.query.scope === "all") {
        // Return all assignments
      } else {
        // Strictly filter day-wise: show ONLY the selected date
        assignmentFilter.date = date;
      }

      const assignments = await RmCallingAssignment.find(assignmentFilter)
        .sort({ createdAt: -1 })
        .lean();

      const rmFilter = {
        role: { $in: [ROLES.RM, "RM", "rm"] },
        status: { $ne: "SUSPENDED" },
      };
      if (req.user.role === ROLES.RM) {
        rmFilter._id = userId;
      } else if (rmId) {
        rmFilter._id = rmId;
      } else if (req.user.role === ROLES.RSM || req.user.role === ROLES.ASM) {
        const managerId = userId;
        let managerIds = [managerId];

        if (req.user.role === ROLES.RSM) {
          // If RSM, also resolve all specialized ASMs that report under this RSM
          const childAsmIds = await User.find(
            activeUsersFilter({
              role: { $in: [ROLES.ASM, "ASM", "asm"] },
              $or: [{ rsmId: managerId }, { asmId: managerId }],
            })
          ).distinct("_id");
          if (childAsmIds && childAsmIds.length > 0) {
            managerIds = managerIds.concat(childAsmIds);
          }
        }

        const scopedRms = await User.find(
          activeUsersFilter({
            role: { $in: [ROLES.RM, "RM", "rm"] },
            status: { $ne: "SUSPENDED" },
            $or: [
              { rsmId: { $in: managerIds } },
              { asmId: { $in: managerIds } },
              { personalAsmId: { $in: managerIds } },
              { personalRsmId: { $in: managerIds } },
              { businessAsmId: { $in: managerIds } },
              { businessRsmId: { $in: managerIds } },
              { homeLapAsmId: { $in: managerIds } },
              { homeLapRsmId: { $in: managerIds } },
              { businessHomeRsmId: { $in: managerIds } },
              { businessHomeAsmId: { $in: managerIds } },
            ],
          })
        ).distinct("_id");

        if (scopedRms && scopedRms.length > 0) {
          rmFilter._id = { $in: scopedRms };
        } else {
          rmFilter._id = { $in: [] };
        }
      }

      const rms = await User.find(activeUsersFilter(rmFilter))
        .select("firstName lastName name employeeId phone rmType loanSpecialization branchName franchiseType")
        .sort({ firstName: 1 })
        .lean();

      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const dailyCalls = await CallLog.find({
        callStartTime: { $gte: startOfDay, $lte: endOfDay },
      })
        .select("rmId callType durationSeconds isVerifiedRealCall contactType")
        .lean();

      const rmStatsMap = new Map();
      for (const rm of rms) {
        rmStatsMap.set(String(rm._id), {
          rmId: rm._id,
          rmName: `${rm.firstName || ""} ${rm.lastName || ""}`.trim() || rm.name,
          employeeId: rm.employeeId || "",
          phone: rm.phone || "",
          rmType: rm.rmType || "HYBRID",
          loanSpecialization: rm.loanSpecialization || (rm.rmType === "CUSTOMER" ? "PL_LAP" : "ALL"),
          branchName: rm.branchName || "",
          franchiseType: rm.franchiseType || "HEAD_OFFICE",
          partnerAssignments: [],
          customerAssignments: [],
          partnerCallsTarget: 0,
          partnerCallsDone: 0,
          partnerCallsConnected: 0,
          customerCallsTarget: 0,
          customerCallsDone: 0,
          customerCallsConnected: 0,
          outgoingCount: 0,
          incomingCount: 0,
          missedCount: 0,
          verifiedCount: 0,
          totalTalkTimeSeconds: 0,
        });
      }

      for (const a of assignments) {
        const key = String(a.rmId);
        const stat = rmStatsMap.get(key);
        if (!stat) continue;

        if (a.assignmentType === "PARTNER") {
          stat.partnerAssignments.push(a);
          stat.partnerCallsTarget += a.dailyTarget || 0;
          stat.partnerCallsDone += a.stats?.called || 0;
          stat.partnerCallsConnected += a.stats?.connected || 0;
        } else {
          stat.customerAssignments.push(a);
          stat.customerCallsTarget += a.dailyTarget || 0;
          stat.customerCallsDone += a.stats?.called || 0;
          stat.customerCallsConnected += a.stats?.connected || 0;
        }
      }

      for (const call of dailyCalls) {
        const key = String(call.rmId);
        const stat = rmStatsMap.get(key);
        if (!stat) continue;

        if (call.callType === "OUTGOING") stat.outgoingCount += 1;
        else if (call.callType === "INCOMING") stat.incomingCount += 1;
        else if (call.callType === "MISSED") stat.missedCount += 1;

        if (call.isVerifiedRealCall) stat.verifiedCount += 1;
        stat.totalTalkTimeSeconds += call.durationSeconds || 0;
      }

      const overviewList = Array.from(rmStatsMap.values()).map((item) => ({
        ...item,
        totalTalkTimeMinutes: Math.round(item.totalTalkTimeSeconds / 60),
        overallTarget: item.partnerCallsTarget + item.customerCallsTarget,
        overallDone: item.partnerCallsDone + item.customerCallsDone,
        overallPercentage:
          item.partnerCallsTarget + item.customerCallsTarget > 0
            ? Math.min(
                100,
                Math.round(
                  ((item.partnerCallsDone + item.customerCallsDone) /
                    (item.partnerCallsTarget + item.customerCallsTarget)) *
                    100
                )
              )
            : 0,
      }));

      return res.json({
        success: true,
        date,
        totalRms: rms.length,
        rms: overviewList,
      });
    } catch (err) {
      console.error("Failed to fetch assignments overview:", err);
      return res.status(500).json({ message: "Failed to fetch overview" });
    }
  }
);

// GET /api/calls/assignments/rm-sheet — Fetch RM's calling sheet day-wise
router.get(
  "/assignments/rm-sheet",
  auth,
  requireRole(ROLES.RM, ROLES.ASM, ROLES.RSM, ROLES.ADMIN, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const rmId = req.query.rmId || req.user?.sub || req.user?._id;
      const {
        date,
        assignmentType,
        scope,
      } = req.query;

      const filter = { rmId };

      if (scope === "all" || date === "all") {
        // Return all assignments regardless of date
      } else {
        // Strictly filter day-wise: show ONLY the requested date (defaults to today)
        const targetDate = date || new Date().toISOString().slice(0, 10);
        filter.date = targetDate;
      }

      if (assignmentType && assignmentType !== "all") {
        filter.assignmentType = assignmentType;
      } else {
        const rmUser = await User.findById(rmId).select("rmType role").lean();
        if (rmUser?.rmType === "CUSTOMER") {
          filter.assignmentType = "CUSTOMER";
        } else if (rmUser?.rmType === "PARTNER") {
          filter.assignmentType = "PARTNER";
        }
      }

      const sheets = await RmCallingAssignment.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .lean();

      // Merge latest verified CallLog records so Calling Sheet modal always reflects real phone calls
      try {
        const sheetPhones = new Set();
        for (const s of sheets) {
          for (const c of s.contacts || []) {
            const clean = normalizePhoneToTen(c.phone);
            if (clean && clean.length === 10) {
              sheetPhones.add(clean);
              sheetPhones.add(`+91${clean}`);
              sheetPhones.add(`91${clean}`);
              sheetPhones.add(`0${clean}`);
            } else if (c.phone) {
              sheetPhones.add(c.phone);
            }
          }
        }
        if (sheetPhones.size > 0) {
          const logs = await CallLog.find({
            rmId,
            targetPhone: { $in: Array.from(sheetPhones) },
          })
            .sort({ callStartTime: -1 })
            .lean();
          const logMap = new Map();
          for (const log of logs) {
            const clean = normalizePhoneToTen(log.targetPhone) || log.targetPhone;
            if (!clean) continue;
            const existing = logMap.get(clean);
            if (!existing) {
              logMap.set(clean, log);
            } else if (
              (!existing.isVerifiedRealCall && existing.durationSeconds === 0) &&
              (log.isVerifiedRealCall || log.durationSeconds > 0) &&
              new Date(existing.callStartTime).toDateString() === new Date(log.callStartTime).toDateString()
            ) {
              logMap.set(clean, log);
            }
          }
          for (const s of sheets) {
            for (const c of s.contacts || []) {
              const clean = normalizePhoneToTen(c.phone) || c.phone;
              const log = logMap.get(clean);
              if (log) {
                if (!c.lastCallTime || new Date(log.callStartTime) >= new Date(c.lastCallTime)) {
                  c.lastCallTime = log.callStartTime;
                }
                if (log.durationSeconds > 0 && (!c.lastCallDuration || log.durationSeconds > c.lastCallDuration)) {
                  c.lastCallDuration = log.durationSeconds;
                }
                if (!c.lastCallType) c.lastCallType = log.callType;
                if (log.isVerifiedRealCall) c.isVerified = true;
                if ((!c.status || c.status === "PENDING") && (log.isVerifiedRealCall || log.durationSeconds > 0)) {
                  c.status = "CONNECTED";
                }
              }
            }
          }
        }
      } catch (mergeErr) {
        console.warn("Could not merge CallLogs into rm-sheet:", mergeErr?.message);
      }

      // Also dynamically surface incoming Online Form Leads & Applications assigned to this RM
      try {
        const partners = await User.find({
          rmId,
          role: ROLES.PARTNER,
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        }).select("_id firstName lastName partnerCode").lean();
        const partnerIds = partners.map((p) => p._id);
        const partnerMap = new Map();
        partners.forEach((p) =>
          partnerMap.set(String(p._id), `${p.firstName || ""} ${p.lastName || ""}`.trim() || p.partnerCode)
        );

        const appScope = {
          $or: [{ rmId }, { partnerId: { $in: partnerIds } }],
        };

        if (scope === "all" || date === "all") {
          // all leads
        } else {
          const targetDate = date || new Date().toISOString().slice(0, 10);
          const startOfDay = new Date(`${targetDate}T00:00:00.000Z`);
          const endOfDay = new Date(`${targetDate}T23:59:59.999Z`);
          appScope.$or = [
            {
              $or: [{ rmId }, { partnerId: { $in: partnerIds } }],
              createdAt: { $gte: startOfDay, $lte: endOfDay },
            },
            {
              $or: [{ rmId }, { partnerId: { $in: partnerIds } }],
              status: { $in: ["LEAD", "DRAFT", "DOC_INCOMPLETE", "SUBMITTED"] },
            },
          ];
        }

        const assignedApps = await Application.find(activeApplicationsFilter(appScope))
          .sort({ createdAt: -1 })
          .limit(100)
          .lean();

        if (assignedApps.length > 0) {
          const targetDate = date || new Date().toISOString().slice(0, 10);
          const appContacts = assignedApps
            .map((app) => {
              const custName =
                [app.customer?.firstName, app.customer?.lastName].filter(Boolean).join(" ") ||
                app.customer?.name ||
                "Lead";
              const pName = app.partnerId
                ? partnerMap.get(String(app.partnerId)) || "Partner"
                : "Direct Form";
              return {
                _id: String(app._id),
                name: custName,
                phone: app.customer?.phone || app.customer?.mobile || "",
                loanType: app.loanType || "Loan",
                amount: app.requestedAmount || app.loanAmount || 0,
                city: app.customer?.city || "",
                leadSource: `Lead: ${app.appNo || "New"} (${pName})`,
                partnerName: pName,
                callStatus: app.leadFollowUp?.status || "PENDING",
                status: app.leadFollowUp?.status || "PENDING",
                notes: app.leadFollowUp?.remarks || "",
                callCount: 0,
                createdAt: app.createdAt,
                applicationId: app._id,
                appNo: app.appNo || "LEAD",
              };
            })
            .filter((c) => c.phone);

          if (appContacts.length > 0) {
            sheets.unshift({
              _id: `apps_sheet_${rmId}_${targetDate}`,
              sheetName: "Online Leads & Forms",
              date: targetDate,
              assignmentType: filter.assignmentType || "CUSTOMER",
              contacts: appContacts,
              stats: {
                total: appContacts.length,
                called: appContacts.filter((c) => c.status !== "PENDING").length,
                connected: appContacts.filter((c) => c.status === "CONNECTED").length,
                pending: appContacts.filter((c) => c.status === "PENDING").length,
                totalTalkTimeSeconds: 0,
              },
            });
          }
        }
      } catch (appErr) {
        console.warn("Dynamic applications sheet error:", appErr?.message);
      }

      return res.json({ success: true, sheets });
    } catch (err) {
      console.error("Failed to fetch RM calling sheet:", err);
      return res.status(500).json({ message: "Failed to fetch calling sheet" });
    }
  }
);

// DELETE /api/calls/assignments/:id — Delete an assigned calling sheet from ALL RMs everywhere
router.delete(
  "/assignments/:id",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.ASM),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { fromAll = "true" } = req.query;

      const assignment = await RmCallingAssignment.findById(id);
      if (!assignment) {
        return res.status(404).json({ message: "Calling assignment not found" });
      }

      const sheetName = assignment.sheetName;
      const sheetDate = assignment.date;

      let deletedCount = 1;
      if (fromAll === "true" || fromAll === true) {
        // Delete this sheet from ALL RMs who received this sheet
        const delRes = await RmCallingAssignment.deleteMany({
          sheetName,
          date: sheetDate,
        });
        deletedCount = delRes.deletedCount || 1;

        // Also remove associated LeadSheetAudit record if exists
        const escaped = sheetName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
        await LeadSheetAudit.deleteMany({
          fileName: new RegExp(`^${escaped}`, "i"),
        }).catch(() => {});
      } else {
        await RmCallingAssignment.findByIdAndDelete(id);
      }

      return res.json({
        success: true,
        message: `Calling sheet "${sheetName}" deleted permanently from all ${deletedCount} RM assignment(s)`,
        deletedId: id,
        deletedCount,
      });
    } catch (err) {
      console.error("Failed to delete calling assignment:", err);
      return res.status(500).json({ message: err.message || "Failed to delete calling assignment" });
    }
  }
);

// DELETE /api/calls/assignments/:id/contact/:phone — Remove a contact lead from ALL assignments everywhere
router.delete(
  "/assignments/:id/contact/:phone",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.ASM),
  async (req, res) => {
    try {
      const { id, phone } = req.params;
      const { fromAll = "true" } = req.query;

      const assignment = await RmCallingAssignment.findById(id);
      if (!assignment) {
        return res.status(404).json({ message: "Calling assignment not found" });
      }

      let removedAssignmentsCount = 1;
      if (fromAll === "true" || fromAll === true) {
        // Remove contact phone from ALL assignments across ALL RMs
        const affectedAssignments = await RmCallingAssignment.find({ "contacts.phone": phone });
        removedAssignmentsCount = affectedAssignments.length;
        for (const a of affectedAssignments) {
          a.contacts = a.contacts.filter((c) => c.phone !== phone);
          const total = a.contacts.length;
          const called = a.contacts.filter((c) => c.status && c.status !== "PENDING").length;
          const connected = a.contacts.filter((c) => c.status === "CONNECTED").length;
          a.stats = a.stats || {};
          a.stats.total = total;
          a.stats.called = called;
          a.stats.connected = connected;
          a.stats.pending = Math.max(0, total - called);
          a.stats.totalTalkTimeSeconds = a.contacts.reduce((acc, c) => acc + (c.lastCallDuration || 0), 0);
          await a.save();
        }
      } else {
        assignment.contacts = assignment.contacts.filter((c) => c.phone !== phone);
        const total = assignment.contacts.length;
        const called = assignment.contacts.filter((c) => c.status && c.status !== "PENDING").length;
        const connected = assignment.contacts.filter((c) => c.status === "CONNECTED").length;
        assignment.stats = assignment.stats || {};
        assignment.stats.total = total;
        assignment.stats.called = called;
        assignment.stats.connected = connected;
        assignment.stats.pending = Math.max(0, total - called);
        assignment.stats.totalTalkTimeSeconds = assignment.contacts.reduce((acc, c) => acc + (c.lastCallDuration || 0), 0);
        await assignment.save();
      }

      return res.json({
        success: true,
        message: `Contact ${phone} removed permanently from all ${removedAssignmentsCount} RM sheet(s)`,
        phone,
        removedAssignmentsCount,
      });
    } catch (err) {
      console.error("Failed to remove contact from assignment:", err);
      return res.status(500).json({ message: err.message || "Failed to remove contact from assignment" });
    }
  }
);

// PATCH /api/calls/assignments/contact-status — Update contact status, direction, notes & duration
router.patch(
  "/assignments/contact-status",
  auth,
  requireRole(ROLES.RM, ROLES.ASM, ROLES.RSM, ROLES.ADMIN, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { assignmentId, contactPhone, status, notes, callType = "OUTGOING", durationSeconds = 0 } = req.body;
      const cleanPhone = normalizePhoneToTen(contactPhone) || String(contactPhone || "").trim();
      const rmId = req.user?.sub || req.user?._id;
      const dur = Math.max(0, parseInt(durationSeconds, 10) || 0);
      const isConnected = ["CONNECTED", "INTERESTED", "DOCUMENTS_PENDING"].includes(status);
      const finalDuration = dur > 0 ? dur : (isConnected ? 60 : 0);

      let rmName = `${req.user?.firstName || ""} ${req.user?.lastName || ""}`.trim() || req.user?.name || "";
      if (!rmName && rmId) {
        const rmDoc = await User.findById(rmId).select("firstName lastName name").lean();
        if (rmDoc) rmName = `${rmDoc.firstName || ""} ${rmDoc.lastName || ""}`.trim() || rmDoc.name || "RM";
      }
      if (!rmName) rmName = "RM";

      let assignment = null;
      if (assignmentId && mongoose.Types.ObjectId.isValid(assignmentId)) {
        assignment = await RmCallingAssignment.findById(assignmentId);
      }

      if (!assignment) {
        // Check if there is an Application with this phone
        const app = await Application.findOne(
          activeApplicationsFilter({
            "customer.phone": cleanPhone,
          })
        );
        if (app) {
          app.leadFollowUp = {
            status: status || "CONNECTED",
            remarks: notes || "",
            lastContactedAt: new Date(),
            updatedBy: rmId,
          };
          await app.save();

          await CallLog.create({
            rmId,
            rmName,
            targetPhone: cleanPhone,
            targetName:
              [app.customer?.firstName, app.customer?.lastName].filter(Boolean).join(" ") ||
              app.customer?.name ||
              "Customer",
            contactType: "customer",
            callType: ["INCOMING", "OUTGOING", "MISSED"].includes(callType) ? callType : "OUTGOING",
            callStartTime: new Date(),
            durationSeconds: finalDuration,
            isVerifiedRealCall: isConnected || finalDuration > 0,
            notes: notes || "",
            source: "web_crm",
            applicationId: app._id,
          }).catch((e) => console.warn("Auto CallLog sync error:", e?.message));

          return res.json({
            success: true,
            message: "Application lead follow-up updated",
            contact: { phone: cleanPhone, status, notes },
          });
        }
        return res.status(404).json({ message: "Assignment not found" });
      }

      const contact = assignment.contacts.find((c) => normalizePhoneToTen(c.phone) === cleanPhone || c.phone === contactPhone);
      if (!contact) return res.status(404).json({ message: "Contact not found in sheet" });

      if (status) contact.status = status;
      if (notes !== undefined) contact.notes = notes;
      contact.lastCallType = ["INCOMING", "OUTGOING", "MISSED"].includes(callType) ? callType : "OUTGOING";
      contact.lastCallDuration = finalDuration;
      contact.lastCallTime = new Date();
      contact.callCount = (contact.callCount || 0) + 1;
      contact.isVerified = isConnected || finalDuration > 0;

      const total = assignment.contacts.length;
      const called = assignment.contacts.filter((c) => c.status && c.status !== "PENDING").length;
      const connected = assignment.contacts.filter((c) =>
        ["CONNECTED", "INTERESTED", "DOCUMENTS_PENDING"].includes(c.status)
      ).length;
      const pending = total - called;
      const totalTalkTime = assignment.contacts.reduce((acc, c) => acc + (c.lastCallDuration || 0), 0);

      assignment.stats = assignment.stats || {};
      assignment.stats.total = total;
      assignment.stats.called = called;
      assignment.stats.connected = connected;
      assignment.stats.pending = pending;
      assignment.stats.totalTalkTimeSeconds = totalTalkTime;

      await assignment.save();

      // Sync same status to any other calling sheets or application with this phone for this RM
      await RmCallingAssignment.updateMany(
        { _id: { $ne: assignment._id }, rmId: assignment.rmId, "contacts.phone": cleanPhone },
        {
          $set: {
            "contacts.$.status": contact.status,
            "contacts.$.notes": contact.notes,
            "contacts.$.lastCallTime": contact.lastCallTime,
            "contacts.$.lastCallDuration": contact.lastCallDuration,
            "contacts.$.lastCallType": contact.lastCallType,
            "contacts.$.isVerified": contact.isVerified,
          },
        }
      ).catch(() => {});

      await Application.updateMany(
        activeApplicationsFilter({ "customer.phone": cleanPhone, rmId: assignment.rmId }),
        {
          $set: {
            "leadFollowUp.status": contact.status,
            "leadFollowUp.remarks": contact.notes,
            "leadFollowUp.lastContactedAt": contact.lastCallTime,
            "leadFollowUp.updatedBy": rmId,
          },
        }
      ).catch(() => {});

      // Automatically log CallLog entry for live audit & target tracking
      if (status && status !== "PENDING") {
        await CallLog.create({
          rmId: rmId || assignment.rmId,
          rmName,
          targetPhone: cleanPhone,
          targetName: contact.name || "Customer",
          contactType: contact.contactType || "customer",
          callType: contact.lastCallType,
          callStartTime: new Date(),
          durationSeconds: finalDuration,
          isVerifiedRealCall: isConnected || finalDuration > 0,
          notes: notes || "",
          source: "web_crm",
        }).catch((e) => console.warn("Auto CallLog sync error:", e?.message));
      }

      return res.json({ success: true, message: "Contact status updated", contact });
    } catch (err) {
      console.error("Failed to update contact status:", err);
      return res.status(500).json({ message: err.message || "Failed to update contact status" });
    }
  }
);

// GET /api/calls/admin-logs — Admin / RSM / RM view of calls with stats & filters
router.get(
  "/admin-logs",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.ASM, ROLES.RM),
  async (req, res) => {
    try {
      const {
        rmId,
        callType,
        verifiedOnly,
        contactType,
        search,
        startDate,
        endDate,
        page = 1,
        limit = 50,
      } = req.query;

      const filter = {};

      if (req.user?.role === ROLES.RM) {
        const curRmId = req.user?.sub || req.user?._id;
        filter.rmId = curRmId;
        if (!contactType || contactType === "all") {
          const rmUser = await User.findById(curRmId).select("rmType").lean();
          if (rmUser?.rmType === "CUSTOMER") {
            filter.contactType = "customer";
          } else if (rmUser?.rmType === "PARTNER") {
            filter.contactType = "partner";
          }
        }
      } else if (rmId && rmId !== "all") {
        filter.rmId = rmId;
      }

      if (callType && callType !== "all") {
        filter.callType = callType;
      }

      if (verifiedOnly === "true") {
        filter.isVerifiedRealCall = true;
      } else if (verifiedOnly === "false") {
        filter.isVerifiedRealCall = false;
      }

      if (contactType && contactType !== "all") {
        filter.contactType = contactType;
      }

      if (startDate || endDate) {
        filter.callStartTime = {};
        if (startDate) filter.callStartTime.$gte = new Date(startDate);
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          filter.callStartTime.$lte = end;
        }
      }

      if (search && search.trim()) {
        const term = search.trim();
        filter.$or = [
          { targetPhone: { $regex: term, $options: "i" } },
          { targetName: { $regex: term, $options: "i" } },
          { rmName: { $regex: term, $options: "i" } },
        ];
      }

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const skip = (pageNum - 1) * limitNum;

      const [logs, total] = await Promise.all([
        CallLog.find(filter)
          .sort({ callStartTime: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        CallLog.countDocuments(filter),
      ]);

      const statsAgg = await CallLog.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalCalls: { $sum: 1 },
            totalDurationSeconds: { $sum: "$durationSeconds" },
            verifiedCalls: {
              $sum: { $cond: ["$isVerifiedRealCall", 1, 0] },
            },
            missedCalls: {
              $sum: { $cond: [{ $eq: ["$callType", "MISSED"] }, 1, 0] },
            },
            outgoingCalls: {
              $sum: { $cond: [{ $eq: ["$callType", "OUTGOING"] }, 1, 0] },
            },
            incomingCalls: {
              $sum: { $cond: [{ $eq: ["$callType", "INCOMING"] }, 1, 0] },
            },
          },
        },
      ]);

      const stats = statsAgg[0] || {
        totalCalls: total,
        totalDurationSeconds: 0,
        verifiedCalls: 0,
        missedCalls: 0,
        outgoingCalls: 0,
        incomingCalls: 0,
      };

      return res.json({
        success: true,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum) || 1,
        stats: {
          totalCalls: stats.totalCalls || 0,
          totalDurationMinutes: Math.round((stats.totalDurationSeconds || 0) / 60),
          verifiedCalls: stats.verifiedCalls || 0,
          missedCalls: stats.missedCalls || 0,
          outgoingCalls: stats.outgoingCalls || 0,
          incomingCalls: stats.incomingCalls || 0,
        },
        logs,
      });
    } catch (err) {
      console.error("Failed to fetch admin call logs:", err);
      return res.status(500).json({ message: err.message || "Failed to fetch call logs" });
    }
  }
);

// GET /api/calls/rm-history — RM view of their own recent calls
router.get(
  "/rm-history",
  auth,
  requireRole(ROLES.RM, ROLES.ASM, ROLES.RSM, ROLES.ADMIN, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const rmId = req.user?.sub || req.user?._id;
      const { limit = 30 } = req.query;

      const logs = await CallLog.find({ rmId })
        .sort({ callStartTime: -1 })
        .limit(Math.min(100, parseInt(limit, 10) || 30))
        .lean();

      return res.json({ success: true, logs });
    } catch (err) {
      console.error("Failed to fetch RM call history:", err);
      return res.status(500).json({ message: err.message || "Failed to fetch call history" });
    }
  }
);

export default router;
