import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { CallLog } from "../models/CallLog.js";
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";
import { RmCallingAssignment } from "../models/RmCallingAssignment.js";
import { normalizePhoneToTen } from "../utils/phoneNormalize.js";
import { activeUsersFilter } from "../utils/activeUsersFilter.js";
import { activeApplicationsFilter } from "../utils/activeApplicationsFilter.js";

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

      // Auto-update assigned calling sheet for this RM if contact exists in sheet
      try {
        const activeAssignment = await RmCallingAssignment.findOne({
          rmId: rmUser._id,
          "contacts.phone": cleanPhone,
        });

        if (activeAssignment) {
          let contactUpdated = false;

          for (const c of activeAssignment.contacts) {
            if (c.phone === cleanPhone) {
              c.callCount = (c.callCount || 0) + 1;
              c.lastCallTime = new Date();
              c.lastCallDuration = duration;
              c.lastCallType = callType;
              c.isVerified = isVerifiedRealCall;

              if (isVerifiedRealCall) {
                c.status = "CONNECTED";
              } else if (callType === "MISSED") {
                c.status = "CALL_BACK";
              } else if (c.status === "PENDING") {
                c.status = "UNANSWERED";
              }

              contactUpdated = true;
              break;
            }
          }

          if (contactUpdated) {
            const total = activeAssignment.contacts.length;
            const called = activeAssignment.contacts.filter((c) => c.status !== "PENDING").length;
            const connected = activeAssignment.contacts.filter((c) => c.status === "CONNECTED").length;
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
          loanType: item.loanType || item.metaLoanType || "",
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

// GET /api/calls/assignments/admin-overview — Daily target tracking across all RMs
router.get(
  "/assignments/admin-overview",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.ASM),
  async (req, res) => {
    try {
      const { date = new Date().toISOString().slice(0, 10) } = req.query;

      const assignments = await RmCallingAssignment.find({ date })
        .sort({ createdAt: -1 })
        .lean();

      const rms = await User.find(activeUsersFilter({ role: "rm" }))
        .select("firstName lastName name employeeId phone rmType branchName franchiseType")
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

// GET /api/calls/assignments/rm-sheet — Fetch RM's calling sheet for today
router.get(
  "/assignments/rm-sheet",
  auth,
  requireRole(ROLES.RM, ROLES.ASM, ROLES.RSM, ROLES.ADMIN, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const rmId = req.query.rmId || req.user._id;
      const { date = new Date().toISOString().slice(0, 10), assignmentType } = req.query;

      const filter = { rmId };
      if (date) filter.date = date;
      if (assignmentType && assignmentType !== "all") filter.assignmentType = assignmentType;

      const sheets = await RmCallingAssignment.find(filter)
        .sort({ createdAt: -1 })
        .lean();

      return res.json({ success: true, sheets });
    } catch (err) {
      console.error("Failed to fetch RM calling sheet:", err);
      return res.status(500).json({ message: "Failed to fetch calling sheet" });
    }
  }
);

// PATCH /api/calls/assignments/contact-status — Update contact status/notes
router.patch(
  "/assignments/contact-status",
  auth,
  requireRole(ROLES.RM, ROLES.ASM, ROLES.RSM, ROLES.ADMIN, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { assignmentId, contactPhone, status, notes } = req.body;
      const assignment = await RmCallingAssignment.findById(assignmentId);
      if (!assignment) return res.status(404).json({ message: "Assignment not found" });

      const contact = assignment.contacts.find((c) => c.phone === contactPhone);
      if (!contact) return res.status(404).json({ message: "Contact not found in sheet" });

      if (status) contact.status = status;
      if (notes !== undefined) contact.notes = notes;

      const total = assignment.contacts.length;
      const called = assignment.contacts.filter((c) => c.status !== "PENDING").length;
      const connected = assignment.contacts.filter((c) => c.status === "CONNECTED").length;
      const pending = total - called;

      assignment.stats.called = called;
      assignment.stats.connected = connected;
      assignment.stats.pending = pending;

      await assignment.save();
      return res.json({ success: true, message: "Contact status updated", contact });
    } catch (err) {
      console.error("Failed to update contact status:", err);
      return res.status(500).json({ message: "Failed to update contact status" });
    }
  }
);

// GET /api/calls/admin-logs — Admin / RSM view of all calls with stats & filters
router.get(
  "/admin-logs",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.ASM),
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

      if (rmId && rmId !== "all") {
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
      const rmId = req.user._id;
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
