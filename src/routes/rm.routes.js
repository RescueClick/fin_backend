import { Router } from "express";
import argon2 from "argon2";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { User } from "../models/User.js";
import { makePartnerCode } from "../utils/codes.js";
import {
  Application,
  APP_STATUSES,
  findUploadedDocMatchingRequired,
  canonicalDocTypeForVerification,
} from "../models/Application.js";
import { Payout } from "../models/Payout.js";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { Target } from "../models/Target.js";
import { Incentive } from "../models/Incentive.js";
import mongoose from "mongoose";
import mime from "mime-types";
import { partnerUpload } from "../middleware/profileUpload.js";
import { upload } from "../middleware/upload.js";
import {
  oversizeSingleDocViolation,
  formatOversizeMessage,
  deleteS3ObjectsForUploadedFiles,
} from "../utils/docUploadLimits.js";
import { FollowUp } from "../models/followUp.js";
import dayjs from "dayjs";
import {
  parseFollowUpPeriod,
  latestFollowUpsByTargets,
  applicationCountsByPartner,
  formatFollowUpLastCall,
  buildPartnerFollowUpSummary,
  isValidFollowUpStatus,
} from "../utils/followUpHelpers.js";
import { sendMail } from "../utils/sendMail.js";
import { createEmailChangeRequest } from "../utils/emailChangeService.js";
import { sendApplicationStatusEmail, sendDocumentStatusEmail } from "../utils/emailService.js";
import axios from "axios";
import { emitDocumentStatusChanged, emitApplicationStatusChanged } from "../utils/socketEmitter.js";
import { getReferralWebBaseUrl, appendPartnerShareUtm } from "../config/branding.js";
import { PARTNER_REGISTRATION_PATH_SEGMENT } from "../constants/publicReferral.js";
import {
  buildReassignableApplicationFilter,
  buildReassignmentAudit,
  REASSIGNABLE_PAYOUT_STATUS,
  REASSIGNABLE_INCENTIVE_STATUS,
  LOCKED_PAYOUT_STATUS,
  LOCKED_INCENTIVE_STATUS,
} from "../utils/reassignmentPolicy.js";
import { persistReassignmentAudit } from "../utils/reassignmentAuditService.js";
import {
  deriveCurrentTargetContext,
  rebalanceHierarchyTargetsReplace,
} from "../utils/targetRebalanceService.js";

const router = Router();

/**
 * Assign RSM/asm when moving to DOC_COMPLETE (same rules as POST /applications/:id/transition).
 * Mutates app.rsmId and app.asmId.
 */
async function assignRsmForDocComplete(app, rmId) {
  const rm = await User.findById(rmId).select("personalRsmId businessHomeRsmId");
  if (!rm) {
    return { ok: false, statusCode: 404, message: "RM not found" };
  }

  let targetRsmId = null;
  if (app.loanType === "PERSONAL") {
    targetRsmId = rm.personalRsmId;
  } else if (
    app.loanType === "BUSINESS" ||
    app.loanType === "HOME_LOAN_SALARIED" ||
    app.loanType === "HOME_LOAN_SELF_EMPLOYED"
  ) {
    targetRsmId = rm.businessHomeRsmId;
  } else {
    return { ok: false, statusCode: 400, message: `Unknown loan type: ${app.loanType}` };
  }

  if (!targetRsmId) {
    return {
      ok: false,
      statusCode: 400,
      message: `RM is not assigned to an RSM for loan type ${app.loanType}. Please contact admin to assign RSM.`,
    };
  }

  const rsm = await User.findById(targetRsmId).select("asmId rsmType firstName lastName employeeId");
  if (!rsm) {
    return { ok: false, statusCode: 404, message: "Assigned RSM not found" };
  }

  app.rsmId = targetRsmId;
  app.asmId = rsm.asmId;
  return { ok: true };
}

/**
 * After RM updates document verification, align application status with docs (SUBMITTED/DOC_INCOMPLETE → DOC_COMPLETE when all verified; SUBMITTED → DOC_INCOMPLETE when any doc is rejected).
 */
async function syncApplicationStatusAfterDocUpdate(app, rmId) {
  const oldStatus = app.status;

  if (!(app.status === "SUBMITTED" || app.status === "DOC_INCOMPLETE")) {
    return { statusChanged: false, oldStatus, newStatus: oldStatus };
  }

  const allVerified = app.areAllDocumentsVerified();
  const anyRejected = (app.docs || []).some((d) => d.status === "REJECTED");

  // Disabled automatic transition to DOC_COMPLETE as per user request.
  // The RM must manually transition the application to DOC_COMPLETE.
  // if (allVerified) {
  //   if (oldStatus === "DOC_COMPLETE") {
  //     return { statusChanged: false, oldStatus, newStatus: oldStatus };
  //   }
  //   const assign = await assignRsmForDocComplete(app, rmId);
  //   if (!assign.ok) {
  //     const err = new Error(assign.message);
  //     err.statusCode = assign.statusCode;
  //     throw err;
  //   }
  //   app.transition("DOC_COMPLETE", rmId, "All required documents verified");
  //   return { statusChanged: true, oldStatus, newStatus: "DOC_COMPLETE" };
  // }

  if (anyRejected && oldStatus === "SUBMITTED") {
    app.transition("DOC_INCOMPLETE", rmId, "Document rejected — re-upload required");
    return { statusChanged: true, oldStatus, newStatus: "DOC_INCOMPLETE" };
  }

  return { statusChanged: false, oldStatus, newStatus: oldStatus };
}

async function maybeEmitApplicationStatusAfterDocWorkflow(io, app, workflowMeta, actionBy) {
  if (!workflowMeta?.statusChanged || !io) return;
  try {
    await app.populate("partnerId", "firstName lastName email employeeId");
    await app.populate("customerId", "firstName middleName lastName email phone");
    await app.populate("rmId", "firstName lastName email employeeId asmId");
    await app.populate("asmId", "firstName lastName email employeeId");
    await emitApplicationStatusChanged(
      io,
      app,
      workflowMeta.oldStatus,
      workflowMeta.newStatus,
      actionBy
    );
  } catch (e) {
    console.error("Error emitting application status after doc update:", e);
  }
}

// Log route registration for debugging
console.log("✅ RM routes loaded - POST /applications/:id/docs/:docType/update-status route registered");

router.post(
  "/create-partners",
  auth,
  requireRole(ROLES.RM),
  upload.any(), // Accept any file field name
  async (req, res) => {
    try {
      // Parse partner details from JSON
      const partnerData = JSON.parse(req.body.newFormData || "{}");

      const {
        firstName,
        middleName,
        lastName,
        phone,
        dob,
        joinDate,
        email,
        region,
        aadharNumber,
        panNumber,
        pincode,
        employmentType,
        address,
        homeType,
        addressStability,
        landmark,
        bankName,
        accountNumber,
        ifscCode,
        password,
      } = partnerData;

      // Required fields validation
      if (!firstName || !lastName || !phone || !email) {
        return res.status(400).json({
          message: "firstName, lastName, phone, and email are required",
        });
      }

      // Check if email or phone already exists
      const normalizedEmail = String(email).toLowerCase();
      const exists = await User.findOne({
        $or: [{ email: normalizedEmail }, { phone }],
      })
        .select("email phone")
        .lean();

      if (exists) {
        const emailTaken = String(exists.email || "").toLowerCase() === normalizedEmail;
        const phoneTaken = String(exists.phone || "") === String(phone || "");

        const field = emailTaken && phoneTaken ? "email,phone" : emailTaken ? "email" : "phone";
        const message =
          emailTaken && phoneTaken
            ? "Email and phone number already in use"
            : emailTaken
            ? "Email already in use"
            : "Phone number already in use";

        return res.status(409).json({ message, field });
      }

      const rawPassword =
        password || `Pt@${Math.random().toString(36).slice(2, 10)}`;

      // Map uploaded files into docs array dynamically
      let docs = [];
      if (req.files) {
        req.files.forEach((file) => {
          if (!file.location) {
            throw new Error("S3 upload failed: missing file location");
          }
          docs.push({
            docType: file.fieldname.toUpperCase(),
            url: file.location,
            uploadedBy: req.user.sub,
            status: "PENDING",
          });
        });
      }

      // Create partner
      const partner = await User.create({
        _id: new mongoose.Types.ObjectId(),
        employeeId: await generateEmployeeId("PARTNER"),
        firstName,
        middleName,
        lastName,
        phone,
        dob,
        email: email.toLowerCase(),
        aadharNumber,
        panNumber,
        region,
        pincode,
        employmentType,
        address,
        homeType,
        addressStability,
        landmark,
        bankName,
        accountNumber,
        ifscCode,
        passwordHash: await argon2.hash(rawPassword),
        role: ROLES.PARTNER,
        partnerCode: makePartnerCode(),
        rmId: req.user.sub,
        joinDate: joinDate ? new Date(joinDate) : new Date(),
        status: "ACTIVE",
        docs,
      });

      // 📧 Send mail to partner after creation
      try {
        await sendMail({
          to: partner.email,
          subject: "Your Partner Account Has Been Created",
          html: `
            <p>Dear ${partner.firstName} ${partner.lastName},</p>
            <p>Your Partner account has been successfully created by your RM.</p>
            <p><b>Employee ID:</b> ${partner.employeeId}<br/>
               <b>Partner Code:</b> ${partner.partnerCode}<br/>
               <b>Email:</b> ${partner.email}<br/>
               <b>Temporary Password:</b> ${
                 password ? "Set by you" : rawPassword
               }</p>
            <p>Please log in and change your password immediately.</p>
            <br/>
            <p>Regards,<br/>DhanSource Capital</p>
          `,
        });
        console.log("📧 Partner creation mail sent to:", partner.email);
      } catch (mailErr) {
        console.error(
          "❌ Failed to send partner creation email:",
          mailErr.message
        );
      }

      // Auto-rebalance hierarchy for current period if targets already exist
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const context = await deriveCurrentTargetContext(month, year);
      if (Number(context.totalCompanyTarget) > 0) {
        await rebalanceHierarchyTargetsReplace({
          month,
          year,
          totalCompanyTarget: context.totalCompanyTarget,
          partnerFileCountTarget: context.partnerFileCountTarget,
          assignedBy: context.assignedBy || req.user.sub,
        });
      }

      res.status(201).json({
        message: "Partner created successfully and targets redistributed",
        id: partner._id,
        partnerCode: partner.partnerCode,
        rmId: partner.rmId,
        tempPassword: password ? undefined : rawPassword,
        docs,
      });
    } catch (err) {
      console.error("Error creating partner:", err);
      if (err?.code === 11000) {
        const keyValue = err.keyValue || {};
        const key =
          Object.keys(keyValue)[0] ||
          (err.keyPattern ? Object.keys(err.keyPattern)[0] : null);
        const keyLower = String(key || "").toLowerCase();

        const field =
          keyLower.includes("email")
            ? "email"
            : keyLower.includes("phone") || keyLower.includes("mobile")
            ? "phone"
            : undefined;

        const message =
          field === "email"
            ? "Email already in use"
            : field === "phone"
            ? "Phone number already in use"
            : "Already exists";

        return res.status(409).json({ message, field });
      }

      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

router.get("/get-partners", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub;

    const partners = await User.find({
      role: ROLES.PARTNER,
      rmId,
      status: { $ne: "PENDING" },
    })
      .select("-passwordHash")
      .lean();

    if (partners.length === 0) {
      return res.json([]);
    }

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const monthStart = new Date(currentYear, currentMonth - 1, 1);
    const monthEnd = new Date(currentYear, currentMonth, 1);

    const BASE_URL = process.env.BACKEND_URL || "http://localhost:5000";
    const partnerIds = partners.map((p) => p._id);

    const rm = await User.findById(rmId).select("firstName lastName asmId").lean();
    const asm = rm?.asmId
      ? await User.findById(rm.asmId).select("firstName lastName").lean()
      : null;

    const [
      payoutByPartner,
      incentiveByPartner,
      disbursedLifetimeByPartner,
      disbursedThisMonthByPartner,
      appTotalsByPartner,
      approvedCountByPartner,
      monthlyTargets,
    ] = await Promise.all([
      Payout.aggregate([
        { $match: { partnerId: { $in: partnerIds } } },
        {
          $group: {
            _id: "$partnerId",
            totalAll: { $sum: "$amount" },
            payoutDone: {
              $sum: {
                $cond: [{ $eq: ["$payOutStatus", "DONE"] }, "$amount", 0],
              },
            },
            payoutPending: {
              $sum: {
                $cond: [{ $eq: ["$payOutStatus", "PENDING"] }, "$amount", 0],
              },
            },
          },
        },
      ]),
      Incentive.aggregate([
        { $match: { partnerId: { $in: partnerIds } } },
        {
          $group: {
            _id: "$partnerId",
            incentiveTotal: { $sum: "$amount" },
            incentivePaid: {
              $sum: { $cond: [{ $eq: ["$status", "PAID"] }, "$amount", 0] },
            },
            incentivePending: {
              $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, "$amount", 0] },
            },
          },
        },
      ]),
      Application.aggregate([
        {
          $match: {
            partnerId: { $in: partnerIds },
            status: "DISBURSED",
          },
        },
        {
          $group: {
            _id: "$partnerId",
            totalDisbursed: { $sum: { $toDouble: "$approvedLoanAmount" } },
            disbursedFiles: { $sum: 1 },
          },
        },
      ]),
      Application.aggregate([
        {
          $match: {
            partnerId: { $in: partnerIds },
            status: "DISBURSED",
            updatedAt: { $gte: monthStart, $lt: monthEnd },
          },
        },
        {
          $group: {
            _id: "$partnerId",
            achievedDisbursementMonth: {
              $sum: { $toDouble: "$approvedLoanAmount" },
            },
            achievedFileCountMonth: { $sum: 1 },
          },
        },
      ]),
      Application.aggregate([
        { $match: { partnerId: { $in: partnerIds } } },
        { $group: { _id: "$partnerId", total: { $sum: 1 } } },
      ]),
      Application.aggregate([
        {
          $match: {
            partnerId: { $in: partnerIds },
            status: "APPROVED",
          },
        },
        { $group: { _id: "$partnerId", total: { $sum: 1 } } },
      ]),
      Target.find({
        assignedTo: { $in: partnerIds },
        role: ROLES.PARTNER,
        month: currentMonth,
        year: currentYear,
      }).lean(),
    ]);

    const payoutMap = Object.fromEntries(
      payoutByPartner.map((r) => [String(r._id), r])
    );
    const incentiveMap = Object.fromEntries(
      incentiveByPartner.map((r) => [String(r._id), r])
    );
    const lifetimeMap = Object.fromEntries(
      disbursedLifetimeByPartner.map((r) => [String(r._id), r])
    );
    const monthAchMap = Object.fromEntries(
      disbursedThisMonthByPartner.map((r) => [String(r._id), r])
    );
    const totalAppsMap = Object.fromEntries(
      appTotalsByPartner.map((r) => [String(r._id), r.total])
    );
    const approvedMap = Object.fromEntries(
      approvedCountByPartner.map((r) => [String(r._id), r.total])
    );
    const targetByPartnerId = Object.fromEntries(
      monthlyTargets.map((t) => [String(t.assignedTo), t])
    );

    const partnerData = partners.map((partner) => {
      const pid = String(partner._id);
      const pPay = payoutMap[pid] || {};
      const pInc = incentiveMap[pid] || {};
      const life = lifetimeMap[pid] || {};
      const monthAch = monthAchMap[pid] || {};
      const targetDoc = targetByPartnerId[pid];

      const totalDisbursed = life.totalDisbursed || 0;
      const totalApplications = totalAppsMap[pid] || 0;
      const approvedCount = approvedMap[pid] || 0;
      const successRate =
        totalApplications > 0
          ? Math.round((approvedCount / totalApplications) * 100)
          : 0;

      const fileCountTarget = targetDoc?.fileCountTarget ?? 4;
      const disbursementTarget =
        targetDoc?.disbursementTarget ??
        targetDoc?.targetValue ??
        2000000;
      const assignedTarget = targetDoc
        ? Number(targetDoc.targetValue ?? disbursementTarget)
        : 0;

      const achievedFileCountMonth = monthAch.achievedFileCountMonth || 0;
      const achievedDisbursementMonth =
        monthAch.achievedDisbursementMonth || 0;

      const disbursementPerfPct =
        disbursementTarget > 0
          ? Math.min(
              100,
              (achievedDisbursementMonth / disbursementTarget) * 100
            ).toFixed(2)
          : "0.00";
      const filePerfPct =
        fileCountTarget > 0
          ? Math.min(
              100,
              (achievedFileCountMonth / fileCountTarget) * 100
            ).toFixed(2)
          : "0.00";
      const performanceAvg = (
        (parseFloat(disbursementPerfPct) + parseFloat(filePerfPct)) /
        2
      ).toFixed(2);

      const selfieDoc = (partner.docs || []).find(
        (doc) => doc.docType === "SELFIE"
      );
      let profilePicUrl = null;
      if (selfieDoc?.url) {
        if (
          selfieDoc.url.startsWith("http://") ||
          selfieDoc.url.startsWith("https://")
        ) {
          profilePicUrl = selfieDoc.url;
        } else {
          const cleanPath = selfieDoc.url
            .replace(/\\/g, "/")
            .replace(/^\/+/, "");
          profilePicUrl = `${BASE_URL.replace(/\/$/, "")}/${cleanPath}`;
        }
      }

      const payoutDone = pPay.payoutDone || 0;
      const payoutPendingAmount = pPay.payoutPending || 0;
      const revenueGenerated = pPay.totalAll || 0;

      return {
        id: partner._id,
        rmId: partner.rmId,
        rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,
        asmId: asm?._id || null,
        asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
        name: `${partner.firstName} ${partner.lastName}`,
        email: partner.email,
        phone: partner.phone,
        region: partner.region || null,
        employeeId: partner.employeeId || null,
        createdAt: partner.createdAt || null,
        status: partner.status,
        rating: partner.rating || 0,

        // Payout (loan partner commission)
        totalPayout: payoutDone,
        payoutDone,
        payoutPending: payoutPendingAmount,
        payoutTotalRecorded: revenueGenerated,

        // Incentive (monthly target–based bonus — see Incentive model)
        incentivePaid: pInc.incentivePaid || 0,
        incentivePending: pInc.incentivePending || 0,
        incentiveTotal: pInc.incentiveTotal || 0,

        // Lifetime disbursed book
        totalDisbursed,
        disbursedFilesLifetime: life.disbursedFiles || 0,

        // Current month achievement vs Target (same rules as GET /partners/targets)
        period: { month: currentMonth, year: currentYear },
        fileCountTarget,
        disbursementTarget,
        achievedFileCountMonth,
        achievedDisbursementMonth,
        fileTargetMet: achievedFileCountMonth >= fileCountTarget,
        disbursementTargetMet:
          achievedDisbursementMonth >= disbursementTarget,
        targetAchieved:
          achievedFileCountMonth >= fileCountTarget &&
          achievedDisbursementMonth >= disbursementTarget,

        performance: `${performanceAvg}%`,
        performanceDisbursement: `${disbursementPerfPct}%`,
        performanceFiles: `${filePerfPct}%`,

        // Legacy / UI aliases
        assignedTarget,
        dealsThisMonth: achievedFileCountMonth,
        dealsClosedThisMonth: achievedFileCountMonth,
        revenueGenerated,
        successRate,

        lastActive: partner.lastLoginAt,
        profilePic: profilePicUrl,
      };
    });

    res.json(partnerData);
  } catch (err) {
    console.error("Error fetching partners list:", err);
    res.status(500).json({ message: "Error fetching partners list" });
  }
});

// ==================== PARTNER MANAGEMENT (RM) ====================

// DELETE /api/rm/partners/:partnerId
// RM can soft-delete (deactivate) a partner under them
router.delete(
  "/partners/:partnerId",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub;
      const { partnerId } = req.params;

      // Ensure this partner belongs to the logged-in RM
      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
        rmId,
      });

      if (!partner) {
        return res.status(404).json({
          message: "Partner not found or not under this RM",
        });
      }

      // Soft delete: mark suspended and set deletedAt
      partner.status = "SUSPENDED";
      partner.deletedAt = new Date();

      // Optionally also detach from RM
      partner.rmId = null;

      await partner.save();

      return res.json({
        message: "Partner deleted successfully from this RM",
        partnerId: partner._id,
      });
    } catch (err) {
      console.error("Error deleting partner from RM:", err);
      return res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

router.get(
  "/partner/:partnerId/customers",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub; // RM from token
      const { partnerId } = req.params;

      // 1. Verify that this Partner belongs to this RM
      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
        rmId,
      })
        .select("firstName lastName email phone employeeId")
        .lean();

      if (!partner) {
        return res
          .status(404)
          .json({ message: "Partner not found under this RM" });
      }

      // 2. Fetch Customers under this Partner
      const customers = await User.find({ role: ROLES.CUSTOMER, partnerId })
        .select("-passwordHash -__v")
        .lean();

      // 3. Prepare single object response
      const response = {
        partnerId: partner._id,
        partnerName: `${partner.firstName} ${partner.lastName}`,
        partnerEmployeeId: partner.employeeId,
        partnerEmail: partner.email,
        partnerPhone: partner.phone,
        totalCustomers: customers.length,
        customers: customers.map((cust) => ({
          id: cust._id,
          name: `${cust.firstName} ${cust.lastName}`,
          email: cust.email,
          phone: cust.phone,
          status: cust.status,
          createdAt: cust.createdAt,
          updatedAt: cust.updatedAt,
        })),
      };

      res.json(response);
    } catch (err) {
      console.error("Error fetching customers under Partner:", err);
      res.status(500).json({ message: "Error fetching Partner's customers" });
    }
  }
);

router.get(
  "/partners-with-followup",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub;
      const period = parseFollowUpPeriod(req.query);
      const statusFilter = String(req.query.status || "").trim();
      const performanceFilter = String(req.query.performance || "").trim(); // working | non_working | filled | not_filled

      const partners = await User.find({
        role: ROLES.PARTNER,
        rmId,
        status: { $ne: "PENDING" },
      })
        .select("employeeId firstName lastName phone email status partnerCode")
        .lean();

      const partnerIds = partners.map((p) => p._id);
      const [followMap, appCounts] = await Promise.all([
        latestFollowUpsByTargets({
          targetIds: partnerIds,
          followUpType: "PARTNER",
          period,
          partnerIdMode: true,
        }),
        applicationCountsByPartner(partnerIds, period),
      ]);

      let items = partners.map((partner) => {
        const pid = String(partner._id);
        const lastFollowUp = followMap.get(pid);
        const applicationCount = appCounts.get(pid) || 0;
        const hasFilledForm = applicationCount > 0;
        const performance = hasFilledForm ? "working" : "non_working";

        return {
          employeeId: partner?.employeeId,
          partnerId: partner._id,
          partnerCode: partner.partnerCode || null,
          name: `${partner.firstName || ""} ${partner.lastName || ""}`.trim(),
          phone: partner.phone,
          email: partner.email,
          accountStatus: partner.status,
          status: lastFollowUp?.status || "N/A",
          remarks: lastFollowUp?.remarks || "",
          lastCall: formatFollowUpLastCall(lastFollowUp?.lastCall),
          lastCallRaw: lastFollowUp?.lastCall || null,
          applicationCount,
          hasFilledForm,
          performance,
        };
      });

      if (statusFilter && statusFilter !== "N/A") {
        items = items.filter((i) => i.status === statusFilter);
      } else if (statusFilter === "N/A") {
        items = items.filter((i) => i.status === "N/A");
      }

      if (performanceFilter === "working" || performanceFilter === "filled") {
        items = items.filter((i) => i.hasFilledForm);
      } else if (
        performanceFilter === "non_working" ||
        performanceFilter === "not_filled"
      ) {
        items = items.filter((i) => !i.hasFilledForm);
      }

      const summary = buildPartnerFollowUpSummary(items);

      res.json({
        period: period
          ? { start: period.start, end: period.end, label: period.label }
          : null,
        summary,
        items,
        // backward compatible flat list for older clients
        data: items,
      });
    } catch (err) {
      console.error("Error fetching partner follow-ups:", err);
      res.status(500).json({ message: "Error fetching partner follow-ups" });
    }
  }
);

router.post(
  "/update-followup/:partnerId",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub;
      const { partnerId } = req.params;
      const { status, remarks, lastCall } = req.body;

      if (!isValidFollowUpStatus(status)) {
        return res.status(400).json({
          message: "Valid status is required (Connected, Ringing, Switch Off, Not Reachable)",
        });
      }

      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
        rmId,
      }).select("_id");
      if (!partner) {
        return res.status(404).json({
          message: "Partner not found or not assigned to this RM",
        });
      }

      let parsedDate = new Date();
      if (lastCall) {
        const parsed = dayjs(lastCall, "DD MMM YYYY, hh:mm a");
        parsedDate = parsed.isValid() ? parsed.toDate() : new Date(lastCall);
        if (Number.isNaN(parsedDate.getTime())) parsedDate = new Date();
      }

      const followUp = new FollowUp({
        partnerId,
        targetId: partnerId,
        followUpType: "PARTNER",
        status,
        remarks: remarks || "",
        lastCall: parsedDate,
        updatedBy: rmId,
      });

      await followUp.save();

      res.json({
        message: "Follow-up updated successfully",
        followUp: {
          ...followUp.toObject(),
          lastCall: formatFollowUpLastCall(followUp.lastCall),
        },
      });
    } catch (err) {
      console.error("Error updating follow-up:", err);
      res.status(500).json({ message: "Error updating follow-up" });
    }
  }
);

// GET /rm/top-performer  get top performer
router.get("/top-performer", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub;

    const topPartner = await Payout.aggregate([
      { $match: { rmId } },
      { $group: { _id: "$partnerId", totalRevenue: { $sum: "$amount" } } },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 },
    ]);

    if (!topPartner.length) {
      return res.json({ message: "No top performer yet" });
    }

    const partner = await User.findById(topPartner[0]._id).select(
      "firstName lastName email rating"
    );
    res.json({
      id: partner._id,
      name: `${partner.firstName} ${partner.lastName}`,
      rating: partner.rating,
      revenue: topPartner[0].totalRevenue,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching top performer" });
  }
});

router.post(
  "/applications/:id/transition",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const { to, note } = req.body;

      if (!to)
        return res.status(400).json({ message: "Target status 'to' required" });

      // ✅ RM can ONLY handle document-related statuses (up to DOC_COMPLETE)
      const RM_ALLOWED_STATUSES = [
        "DRAFT",
        "SUBMITTED",
        "DOC_INCOMPLETE",
        "DOC_COMPLETE",
        "DOC_SUBMITTED"
      ];

      if (!RM_ALLOWED_STATUSES.includes(to)) {
        return res.status(403).json({
          message: `RM can only transition to document statuses: ${RM_ALLOWED_STATUSES.join(", ")}. Processing statuses (UNDER_REVIEW, APPROVED, etc.) are handled by RSM.`
        });
      }

      if (!APP_STATUSES.includes(to))
        return res.status(400).json({ message: "Invalid status" });

      const rmId = req.user.sub;
      
      // Get all partners under this RM
      const partners = await User.find({ rmId, role: ROLES.PARTNER }).select("_id").lean();
      const partnerIds = partners.map(p => p._id);

      // Find application either directly assigned to RM or via partners
      const app = await Application.findOne({
        _id: req.params.id,
        $or: [
          { rmId: rmId }, // Direct RM assignment
          { partnerId: { $in: partnerIds } } // Applications from partners under this RM
        ]
      }).populate("customerId");

      if (!app)
        return res
          .status(404)
          .json({ message: "Application not found under this RM" });

      // ✅ CRITICAL: If application has rsmId set (transferred to RSM), RM CANNOT change status at all
      // Once DOC_COMPLETE is set and rsmId is assigned, the application belongs to RSM
      if (app.rsmId) {
        return res.status(403).json({
          message: "This application has been transferred to RSM and can no longer be modified by RM. Once documents are complete, only RSM can handle status changes."
        });
      }

      // ✅ Also prevent changing FROM DOC_COMPLETE if somehow rsmId wasn't set (shouldn't happen, but safety check)
      if (app.status === "DOC_COMPLETE" && to !== "DOC_COMPLETE") {
        return res.status(403).json({
          message: "Cannot change status from DOC_COMPLETE. Once documents are complete, the application is transferred to RSM for processing."
        });
      }

      // ✅ Validate DOC_COMPLETE transition - all documents must be verified
      if (to === "DOC_COMPLETE") {
        const requiredDocTypes = app.getRequiredDocTypes();
        const uploadedDocs = app.docs || [];
        const missingDocs = [];
        const unverifiedDocsSet = new Set();
        
        // Check for missing or unverified documents (alias-aware: BANK_STATEMENT ↔ BANK_STATEMENT_1, etc.)
        for (const docType of requiredDocTypes) {
          const doc = findUploadedDocMatchingRequired(uploadedDocs, docType);

          if (!doc) {
            missingDocs.push(docType);
          } else if (doc.status !== "VERIFIED") {
            unverifiedDocsSet.add(`${docType} (${doc.status})`);
          }
        }

        const unverifiedDocs = Array.from(unverifiedDocsSet);
        
        if (missingDocs.length > 0 || unverifiedDocs.length > 0) {
          let errorMessage = "Cannot set DOC_COMPLETE status. ";
          if (missingDocs.length > 0) {
            errorMessage += `Missing documents: ${missingDocs.join(", ")}. `;
          }
          if (unverifiedDocs.length > 0) {
            errorMessage += `Unverified documents: ${unverifiedDocs.join(", ")}. `;
          }
          errorMessage += "Please verify all documents first (no PENDING/UPDATED/REJECTED allowed) or change status to DOC_INCOMPLETE.";
          
          return res.status(400).json({
            message: errorMessage,
            missingDocs,
            unverifiedDocs,
          });
        }

        // ✅ AUTO-ROUTE TO RSM based on loanType + RM's RSM mapping
        const rm = await User.findById(req.user.sub).select("personalRsmId businessHomeRsmId");
        if (!rm) {
          return res.status(404).json({ message: "RM not found" });
        }

        let targetRsmId = null;
        let targetAsmId = null;

        // Determine which RSM should handle this loan based on loanType
        if (app.loanType === "PERSONAL") {
          targetRsmId = rm.personalRsmId;
          console.log(`📋 Loan Type: PERSONAL → Routing to Personal Loan RSM: ${targetRsmId}`);
        } else if (
          app.loanType === "BUSINESS" ||
          app.loanType === "HOME_LOAN_SALARIED" ||
          app.loanType === "HOME_LOAN_SELF_EMPLOYED"
        ) {
          targetRsmId = rm.businessHomeRsmId;
          console.log(`📋 Loan Type: ${app.loanType} → Routing to Business & Home Loan RSM: ${targetRsmId}`);
        } else {
          console.error(`❌ Unknown loan type: ${app.loanType}`);
        }

        if (!targetRsmId) {
          return res.status(400).json({
            message: `RM is not assigned to an RSM for loan type ${app.loanType}. Please contact admin to assign RSM.`
          });
        }

        // Fetch RSM to get ASM link and verify RSM type matches loan type
        const rsm = await User.findById(targetRsmId).select("asmId rsmType firstName lastName employeeId");
        if (!rsm) {
          return res.status(404).json({ message: "Assigned RSM not found" });
        }

        // ✅ Verify RSM type matches loan type
        if (app.loanType === "PERSONAL" && rsm.rsmType !== "PERSONAL") {
          console.error(`⚠️ WARNING: Personal loan routed to RSM with type ${rsm.rsmType}. Expected PERSONAL.`);
        } else if (
          (app.loanType === "BUSINESS" || 
           app.loanType === "HOME_LOAN_SALARIED" || 
           app.loanType === "HOME_LOAN_SELF_EMPLOYED") &&
          rsm.rsmType !== "BUSINESS_HOME"
        ) {
          console.error(`⚠️ WARNING: ${app.loanType} loan routed to RSM with type ${rsm.rsmType}. Expected BUSINESS_HOME.`);
        }

        targetAsmId = rsm.asmId;

        // Assign RSM and ASM to application
        app.rsmId = targetRsmId;
        app.asmId = targetAsmId;

        console.log(`✅ Auto-routed application ${app.appNo} (${app.loanType}) to RSM ${rsm.firstName} ${rsm.lastName} (${rsm.employeeId}, Type: ${rsm.rsmType}) - ASM: ${targetAsmId}`);
        console.log(`   📝 Setting rsmId: ${targetRsmId} (${typeof targetRsmId}), asmId: ${targetAsmId} (${typeof targetAsmId})`);
      }

      // Store old status before transition
      const oldStatus = app.status;

      // Transition only if status is actually changing
      if (oldStatus !== to) {
        app.transition(to, req.user.sub, note);
      } else if (note) {
        // Just record the note in history without throwing transition error
        app.stageHistory.push({ from: oldStatus, to, by: req.user.sub, note });
      }

      // ✅ Save application with rsmId and asmId
      await app.save();
      
      // ✅ Verify the save was successful
      const savedApp = await Application.findById(app._id).select("rsmId asmId status loanType appNo").lean();
      console.log(`💾 Saved application ${savedApp.appNo}: rsmId=${savedApp.rsmId}, asmId=${savedApp.asmId}, status=${savedApp.status}, loanType=${savedApp.loanType}`);
      
      if (!savedApp.rsmId) {
        console.error(`❌ ERROR: Application ${savedApp.appNo} was saved but rsmId is null!`);
      }

      // Emit socket notification with action tracking
      try {
        // Use global.io which is set in index.js
        const io = global.io;
        if (io) {
          console.log("🔔 RM Route: Emitting application status change", {
            applicationId: app._id,
            oldStatus,
            newStatus: to,
            actionBy: req.user.sub,
          });

          // Populate application for socket emission (including ASM for hierarchy)
          await app.populate("partnerId", "firstName lastName email employeeId");
          await app.populate("customerId", "firstName middleName lastName email phone");
          await app.populate("rmId", "firstName lastName email employeeId asmId");
          await app.populate("asmId", "firstName lastName email employeeId");
          
          console.log("📋 Application populated:", {
            partnerId: app.partnerId?._id || app.partnerId,
            customerId: app.customerId?._id || app.customerId,
            rmId: app.rmId?._id || app.rmId,
            asmId: app.asmId?._id || app.asmId || app.rmId?.asmId,
          });
          
          // Ensure application IDs are properly extracted before emission
          // The emitApplicationStatusChanged function handles ID extraction internally
          await emitApplicationStatusChanged(
            io,
            app,
            oldStatus,
            to,
            req.user.sub // actionBy - who performed the action
          );
          
          console.log("✅ Socket emission completed");
        } else {
          console.error("❌ Socket io instance not available (global.io is null)");
        }
      } catch (socketErr) {
        console.error("❌ Error emitting socket event:", socketErr);
        console.error("Stack:", socketErr.stack);
        // Don't fail the request if socket fails
      }

      // Send response immediately (don't wait for email)
      const responseData = {
        message: "Application status updated successfully",
        status: app.status,
        allDocumentsVerified: app.areAllDocumentsVerified(),
      };

      // If DOC_COMPLETE, include routing info
      if (to === "DOC_COMPLETE" && app.rsmId) {
        responseData.rsmId = app.rsmId;
        responseData.asmId = app.asmId;
        responseData.message = "Documents completed. Application routed to RSM for processing.";
      }

      res.json(responseData);

      // 📧 Send email only for critical statuses (non-blocking)
      setImmediate(async () => {
        try {
          const shouldEmailCustomer = ["APPROVED", "REJECTED", "DISBURSED", "AGREEMENT"].includes(to);
          if (!shouldEmailCustomer) return;

          if (app.customerId && app.customerId.email) {
            const customerData = {
              firstName: app.customerId.firstName || app.customer?.firstName || "Customer",
              email: app.customerId.email,
            };
            const applicationData = {
              appNo: app.appNo,
              loanType: app.loanType,
              status: app.status,
              approvedLoanAmount: app.approvedLoanAmount,
            };
            const emailSent = await sendApplicationStatusEmail(
              customerData,
              applicationData,
              oldStatus,
              to
            );
            if (emailSent) {
              console.log(`✅ Application status email sent to: ${customerData.email}`);
            }
          }
        } catch (mailErr) {
          console.error("❌ Failed to send status email:", mailErr.message);
        }
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: e.message });
    }
  }
);

router.post(
  "/partner-deactivate",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { oldPartnerId, newPartnerId } = req.body;
      const rmId = req.user.sub;

      if (!oldPartnerId) {
        return res.status(400).json({ message: "oldPartnerId is required" });
      }

      const oldId = new mongoose.Types.ObjectId(oldPartnerId);
      let reassignedCustomers = 0;
      let reassignedApplications = 0;
      let reassignedPayouts = 0;
      let reassignedIncentives = 0;
      let preservedPayoutsDone = 0;
      let preservedIncentivesPaid = 0;
      let deactivatedPartner = null;
      let reassignmentAudit = null;

      await session.withTransaction(async () => {
        // 1️⃣ Validate old partner
        const oldPartner = await User.findById(oldId).session(session);
        if (!oldPartner || oldPartner.role !== ROLES.PARTNER) {
          throw new Error("Old partner not found or not a partner");
        }
        if (String(oldPartner.rmId) !== String(rmId)) {
          throw new Error("Partner not under your management");
        }

        if (newPartnerId) {
          const newId = new mongoose.Types.ObjectId(newPartnerId);
          const newPartner = await User.findById(newId).session(session);
          if (
            !newPartner ||
            newPartner.role !== ROLES.PARTNER ||
            String(newPartner.rmId) !== String(rmId) ||
            String(newPartner._id) === String(oldPartner._id)
          ) {
            throw new Error("Valid newPartnerId under same RM is required");
          }

          const customerUpdate = await User.updateMany(
            { role: ROLES.CUSTOMER, partnerId: oldId },
            { $set: { partnerId: newId } },
            { session }
          );
          reassignedCustomers = customerUpdate.modifiedCount || 0;

          const appUpdate = await Application.updateMany(
            buildReassignableApplicationFilter({ partnerId: oldId }),
            { $set: { partnerId: newId } },
            { session }
          );
          reassignedApplications = appUpdate.modifiedCount || 0;

          const payoutUpdate = await Payout.updateMany(
            { partnerId: oldId, payOutStatus: REASSIGNABLE_PAYOUT_STATUS },
            { $set: { partnerId: newId } },
            { session }
          );
          reassignedPayouts = payoutUpdate.modifiedCount || 0;

          const incentiveUpdate = await Incentive.updateMany(
            { partnerId: oldId, status: REASSIGNABLE_INCENTIVE_STATUS },
            { $set: { partnerId: newId } },
            { session }
          );
          reassignedIncentives = incentiveUpdate.modifiedCount || 0;
        }

        deactivatedPartner = await User.findByIdAndUpdate(
          oldId,
          { $set: { status: "SUSPENDED", updatedAt: new Date() } },
          { new: true, session }
        );

        preservedPayoutsDone = await Payout.countDocuments({
          partnerId: oldId,
          payOutStatus: LOCKED_PAYOUT_STATUS,
        }).session(session);
        preservedIncentivesPaid = await Incentive.countDocuments({
          partnerId: oldId,
          status: LOCKED_INCENTIVE_STATUS,
        }).session(session);

        reassignmentAudit = buildReassignmentAudit({
          changedBy: req.user.sub,
          oldUserId: oldPartnerId,
          newUserId: newPartnerId || null,
          action: "rm_partner_deactivate",
        });
        await persistReassignmentAudit(reassignmentAudit, req, session);
      });

      if (!deactivatedPartner) {
        return res.status(404).json({ message: "Old partner not found or not a partner" });
      }
      console.log(`Partner ${oldId} deactivated`);

      // 3️⃣ Send email
      try {
        await sendMail({
          to: deactivatedPartner.email,
          subject: "Your Partner Account Has Been Deactivated",
          html: `
          <p>Dear ${deactivatedPartner.firstName} ${deactivatedPartner.lastName},</p>
          <p>Your Partner account has been <b>deactivated</b>.</p>
          <p>If you believe this is an error, contact support immediately.</p>
        `,
        });
        console.log("Deactivation email sent");
      } catch (err) {
        console.error("Failed to send email:", err.message);
      }

      return res.json({
        message: `Partner ${deactivatedPartner.firstName} ${deactivatedPartner.lastName} has been deactivated. Active workload moved, settled finance/history preserved.`,
        reassignmentAudit,
      });
    } catch (error) {
      if (error.message === "Old partner not found or not a partner") {
        return res.status(404).json({ message: error.message });
      }
      if (
        error.message === "Partner not under your management" ||
        error.message === "Valid newPartnerId under same RM is required"
      ) {
        return res.status(error.message.includes("under your management") ? 403 : 400).json({ message: error.message });
      }
      console.error("Error in /deactivate-partner:", error);
      res
        .status(500)
        .json({ message: "Internal server error", error: error.message });
    } finally {
      await session.endSession();
    }
  }
);

router.post("/partner-activate", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const { partnerId } = req.body;
    const rmId = req.user.sub;

    if (!partnerId) {
      return res.status(400).json({ message: "partnerId is required" });
    }

    // Activate partner and get updated document
    const partner = await User.findOneAndUpdate(
      { _id: partnerId, rmId, role: ROLES.PARTNER },
      { status: "ACTIVE" },
      { new: true }
    );

    if (!partner) {
      return res.status(404).json({ message: "Partner not found" });
    }

    // 📧 Send activation email
    try {
      await sendMail({
        to: partner.email,
        subject: "Your Partner Account Has Been Activated",
        html: `
          <p>Dear ${partner.firstName} ${partner.lastName},</p>
          <p>We are pleased to inform you that your Partner account has been <b>activated</b> successfully.</p>
          <p><b>Partner ID:</b> ${partner.partnerCode || "-"}</p>
          <p>You can now log in and continue managing your Customers as usual.</p>
          <br/>
          <p>Regards,<br/>DhanSource Capital</p>
        `,
      });
      console.log("📧 Activation mail sent to:", partner.email);
    } catch (mailErr) {
      console.error("❌ Failed to send activation email:", mailErr.message);
    }

    res.json({
      message: "Partner activated successfully and notified via email",
    });
  } catch (error) {
    console.error("Error in /partner/activate:", error);
    res.status(500).json({ message: error.message });
  }
});

// GET /partner/active list
router.get("/active/partner", async (req, res) => {
  try {
    const activePartners = await User.find({
      role: ROLES.PARTNER,
      status: "ACTIVE",
    });

    res.json({
      message: "Active PARTNER list fetched successfully",
      activePartners,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// router.get("/dashboard", auth, requireRole(ROLES.RM), async (req, res) => {
//   try {
//     const rmId = req.user.sub; // RM ID from token

//     // RM Details
//     const rm = await User.findOne({ _id: rmId, role: ROLES.RM }).lean();
//     if (!rm) return res.status(404).json({ message: "RM not found" });

//     // Partners under RM
//     const partners = await User.find({ rmId, role: ROLES.PARTNER }).lean();
//     const partnerIds = partners.map((p) => p._id);

//     const totalPartners = partners.length;
//     const activePartners = await User.countDocuments({
//       rmId,
//       role: ROLES.PARTNER,
//       status: "ACTIVE",
//     });

//     // Customers under RM
//     const customers = await Application.distinct("customerId", { rmId });
//     const totalCustomers = customers.length;

//     // In-process applications
//     const inProcessApplications = await Application.countDocuments({
//       rmId,
//       status: "UNDER_REVIEW",
//     });

//     // Revenue
//     const revenueAgg = await Application.aggregate([
//       {
//         $match: {
//           rmId: new mongoose.Types.ObjectId(rmId),
//           status: "DISBURSED",
//         },
//       },
//       {
//         $group: {
//           _id: null,
//           total: { $sum: { $ifNull: ["$approvedLoanAmount", 0] } },
//         },
//       },
//     ]);
//     const totalRevenue = revenueAgg[0]?.total || 0;

//     // Avg partner rating
//     const ratings = partners.map((p) => p.rating || 0);
//     const avgRating = ratings.length
//       ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
//       : 0;

//     // 12-month targets and achieved
//     const now = new Date();
//     const startOfYear = new Date(now.getFullYear(), 0, 1);

//     // Monthly Target from Target collection
//     // const monthlyTarget = await Target.aggregate([
//     //   {
//     //     $match: {
//     //       assignedTo: { $in: partnerIds }, // Correct field
//     //       createdAt: { $gte: startOfYear },
//     //     },
//     //   },
//     //   {
//     //     $group: {
//     //       _id: { month: { $month: "$createdAt" } },
//     //       totalTarget: { $sum: "$targetValue" }, // Correct field
//     //     },
//     //   },
//     //   { $sort: { "_id.month": 1 } },
//     // ]);

//     const monthlyTarget = await Target.aggregate([
//       {
//         $match: {
//           $or: [
//             { assignedTo: rm._id }, // RM's own target
//             { assignedTo: { $in: partnerIds } }, // Partners' targets
//           ],
//           createdAt: { $gte: startOfYear },
//         },
//       },
//       {
//         $group: {
//           _id: { month: { $month: "$createdAt" } },
//           totalTarget: { $sum: "$targetValue" },
//         },
//       },
//       { $sort: { "_id.month": 1 } },
//     ]);

//     // Monthly Achieved from Application
//     const monthlyAchieved = await Application.aggregate([
//       {
//         $match: {
//           rmId: new mongoose.Types.ObjectId(rmId),
//           status: "DISBURSED",
//           createdAt: { $gte: startOfYear },
//         },
//       },
//       {
//         $group: {
//           _id: { month: { $month: "$createdAt" } },
//           totalAchieved: { $sum: { $toDouble: "$approvedLoanAmount" } },
//         },
//       },
//       { $sort: { "_id.month": 1 } },
//     ]);

//     const monthNames = [
//       "January",
//       "February",
//       "March",
//       "April",
//       "May",
//       "June",
//       "July",
//       "August",
//       "September",
//       "October",
//       "November",
//       "December",
//     ];

//     const targets = Array.from({ length: 12 }, (_, i) => {
//       const month = i + 1;
//       const t =
//         monthlyTarget.find((m) => m._id.month === month)?.totalTarget || 0;
//       const a =
//         monthlyAchieved.find((m) => m._id.month === month)?.totalAchieved || 0;
//       return { month: monthNames[i], target: t, achieved: a };
//     });

//     // High-value customers
//     const highValueCustomers = await Application.aggregate([
//       {
//         $match: {
//           rmId: new mongoose.Types.ObjectId(rmId),
//           status: "DISBURSED",
//         },
//       },
//       {
//         $group: {
//           _id: "$customerId",
//           maxLoan: { $max: { $toDouble: "$approvedLoanAmount" } },
//           latestApp: { $first: "$$ROOT" },
//         },
//       },
//       { $sort: { maxLoan: -1 } },
//       { $limit: 10 },
//       {
//         $lookup: {
//           from: "users",
//           localField: "_id",
//           foreignField: "_id",
//           as: "customer",
//         },
//       },
//       { $unwind: "$customer" },
//       {
//         $project: {
//           customerId: "$customer._id",
//           name: { $concat: ["$customer.firstName", " ", "$customer.lastName"] },
//           email: "$customer.email",
//           phone: "$customer.phone",
//           maxLoan: 1,
//           status: "$latestApp.status",
//         },
//       },
//     ]);

//     // Sales pipeline (UNDER_REVIEW)
//     const salesPipeline = await Application.aggregate([
//       {
//         $match: {
//           rmId: new mongoose.Types.ObjectId(rmId),
//           status: "UNDER_REVIEW",
//         },
//       },
//       {
//         $addFields: {
//           requestedAmountNum: { $ifNull: ["$customer.loanAmount", 0] },
//         },
//       },
//       { $sort: { requestedAmountNum: -1, createdAt: -1 } },
//       {
//         $group: {
//           _id: "$customerId",
//           maxLoan: { $first: "$requestedAmountNum" },
//           latestApp: { $first: "$$ROOT" },
//         },
//       },
//       { $limit: 10 },
//       {
//         $lookup: {
//           from: "users",
//           localField: "_id",
//           foreignField: "_id",
//           as: "customer",
//         },
//       },
//       { $unwind: "$customer" },
//       {
//         $project: {
//           customerId: "$customer._id",
//           name: { $concat: ["$customer.firstName", " ", "$customer.lastName"] },
//           email: "$customer.email",
//           phone: "$customer.phone",
//           maxLoan: 1,
//           status: "$latestApp.status",
//         },
//       },
//     ]);

//     res.json({
//       totals: {
//         totalPartners,
//         activePartners,
//         totalCustomers,
//         totalRevenue,
//         avgRating,
//         inProcessApplications,
//       },
//       targets,
//       highValueCustomers,
//       salesPipeline,
//     });
//   } catch (error) {
//     console.error("Error in RM dashboard:", error);
//     res.status(500).json({ message: "Server error" });
//   }
// });

//// GET /rm/customers


router.get("/dashboard", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub; // RM ID from token

    // RM Details with RSM population
    const rm = await User.findOne({ _id: rmId, role: ROLES.RM })
      .populate({
        path: "personalRsmId",
        select: "firstName lastName employeeId phone email",
      })
      .populate({
        path: "businessHomeRsmId",
        select: "firstName lastName employeeId phone email",
      })
      .lean();
    if (!rm) return res.status(404).json({ message: "RM not found" });

    // Partners under RM
    const partners = await User.find({ rmId, role: ROLES.PARTNER }).lean();
    const partnerIds = partners.map((p) => p._id);

    const totalPartners = partners.length;
    const activePartners = await User.countDocuments({
      rmId,
      role: ROLES.PARTNER,
      status: "ACTIVE",
    });

    // Customers under RM (including from partners)
    const customers = await Application.distinct("customerId", {
      $or: [
        { rmId: rmId }, // Direct RM assignment
        { partnerId: { $in: partnerIds } } // Applications from partners under this RM
      ]
    });
    const totalCustomers = customers.length;

    // In-process applications (including from partners)
    const inProcessApplications = await Application.countDocuments({
      $or: [
        { rmId: rmId, status: "UNDER_REVIEW" }, // Direct RM assignment
        { partnerId: { $in: partnerIds }, status: "UNDER_REVIEW" } // Applications from partners
      ]
    });

    // Revenue (including from partners)
    const revenueAgg = await Application.aggregate([
      {
        $match: {
          $or: [
            { rmId: new mongoose.Types.ObjectId(rmId), status: "DISBURSED" },
            { partnerId: { $in: partnerIds }, status: "DISBURSED" }
          ]
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ["$approvedLoanAmount", 0] } },
        },
      },
    ]);
    const totalRevenue = revenueAgg[0]?.total || 0;

    // Avg partner rating
    const ratings = partners.map((p) => p.rating || 0);
    const avgRating = ratings.length
      ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
      : 0;

    // Current Month Target (RM's hierarchical target - sum of partner targets)
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // Get RM's current month target (hierarchical - sum of partner targets)
    const rmTarget = await Target.findOne({
      assignedTo: rm._id,
      role: ROLES.RM,
      month: currentMonth,
      year: currentYear,
    }).lean();

    // Calculate current month achievements (disbursed applications)
    const currentMonthStart = new Date(currentYear, currentMonth - 1, 1);
    const currentMonthEnd = new Date(currentYear, currentMonth, 1);

    const currentMonthDisbursed = await Application.aggregate([
      {
        $match: {
          $or: [
            { rmId: new mongoose.Types.ObjectId(rmId), status: "DISBURSED" },
            { partnerId: { $in: partnerIds }, status: "DISBURSED" }
          ],
          updatedAt: {
            $gte: currentMonthStart,
            $lt: currentMonthEnd,
          },
        },
      },
      {
        $group: {
          _id: null,
          totalDisbursement: { $sum: { $toDouble: "$approvedLoanAmount" } },
          totalFiles: { $sum: 1 },
        },
      },
    ]);

    const currentMonthAchievedDisbursement = currentMonthDisbursed[0]?.totalDisbursement || 0;
    const currentMonthAchievedFileCount = currentMonthDisbursed[0]?.totalFiles || 0;

    // 12-month RM targets and achieved
    const startOfYear = new Date(currentYear, 0, 1);

    // RM's own monthly targets (hierarchical)
    const monthlyTarget = await Target.find({
      assignedTo: rm._id,
      role: ROLES.RM,
      year: currentYear,
    }).lean();

    // Monthly Achieved from Applications under RM (including from partners)
    const monthlyAchieved = await Application.aggregate([
      {
        $match: {
          $or: [
            { rmId: new mongoose.Types.ObjectId(rmId) },
            { partnerId: { $in: partnerIds } }
          ],
          status: { $ne: "DRAFT" },
          updatedAt: { $gte: startOfYear },
        },
      },
      {
        $group: {
          _id: { month: { $month: "$updatedAt" } },
          totalAchieved: { 
            $sum: { 
              $cond: [{ $eq: ["$status", "DISBURSED"] }, { $toDouble: "$approvedLoanAmount" }, 0] 
            } 
          },
          totalFiles: { $sum: 1 },
        },
      },
      { $sort: { "_id.month": 1 } },
    ]);

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];

    const targets = Array.from({ length: 12 }, (_, i) => {
      const month = i + 1;
      const targetDoc = monthlyTarget.find((t) => t.month === month);
      const t = targetDoc?.disbursementTarget || 0;
      const a =
        monthlyAchieved.find((m) => m._id.month === month)?.totalAchieved || 0;
      return { 
        month: monthNames[i], 
        target: t, 
        achieved: a,
        fileCountTarget: targetDoc?.fileCountTarget || 0,
        achievedFileCount: monthlyAchieved.find((m) => m._id.month === month)?.totalFiles || 0,
      };
    });

    // High-value customers (top 10 disbursed loans, including from partners)
    const highValueCustomers = await Application.aggregate([
      { $match: { 
        $or: [
          { rmId: new mongoose.Types.ObjectId(rmId), status: "DISBURSED" },
          { partnerId: { $in: partnerIds }, status: "DISBURSED" }
        ]
      } },
      { $group: { _id: "$customerId", maxLoan: { $max: { $toDouble: "$approvedLoanAmount" } }, latestApp: { $first: "$$ROOT" } } },
      { $sort: { maxLoan: -1 } },
      { $limit: 10 },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "customer" } },
      { $unwind: "$customer" },
      { $project: {
          customerId: "$customer._id",
          name: { $concat: ["$customer.firstName", " ", "$customer.lastName"] },
          email: "$customer.email",
          phone: "$customer.phone",
          maxLoan: 1,
          status: "$latestApp.status"
        }
      }
    ]);

    // Sales pipeline (UNDER_REVIEW applications, including from partners)
    const salesPipeline = await Application.aggregate([
      { $match: { 
        $or: [
          { rmId: new mongoose.Types.ObjectId(rmId), status: "UNDER_REVIEW" },
          { partnerId: { $in: partnerIds }, status: "UNDER_REVIEW" }
        ]
      } },
      { $addFields: { requestedAmountNum: { $ifNull: ["$customer.loanAmount", 0] } } },
      { $sort: { requestedAmountNum: -1, createdAt: -1 } },
      { $group: { _id: "$customerId", maxLoan: { $first: "$requestedAmountNum" }, latestApp: { $first: "$$ROOT" } } },
      { $limit: 10 },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "customer" } },
      { $unwind: "$customer" },
      { $project: {
          customerId: "$customer._id",
          name: { $concat: ["$customer.firstName", " ", "$customer.lastName"] },
          email: "$customer.email",
          phone: "$customer.phone",
          maxLoan: 1,
          status: "$latestApp.status"
        }
      }
    ]);

    const monthStartDash = new Date(currentYear, currentMonth - 1, 1);
    const monthEndDash = new Date(currentYear, currentMonth, 1);

    const [disbursedByPartner, payoutByPartner, dealsMonthByPartner] =
      partnerIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            Application.aggregate([
              {
                $match: {
                  partnerId: { $in: partnerIds },
                  status: "DISBURSED",
                },
              },
              {
                $group: {
                  _id: "$partnerId",
                  totalDisbursed: { $sum: { $toDouble: "$approvedLoanAmount" } },
                },
              },
            ]),
            Payout.aggregate([
              {
                $match: {
                  partnerId: { $in: partnerIds },
                  payOutStatus: "DONE",
                },
              },
              {
                $group: {
                  _id: "$partnerId",
                  totalPayout: { $sum: "$amount" },
                },
              },
            ]),
            Application.aggregate([
              {
                $match: {
                  partnerId: { $in: partnerIds },
                  status: "DISBURSED",
                  updatedAt: { $gte: monthStartDash, $lt: monthEndDash },
                },
              },
              {
                $group: {
                  _id: "$partnerId",
                  deals: { $sum: 1 },
                },
              },
            ]),
          ]);

    const disbursedMap = Object.fromEntries(
      disbursedByPartner.map((d) => [d._id.toString(), d.totalDisbursed])
    );
    const payoutMap = Object.fromEntries(
      payoutByPartner.map((d) => [d._id.toString(), d.totalPayout])
    );
    const dealsMonthMap = Object.fromEntries(
      dealsMonthByPartner.map((d) => [d._id.toString(), d.deals])
    );

    const partnerPayoutSummary = partners
      .map((p) => {
        const id = p._id.toString();
        return {
          id,
          name: `${p.firstName || ""} ${p.lastName || ""}`.trim() || "Partner",
          status: p.status,
          totalDisbursed: disbursedMap[id] || 0,
          totalPayout: payoutMap[id] || 0,
          dealsThisMonth: dealsMonthMap[id] || 0,
        };
      })
      .sort(
        (a, b) =>
          b.totalPayout +
          b.totalDisbursed -
          (a.totalPayout + a.totalDisbursed)
      )
      .slice(0, 8);

    // Response with RSM details
    res.json({
      totals: {
        totalPartners,
        activePartners,
        totalCustomers,
        totalRevenue,
        avgRating,
        inProcessApplications,
      },
      // Current month target and achievement
      currentMonthTarget: {
        fileCountTarget: rmTarget?.fileCountTarget || 0,
        disbursementTarget: rmTarget?.disbursementTarget || 0,
        achievedFileCount: currentMonthAchievedFileCount,
        achievedDisbursement: currentMonthAchievedDisbursement,
        fileTargetMet: currentMonthAchievedFileCount >= (rmTarget?.fileCountTarget || 0),
        disbursementTargetMet: currentMonthAchievedDisbursement >= (rmTarget?.disbursementTarget || 0),
        targetAchieved: currentMonthAchievedFileCount >= (rmTarget?.fileCountTarget || 0) && 
                       currentMonthAchievedDisbursement >= (rmTarget?.disbursementTarget || 0),
      },
      targets, // RM monthly targets & achieved (12-month breakdown)
      highValueCustomers,
      salesPipeline,
      partnerPayoutSummary,
      // RSM details
      personalRsm: rm.personalRsmId ? {
        id: rm.personalRsmId._id,
        name: `${rm.personalRsmId.firstName} ${rm.personalRsmId.lastName}`,
        employeeId: rm.personalRsmId.employeeId,
        phone: rm.personalRsmId.phone,
        email: rm.personalRsmId.email,
      } : null,
      businessHomeRsm: rm.businessHomeRsmId ? {
        id: rm.businessHomeRsmId._id,
        name: `${rm.businessHomeRsmId.firstName} ${rm.businessHomeRsmId.lastName}`,
        employeeId: rm.businessHomeRsmId.employeeId,
        phone: rm.businessHomeRsmId.phone,
        email: rm.businessHomeRsmId.email,
      } : null,
    });

  } catch (error) {
    console.error("Error in RM dashboard:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/customers", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub; // RM logged in

    // Get all partners under this RM
    const partners = await User.find({ 
      rmId: rmId, 
      role: ROLES.PARTNER 
    }).select("_id").lean();
    const partnerIds = partners.map(p => p._id);

    // Find all applications under this RM:
    // 1. Applications where rmId directly matches, OR
    // 2. Applications from partners under this RM (even if rmId wasn't set on application)
    // ✅ RM can see all their applications, but can only control statuses up to DOC_COMPLETE
    // Applications with status beyond DOC_COMPLETE are shown for reference but cannot be modified
    const applications = await Application.find({
      $or: [
        { rmId: rmId }, // Direct RM assignment
        { partnerId: { $in: partnerIds } } // Applications from partners under this RM
      ]
    })
      .populate("customerId", "employeeId firstName lastName email phone") // ✅ get employeeId from User
      .populate("partnerId", "firstName lastName email phone")
      .lean();

    // Get payout status + amount for these applications
    const appIds = applications.map((app) => app._id);
    const payouts = await Payout.find({ application: { $in: appIds } })
      .select("application amount payOutStatus")
      .lean();

    const payoutMap = {};
    payouts.forEach((p) => {
      payoutMap[p.application.toString()] = p;
    });

    const customers = applications.map((app) => {
      const payout = payoutMap[app._id.toString()];
      return {
        customerId: app.customerId?._id,
        customerEmployeeId: app.customerId?.employeeId || null,
        customerName: `${app.customerId?.firstName ?? ""} ${
          app.customerId?.lastName ?? ""
        }`.trim(),
        contact: app.customerId?.phone || null,
        email: app.customerId?.email || null,
        loanType: app.loanType,
        requestedAmount: app.customer?.loanAmount || null,
        approvedAmount: app.approvedLoanAmount || null,
        status: app.status,
        payOutStatus: payout?.payOutStatus || "PENDING",
        payoutAmount: payout?.amount || 0,
        partner: {
          partnerId: app.partnerId?._id,
          name: `${app.partnerId?.firstName ?? ""} ${
            app.partnerId?.lastName ?? ""
          }`.trim(),
          email: app.partnerId?.email,
          phone: app.partnerId?.phone,
        },
        applicationId: app._id,
        createdAt: app.createdAt,
      };
    });

    return res.json(customers);
  } catch (err) {
    console.error("Error fetching RM customers:", err);
    return res.status(500).json({ message: "Error fetching RM customers" });
  }
});

// Payout endpoints moved to ASM and Admin routes

// ✅ Get full loan application details (everything from schema)
// router.get(
//   "/customers/:customerId/applications/:applicationId",
//   auth,
//   requireRole(ROLES.RM),
//   async (req, res) => {
//     try {
//       const rmId = req.user.sub; // RM logged in
//       const { customerId, applicationId } = req.params;

//       // Find the full application belonging to this RM + Customer
//       const application = await Application.findOne({
//         _id: applicationId,
//         rmId,
//         customerId,
//       })
//         .populate("customerId", "firstName lastName email phone") // 👤 User-level info
//         .populate("partnerId", "firstName lastName email phone") // 👔 Partner info
//         .populate("rmId", "firstName lastName email phone") // 🧑‍💼 RM info
//         .populate("docs.uploadedBy", "firstName lastName email") // 📄 Who uploaded documents
//         .lean();

//       if (!application) {
//         return res.status(404).json({
//           message: "Application not found or not assigned to this RM",
//         });
//       }

//       return res.json(application);
//     } catch (err) {
//       console.error("Error fetching full application details:", err);
//       return res
//         .status(500)
//         .json({ message: "Error fetching application details" });
//     }
//   }
// );

router.get(
  "/customers/:customerId/applications/:applicationId",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub; // RM logged in
      const { customerId, applicationId } = req.params;

      // Get all partners under this RM
      const partners = await User.find({ rmId, role: ROLES.PARTNER }).select("_id").lean();
      const partnerIds = partners.map(p => p._id);

      // Find the full application belonging to this RM + Customer (either directly or via partners)
      const application = await Application.findOne({
        _id: applicationId,
        customerId,
        $or: [
          { rmId: rmId }, // Direct RM assignment
          { partnerId: { $in: partnerIds } } // Applications from partners under this RM
        ]
      })
        .populate("customerId", "firstName lastName email phone") // 👤 User-level info
        .populate("partnerId", "firstName lastName email phone") // 👔 Partner info
        .populate("rmId", "firstName lastName email phone") // 🧑‍💼 RM info
        .populate("docs.uploadedBy", "firstName lastName email") // 📄 Who uploaded documents
        .lean();

      if (!application) {
        return res.status(404).json({
          message: "Application not found or not assigned to this RM",
        });
      }

      const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";

      // Prepend backend URL to all docs
      if (application.docs && application.docs.length) {
        application.docs = application.docs.map((doc) => ({
          ...doc,
          url: doc.url.startsWith("http") ? doc.url : `${backendUrl}/${doc.url}`,
        }));
      }

      return res.json(application);
    } catch (err) {
      console.error("Error fetching full application details:", err);
      return res
        .status(500)
        .json({ message: "Error fetching application details" });
    }
  }
);


// router.get(
//   "/applications/:id/docs/:docType/download",
//   auth,
//   requireRole(ROLES.RM),
//   async (req, res) => {
//     try {
//       const { id, docType } = req.params;
//       const app = await Application.findById(id).lean();

//       if (!app) {
//         return res.status(404).json({ message: "Application not found" });
//       }

//       const doc = app.docs.find(
//         (d) => d.docType.toUpperCase() === docType.toUpperCase()
//       );
//       if (!doc) {
//         return res.status(404).json({ message: "Document not found" });
//       }

//       // ✅ Resolve file path
//       const filePath = path.resolve(process.cwd(), doc.url);
//       if (!fs.existsSync(filePath)) {
//         return res.status(404).json({ message: "File not found" });
//       }

//       const stats = fs.statSync(filePath);
//       if (!stats.isFile()) {
//         return res.status(404).json({ message: "Path is not a file" });
//       }

//       // ✅ Detect MIME type
//       const fileExtension = path.extname(filePath);
//       const filename = `${docType}${fileExtension}`;
//       const contentType =
//         mime.lookup(fileExtension) || "application/octet-stream";

//       // ✅ Expose Content-Disposition so frontend can read filename
//       res.setHeader(
//         "Content-Disposition",
//         `attachment; filename="${filename}"`
//       );
//       res.setHeader("Content-Type", contentType);
//       res.setHeader("Content-Length", stats.size);
//       res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

//       // ✅ Stream file
//       const fileStream = fs.createReadStream(filePath);
//       fileStream.pipe(res);

//       fileStream.on("error", (err) => {
//         console.error("File stream error:", err);
//         if (!res.headersSent) {
//           res.status(500).json({ message: "Error reading file" });
//         }
//       });
//     } catch (err) {
//       console.error("Download error:", err);
//       if (!res.headersSent) {
//         res.status(500).json({ message: "Error downloading document" });
//       }
//     }
//   }
// );

// ✅ RM upload / replace document file (pending + manage form)
router.post(
  "/applications/:id/documents",
  auth,
  requireRole(ROLES.RM),
  upload.single("file"),
  async (req, res) => {
    try {
      const rmId = req.user.sub;
      const { id } = req.params;
      const { docType } = req.query;

      if (!docType) {
        return res.status(400).json({ message: "docType is required" });
      }

      if (!req.file) {
        return res.status(400).json({
          message: "File is required",
          receivedFields: Object.keys(req.body || {}),
        });
      }

      const violSingle = oversizeSingleDocViolation(req.file, docType);
      if (violSingle) {
        await deleteS3ObjectsForUploadedFiles([req.file]);
        return res.status(400).json({ message: formatOversizeMessage(violSingle) });
      }

      const partners = await User.find({ rmId, role: ROLES.PARTNER }).select("_id").lean();
      const partnerIds = partners.map((p) => p._id);

      const application = await Application.findOne({
        _id: id,
        $or: [{ rmId }, { partnerId: { $in: partnerIds } }],
      });

      if (!application) {
        return res.status(404).json({
          message: "Application not found or not assigned to this RM",
        });
      }

      if (application.rsmId) {
        await deleteS3ObjectsForUploadedFiles([req.file]);
        return res.status(403).json({
          message:
            "This application has been transferred to RSM and can no longer be modified by RM.",
        });
      }

      if (application.status === "DOC_COMPLETE") {
        await deleteS3ObjectsForUploadedFiles([req.file]);
        return res.status(403).json({
          message:
            "Cannot upload documents while status is DOC_COMPLETE. Set DOC_INCOMPLETE first if documents need updating.",
        });
      }

      const normalizedType = String(docType).toUpperCase();
      const docIndex = application.docs.findIndex(
        (doc) => doc.docType?.toUpperCase() === normalizedType
      );

      const now = new Date();
      const isUpdate = docIndex >= 0;
      const previousDoc = isUpdate ? application.docs[docIndex] : null;

      // RM-uploaded docs are treated as verified (RM is the verifier)
      const newDoc = {
        docType: normalizedType,
        url: req.file.location || req.file.path,
        uploadedBy: rmId,
        status: "VERIFIED",
        uploadedAt:
          isUpdate && previousDoc?.uploadedAt ? previousDoc.uploadedAt : now,
        updatedAt: now,
        remarks: isUpdate
          ? previousDoc?.remarks || "Updated by RM"
          : "Uploaded by RM",
        verifiedAt: now,
        verifiedBy: rmId,
        rejectedAt: null,
        rejectedBy: null,
      };

      if (docIndex >= 0) {
        application.docs[docIndex] = newDoc;
      } else {
        application.docs.push(newDoc);
      }

      if (application.status === "SUBMITTED") {
        try {
          application.transition(
            "DOC_INCOMPLETE",
            rmId,
            "Documents uploaded by RM - verification in progress"
          );
        } catch (transitionErr) {
          console.error(
            "Status transition DOC_INCOMPLETE failed:",
            transitionErr.message
          );
          application.status = "DOC_INCOMPLETE";
        }
      }

      await application.save();

      res.json({
        message: isUpdate
          ? "Document updated successfully by RM"
          : "Document uploaded successfully by RM",
        document: newDoc,
        isUpdate,
        applicationStatus: application.status,
      });
    } catch (err) {
      console.error("RM document upload error:", err);
      if (req.file) {
        try {
          await deleteS3ObjectsForUploadedFiles([req.file]);
        } catch (_) {
          /* ignore cleanup errors */
        }
      }
      res.status(500).json({
        message: "Error uploading document",
        error: err.message,
      });
    }
  }
);

// ✅ Update document status (REJECTED, VERIFIED, PENDING) with remarks
// NOTE: This route MUST be before the download route to avoid conflicts
// Using PUT method for document status updates
router.put(
  "/applications/:id/docs/:docType",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const { id, docType } = req.params;
      const { status, remarks } = req.body;

      // Decode docType in case it was URL encoded (handles underscores and special chars)
      const decodedDocType = decodeURIComponent(docType);
      
      console.log("PUT /applications/:id/docs/:docType called", { 
        id, 
        docType, 
        decodedDocType,
        status, 
        remarks 
      });

      if (!status || !["PENDING", "VERIFIED", "REJECTED"].includes(status)) {
        return res.status(400).json({
          message: "Invalid status. Must be PENDING, VERIFIED, or REJECTED",
        });
      }

      const rmId = req.user.sub;
      
      // Get all partners under this RM
      const partners = await User.find({ rmId, role: ROLES.PARTNER }).select("_id").lean();
      const partnerIds = partners.map(p => p._id);

      // Find application either directly assigned to RM or via partners
      const app = await Application.findOne({
        _id: id,
        $or: [
          { rmId: rmId }, // Direct RM assignment
          { partnerId: { $in: partnerIds } } // Applications from partners under this RM
        ]
      });

      if (!app) {
        return res.status(404).json({
          message: "Application not found or not assigned to this RM",
        });
      }

      // ✅ CRITICAL: If application has rsmId set (transferred to RSM), RM CANNOT modify documents
      // Once DOC_COMPLETE is set and rsmId is assigned, the application belongs to RSM
      if (app.rsmId) {
        return res.status(403).json({
          message: "This application has been transferred to RSM and can no longer be modified by RM. Once documents are complete, only RSM can handle document changes."
        });
      }

      // ✅ Also prevent modifying documents if status is DOC_COMPLETE (even if rsmId wasn't set - safety check)
      if (app.status === "DOC_COMPLETE") {
        return res.status(403).json({
          message: "Cannot modify documents for applications with DOC_COMPLETE status. Once documents are complete, the application is transferred to RSM for processing."
        });
      }

      // Find and update the document - handle case-insensitive matching
      const docIndex = app.docs.findIndex(
        (d) => d.docType.toUpperCase() === decodedDocType.toUpperCase()
      );

      console.log("Document search:", {
        searchingFor: decodedDocType,
        availableDocs: app.docs.map(d => d.docType),
        foundIndex: docIndex
      });

      if (docIndex === -1) {
        return res.status(404).json({
          message: "Document not found",
          docType: decodedDocType,
          availableDocTypes: app.docs.map((d) => d.docType),
        });
      }

      // Update document status and remarks with timestamps
      const now = new Date();
      const previousStatus = app.docs[docIndex].status;
      
      app.docs[docIndex].status = status;
      app.docs[docIndex].updatedAt = now;
      
      if (remarks !== undefined) {
        app.docs[docIndex].remarks = remarks || "";
      }
      
      // Set timestamps based on status change
      if (status === "VERIFIED") {
        app.docs[docIndex].verifiedAt = now;
        app.docs[docIndex].verifiedBy = req.user.sub;
        // Clear rejected timestamps if verifying
        app.docs[docIndex].rejectedAt = null;
        app.docs[docIndex].rejectedBy = null;
      } else if (status === "REJECTED") {
        app.docs[docIndex].rejectedAt = now;
        app.docs[docIndex].rejectedBy = req.user.sub;
        // Clear verified timestamps if rejecting
        app.docs[docIndex].verifiedAt = null;
        app.docs[docIndex].verifiedBy = null;
      } else if (status === "UPDATED") {
        // When RM marks as UPDATED, it means partner re-uploaded and needs review
        app.docs[docIndex].updatedAt = now;
      }
      
      // Ensure uploadedAt exists
      if (!app.docs[docIndex].uploadedAt) {
        app.docs[docIndex].uploadedAt = now;
      }

      // When RM marks document as UPDATED, it means they acknowledge the re-upload
      // This will be changed to VERIFIED or REJECTED after RM reviews
      // When RM verifies an UPDATED document, it becomes VERIFIED
      // When RM rejects an UPDATED document, it becomes REJECTED (partner needs to re-upload again)

      let workflowMeta = { statusChanged: false, oldStatus: app.status, newStatus: app.status };
      try {
        workflowMeta = await syncApplicationStatusAfterDocUpdate(app, rmId);
      } catch (syncErr) {
        console.error("syncApplicationStatusAfterDocUpdate failed:", syncErr);
        return res.status(syncErr.statusCode || 500).json({
          message: syncErr.message || "Could not update application status",
        });
      }

      await app.save();

      // Emit socket notification with action tracking
      try {
        // Use global.io which is set in index.js
        const io = global.io;
        if (io) {
          console.log("🔔 RM Route: Emitting document status change", {
            applicationId: app._id,
            docType: decodedDocType,
            status,
            actionBy: req.user.sub,
          });

          // Populate application data for detailed notification
          await app.populate("customerId", "firstName middleName lastName email phone");
          await app.populate("partnerId", "firstName lastName email employeeId");
          await app.populate("rmId", "firstName lastName asmId");
          // Get ASM ID from RM if available
          if (app.rmId?.asmId) {
            app.asmId = app.rmId.asmId;
          }
          
          // Extract IDs properly - handle both populated objects and plain IDs
          const partnerIdForSocket = app.partnerId?._id?.toString() || app.partnerId?.toString() || (app.partnerId ? String(app.partnerId) : null);
          const customerIdForSocket = app.customerId?._id?.toString() || app.customerId?.toString() || (app.customerId ? String(app.customerId) : null);
          
          console.log("🔔 RM Route: Extracted IDs for socket", {
            partnerId: partnerIdForSocket,
            customerId: customerIdForSocket,
            partnerIdType: typeof app.partnerId,
            customerIdType: typeof app.customerId,
          });
          
          await emitDocumentStatusChanged(
            io,
            app._id.toString(),
            decodedDocType,
            status,
            req.user.sub,
            partnerIdForSocket,
            customerIdForSocket,
            req.user.sub, // actionBy - who performed the action
            app // pass application object for details
          );
          
          console.log("✅ Document status socket emission completed");

          await maybeEmitApplicationStatusAfterDocWorkflow(io, app, workflowMeta, req.user.sub);
        } else {
          console.error("❌ Socket io instance not available (global.io is null)");
        }
      } catch (socketErr) {
        console.error("❌ Error emitting socket event:", socketErr);
        console.error("Stack:", socketErr.stack);
        // Don't fail the request if socket fails
      }

      // Send response immediately (don't wait for email)
      res.json({
        message: "Document status updated successfully",
        document: app.docs[docIndex],
        applicationStatus: app.status,
        allDocumentsVerified: app.areAllDocumentsVerified(),
      });

      // Email is intentionally NOT sent for document status changes (too noisy).
      // Users should rely on in-app notifications instead.
    } catch (err) {
      console.error("Error updating document status:", err);
      res.status(500).json({
        message: "Error updating document status",
        error: err.message,
      });
    }
  }
);

// Alternative POST route for document status update (in case PUT doesn't work)
// Route: POST /rm/applications/:id/docs/:docType/update-status
router.post(
  "/applications/:id/docs/:docType/update-status",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const { id, docType } = req.params;
      const { status, remarks } = req.body;

      // Decode docType in case it was URL encoded
      const decodedDocType = decodeURIComponent(docType);
      
      console.log("POST /applications/:id/docs/:docType/update-status called", {
        id,
        docType,
        decodedDocType,
        status,
        remarks
      });

      if (!status || !["PENDING", "VERIFIED", "REJECTED"].includes(status)) {
        return res.status(400).json({
          message: "Invalid status. Must be PENDING, VERIFIED, or REJECTED",
        });
      }

      const rmIdPost = req.user.sub;
      const partnersPost = await User.find({ rmId: rmIdPost, role: ROLES.PARTNER }).select("_id").lean();
      const partnerIdsPost = partnersPost.map((p) => p._id);

      const app = await Application.findOne({
        _id: id,
        $or: [{ rmId: rmIdPost }, { partnerId: { $in: partnerIdsPost } }],
      });

      if (!app) {
        console.log("Application not found", { id, rmId: rmIdPost });
        return res.status(404).json({
          message: "Application not found or not assigned to this RM",
        });
      }

      // ✅ CRITICAL: If application has rsmId set (transferred to RSM), RM CANNOT modify documents
      // Once DOC_COMPLETE is set and rsmId is assigned, the application belongs to RSM
      if (app.rsmId) {
        return res.status(403).json({
          message: "This application has been transferred to RSM and can no longer be modified by RM. Once documents are complete, only RSM can handle document changes."
        });
      }

      // ✅ Also prevent modifying documents if status is DOC_COMPLETE (even if rsmId wasn't set - safety check)
      if (app.status === "DOC_COMPLETE") {
        return res.status(403).json({
          message: "Cannot modify documents for applications with DOC_COMPLETE status. Once documents are complete, the application is transferred to RSM for processing."
        });
      }

      const docIndex = app.docs.findIndex(
        (d) => d.docType.toUpperCase() === decodedDocType.toUpperCase()
      );

      if (docIndex === -1) {
        return res.status(404).json({
          message: "Document not found",
          docType: decodedDocType,
          availableDocTypes: app.docs.map((d) => d.docType),
        });
      }

      app.docs[docIndex].status = status;
      if (remarks !== undefined) {
        app.docs[docIndex].remarks = remarks || "";
      }
      
      if (!app.docs[docIndex].uploadedAt) {
        app.docs[docIndex].uploadedAt = new Date();
      }

      let workflowMetaPost = { statusChanged: false, oldStatus: app.status, newStatus: app.status };
      try {
        workflowMetaPost = await syncApplicationStatusAfterDocUpdate(app, rmIdPost);
      } catch (syncErr) {
        console.error("syncApplicationStatusAfterDocUpdate failed (POST):", syncErr);
        return res.status(syncErr.statusCode || 500).json({
          message: syncErr.message || "Could not update application status",
        });
      }

      await app.save();

      // Send email notification to partner
      try {
        const partner = await User.findById(app.partnerId).lean();
        if (partner && partner.email) {
          const statusMessage = status === "REJECTED" 
            ? "has been REJECTED and needs to be re-uploaded"
            : status === "VERIFIED"
            ? "has been VERIFIED"
            : "status has been updated to PENDING";
          
          await sendMail({
            to: partner.email,
            subject: `Document Status Update - ${decodedDocType}`,
            html: `
              <p>Dear ${partner.firstName || "Partner"},</p>
              <p>The document <strong>${decodedDocType}</strong> for application <strong>${app.appNo}</strong> ${statusMessage}.</p>
              ${remarks ? `<p><b>Remarks from RM:</b> ${remarks}</p>` : ""}
              ${status === "REJECTED" ? `<p>Please re-upload this document through the application form.</p>` : ""}
              <br/>
              <p>Thank you,<br/>DhanSource Capital</p>
            `,
          });
        }
      } catch (mailErr) {
        console.error("Failed to send email notification:", mailErr.message);
      }

      // Emit socket notification with action tracking
      try {
        // Use global.io which is set in index.js
        const io = global.io;
        if (io) {
          console.log("🔔 RM Route: Emitting document status change", {
            applicationId: app._id,
            docType: decodedDocType,
            status,
            actionBy: req.user.sub,
          });

          // Populate application data for detailed notification
          await app.populate("customerId", "firstName middleName lastName email phone");
          await app.populate("partnerId", "firstName lastName email employeeId");
          await app.populate("rmId", "firstName lastName asmId");
          // Get ASM ID from RM if available
          if (app.rmId?.asmId) {
            app.asmId = app.rmId.asmId;
          }
          
          // Extract IDs properly - handle both populated objects and plain IDs
          const partnerIdForSocket = app.partnerId?._id?.toString() || app.partnerId?.toString() || (app.partnerId ? String(app.partnerId) : null);
          const customerIdForSocket = app.customerId?._id?.toString() || app.customerId?.toString() || (app.customerId ? String(app.customerId) : null);
          
          console.log("🔔 RM Route: Extracted IDs for socket", {
            partnerId: partnerIdForSocket,
            customerId: customerIdForSocket,
            partnerIdType: typeof app.partnerId,
            customerIdType: typeof app.customerId,
          });
          
          await emitDocumentStatusChanged(
            io,
            app._id.toString(),
            decodedDocType,
            status,
            req.user.sub,
            partnerIdForSocket,
            customerIdForSocket,
            req.user.sub, // actionBy - who performed the action
            app // pass application object for details
          );
          
          console.log("✅ Document status socket emission completed");

          await maybeEmitApplicationStatusAfterDocWorkflow(io, app, workflowMetaPost, req.user.sub);
        } else {
          console.error("❌ Socket io instance not available (global.io is null)");
        }
      } catch (socketErr) {
        console.error("❌ Error emitting socket event:", socketErr);
        console.error("Stack:", socketErr.stack);
        // Don't fail the request if socket fails
      }

      res.json({
        message: "Document status updated successfully",
        document: app.docs[docIndex],
        applicationStatus: app.status,
        allDocumentsVerified: app.areAllDocumentsVerified(),
      });
    } catch (err) {
      console.error("Error updating document status (POST):", err);
      res.status(500).json({
        message: "Error updating document status",
        error: err.message,
      });
    }
  }
);

// Download all documents as ZIP

router.get(
  "/applications/:id/docs/:docType/download",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const { id, docType } = req.params;
      const rmId = req.user.sub;

      // Get all partners under this RM
      const partners = await User.find({ rmId, role: ROLES.PARTNER }).select("_id").lean();
      const partnerIds = partners.map(p => p._id);

      // Find application either directly assigned to RM or via partners
      const app = await Application.findOne({
        _id: id,
        $or: [
          { rmId: rmId }, // Direct RM assignment
          { partnerId: { $in: partnerIds } } // Applications from partners under this RM
        ]
      }).lean();

      if (!app) {
        return res.status(404).json({ message: "Application not found or not assigned to this RM" });
      }

      const doc = app.docs.find(
        (d) => d.docType.toUpperCase() === docType.toUpperCase()
      );
      if (!doc) {
        console.error(`Document not found: docType=${docType}, available docs:`, app.docs.map(d => d.docType));
        return res.status(404).json({ 
          message: "Document not found",
          docType: docType,
          availableDocTypes: app.docs.map(d => d.docType)
        });
      }

      if (!doc.url || doc.url.trim() === "") {
        console.error(`Document URL is empty: docType=${docType}, docId=${doc._id}`);
        return res.status(400).json({ 
          message: "Document URL is empty or invalid",
          docType: docType
        });
      }

      let filename;
      let contentType;
      const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";
      
      // Get the actual file URL (remove backend URL prefix if present)
      let actualUrl = doc.url.trim();
      if (actualUrl.startsWith(backendUrl)) {
        // Strip backend URL prefix to get the actual path
        actualUrl = actualUrl.replace(backendUrl, "").replace(/^\/+/, "");
      }
      
      console.log(`Downloading document: docType=${docType}, actualUrl=${actualUrl.substring(0, 100)}...`);

      // Check if it's a remote URL (S3, external CDN, etc.)
      if (actualUrl.startsWith("http://") || actualUrl.startsWith("https://")) {
        // 🔹 Remote URL (S3, CDN, etc.)
        try {
          const response = await axios.get(actualUrl, { 
            responseType: "stream",
            timeout: 30000, // 30 second timeout
            maxRedirects: 5
          });
          
          contentType =
            response.headers["content-type"] || "application/octet-stream";
          
          // Try to get extension from URL or Content-Type
          let ext = "";
          try {
            const urlPath = new URL(actualUrl).pathname;
            ext = path.extname(urlPath) || "";
          } catch (e) {
            // If URL parsing fails, try to infer from content-type
            if (contentType.includes("image/jpeg") || contentType.includes("image/jpg")) {
              ext = ".jpg";
            } else if (contentType.includes("image/png")) {
              ext = ".png";
            } else if (contentType.includes("application/pdf")) {
              ext = ".pdf";
            } else {
              ext = "";
            }
          }
          
          filename = `${docType}${ext}`;
          
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${filename}"`
          );
          res.setHeader("Content-Type", contentType);
          res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
          
          response.data.pipe(res);
          
          response.data.on("error", (err) => {
            console.error("Stream error:", err);
            if (!res.headersSent) {
              res.status(500).json({ message: "Error streaming document" });
            }
          });
        } catch (axiosErr) {
          console.error("Error fetching remote document:", {
            url: actualUrl.substring(0, 100),
            message: axiosErr.message,
            code: axiosErr.code,
            status: axiosErr.response?.status,
            statusText: axiosErr.response?.statusText,
          });
          if (!res.headersSent) {
            const errorMsg = axiosErr.response?.status 
              ? `Remote server returned ${axiosErr.response.status}: ${axiosErr.response.statusText || axiosErr.message}`
              : `Error downloading document from remote server: ${axiosErr.message}`;
            return res.status(500).json({ 
              message: errorMsg,
              error: axiosErr.message,
              code: axiosErr.code
            });
          }
        }
      } else {
        // 🔹 Local file
        const filePath = path.resolve(process.cwd(), actualUrl);
        
        console.log(`Checking local file: ${filePath}`);
        
        if (!fs.existsSync(filePath)) {
          console.error(`Local file not found: ${filePath}`);
          return res.status(404).json({ 
            message: "File not found on server",
            path: actualUrl,
            resolvedPath: filePath
          });
        }
        
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
          console.error(`Path is not a file: ${filePath}`);
          return res.status(404).json({ 
            message: "Path is not a file",
            path: actualUrl
          });
        }
        
        const ext = path.extname(filePath);
        filename = `${docType}${ext}`;
        contentType = mime.lookup(ext) || "application/octet-stream";

        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Length", stats.size);
        res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
        
        fileStream.on("error", (err) => {
          console.error("File stream error:", err);
          if (!res.headersSent) {
            res.status(500).json({ message: "Error reading file" });
          }
        });
      }
    } catch (err) {
      console.error("Download error:", err);
      if (!res.headersSent) {
        res.status(500).json({ 
          message: "Error downloading document",
          error: err.message 
        });
      }
    }
  }
);

// router.get(
//   "/applications/:id/docs/download-all",
//   auth,
//   requireRole(ROLES.RM),
//   async (req, res) => {
//     try {
//       const { id } = req.params;
//       const rmId = req.user.sub;

//       // Find application under this RM
//       const app = await Application.findOne({
//         _id: id,
//         rmId: rmId,
//       }).lean();

//       if (!app) {
//         return res
//           .status(404)
//           .json({ message: "Application not found under this RM" });
//       }

//       if (!app.docs || app.docs.length === 0) {
//         return res
//           .status(404)
//           .json({ message: "No documents found for this application" });
//       }

//       // Create ZIP filename based on application data
//       const zipFilename = `${app.appNo || `APP-${id.slice(-6)}`}_Documents.zip`;

//       // Set response headers for ZIP download
//       res.setHeader("Content-Type", "application/zip");
//       res.setHeader(
//         "Content-Disposition",
//         `attachment; filename="${zipFilename}"`
//       );
//       res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

//       // Create archive
//       const archive = archiver("zip", {
//         zlib: { level: 9 }, // Maximum compression
//       });

//       // Handle archive errors
//       archive.on("error", (err) => {
//         console.error("Archive error:", err);
//         if (!res.headersSent) {
//           res.status(500).json({ message: "Error creating archive" });
//         }
//       });

//       // Pipe archive to response
//       archive.pipe(res);

//       let filesAdded = 0;
//       const errors = [];

//       // Process each document
//       for (let i = 0; i < app.docs.length; i++) {
//         const doc = app.docs[i];

//         try {
//           // Use path.resolve to handle Windows paths properly
//           const filePath = path.resolve(process.cwd(), doc.url);

//           console.log(
//             `Processing document ${i + 1}/${app.docs.length}: ${doc.docType}`
//           );
//           console.log(`File path: ${filePath}`);

//           if (fs.existsSync(filePath)) {
//             const stats = fs.statSync(filePath);

//             if (stats.isFile()) {
//               // Create clean filename: docType + original extension
//               const fileExtension = path.extname(doc.url);
//               const cleanFilename = `${doc.docType}${fileExtension}`;

//               // Add file to archive
//               archive.file(filePath, { name: cleanFilename });
//               filesAdded++;

//               console.log(
//                 `✓ Added: ${cleanFilename} (${(stats.size / 1024).toFixed(
//                   1
//                 )}KB)`
//               );
//             } else {
//               errors.push(`${doc.docType}: Path exists but is not a file`);
//               console.log(`✗ ${doc.docType}: Not a file`);
//             }
//           } else {
//             errors.push(`${doc.docType}: File not found at ${doc.url}`);
//             console.log(`✗ ${doc.docType}: File not found`);
//           }
//         } catch (error) {
//           errors.push(`${doc.docType}: ${error.message}`);
//           console.error(`✗ Error processing ${doc.docType}:`, error.message);
//         }
//       }

//       // Check if any files were added
//       if (filesAdded === 0) {
//         archive.destroy();
//         return res.status(404).json({
//           message: "No valid documents found to download",
//           errors: errors,
//           totalDocs: app.docs.length,
//         });
//       }

//       // Add summary file if there were any errors
//       if (errors.length > 0) {
//         const summaryContent = [
//           `Download Summary for Application: ${app.appNo}`,
//           `Customer: ${app.customer?.name || "N/A"}`,
//           `Partner: ${app.partner?.name || "N/A"}`,
//           `Generated: ${new Date().toLocaleString()}`,
//           "",
//           `Total Documents: ${app.docs.length}`,
//           `Successfully Downloaded: ${filesAdded}`,
//           `Failed Downloads: ${errors.length}`,
//           "",
//           "Failed Downloads:",
//           ...errors.map((error, idx) => `${idx + 1}. ${error}`),
//           "",
//           "Note: Only successfully found documents are included in this ZIP file.",
//         ].join("\n");

//         archive.append(summaryContent, { name: "DOWNLOAD_SUMMARY.txt" });
//       }

//       // Finalize the archive (this triggers the download)
//       await archive.finalize();

//       console.log(
//         `✓ ZIP archive created successfully with ${filesAdded} files`
//       );
//     } catch (err) {
//       console.error("Download all documents error:", err);
//       if (!res.headersSent) {
//         res.status(500).json({ message: "Error creating document archive" });
//       }
//     }
//   }
// );

// GET /rm/profile

router.get(
  "/applications/:id/docs/download-all",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const { id } = req.params;
      const rmId = req.user.sub;

      // Get all partners under this RM
      const partners = await User.find({ 
        rmId: rmId, 
        role: ROLES.PARTNER 
      }).select("_id").lean();
      const partnerIds = partners.map(p => p._id);

      // Check if application belongs to this RM or a partner under this RM
      const app = await Application.findOne({
        _id: id,
        $or: [
          { rmId: rmId }, // Direct RM assignment
          { partnerId: { $in: partnerIds } } // Applications from partners under this RM
        ]
      }).lean();
      if (!app) {
        return res
          .status(404)
          .json({ message: "Application not found under this RM" });
      }
      if (!app.docs?.length) {
        return res.status(404).json({ message: "No documents found" });
      }

      const zipFilename = `${app.appNo || `APP-${id.slice(-6)}`}_Documents.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${zipFilename}"`
      );
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.pipe(res);

      const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";
      let filesAdded = 0;

      for (const doc of app.docs) {
        try {
          let ext;
          let cleanFilename;
          
          // Get the actual file URL (remove backend URL prefix if present)
          let actualUrl = doc.url;
          if (actualUrl.startsWith(backendUrl)) {
            actualUrl = actualUrl.replace(backendUrl, "").replace(/^\/+/, "");
          }

          if (actualUrl.startsWith("http://") || actualUrl.startsWith("https://")) {
            // 🔹 Remote fetch (S3, CDN, etc.)
            try {
              const response = await axios.get(actualUrl, { 
                responseType: "stream",
                timeout: 30000,
                maxRedirects: 5
              });
              
              try {
                const urlPath = new URL(actualUrl).pathname;
                ext = path.extname(urlPath) || "";
              } catch (e) {
                ext = "";
              }
              
              cleanFilename = `${doc.docType}${ext}`;
              archive.append(response.data, { name: cleanFilename });
              filesAdded++;
            } catch (axiosErr) {
              console.error(`Error fetching remote document ${doc.docType}:`, axiosErr.message);
            }
          } else {
            // 🔹 Local file
            const filePath = path.resolve(process.cwd(), actualUrl);
            if (fs.existsSync(filePath)) {
              const stats = fs.statSync(filePath);
              if (stats.isFile()) {
                ext = path.extname(filePath);
                cleanFilename = `${doc.docType}${ext}`;
                archive.file(filePath, { name: cleanFilename });
                filesAdded++;
              }
            } else {
              console.error(`File not found: ${actualUrl}`);
            }
          }
        } catch (error) {
          console.error(`Error processing ${doc.docType}:`, error.message);
        }
      }

      // If no files were added, return error
      if (filesAdded === 0) {
        archive.destroy();
        if (!res.headersSent) {
          return res.status(404).json({ 
            message: "No valid documents found to download" 
          });
        }
      }

      await archive.finalize();
    } catch (err) {
      console.error("Download all documents error:", err);
      if (!res.headersSent) {
        res.status(500).json({ 
          message: "Error creating document archive",
          error: err.message 
        });
      }
    }
  }
);

router.get("/profile", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rm = await User.findById(req.user.sub)
      .select("-passwordHash")
      .populate({
        path: "asmId",
        select: "firstName lastName employeeId region phone",
      })
      .populate({
        path: "personalRsmId",
        select: "firstName lastName employeeId phone email",
      })
      .populate({
        path: "businessHomeRsmId",
        select: "firstName lastName employeeId phone email",
      })
      .lean();

    if (!rm) {
      return res.status(404).json({ message: "RM not found" });
    }

    // Shareable web link: partner signup with RM code prefilled (?ref=RM-…)
    const referralLink = appendPartnerShareUtm(
      `${getReferralWebBaseUrl()}/${PARTNER_REGISTRATION_PATH_SEGMENT}?ref=${encodeURIComponent(rm.rmCode || "")}`,
      "web"
    );
    const partnerRegisterApiPath = `/api/auth/partner/register-by-rmcode?ref=${encodeURIComponent(rm.rmCode || "")}`;

    res.json({
      employeeId: rm.employeeId,
      firstName: rm.firstName,
      lastName: rm.lastName,
      email: rm.email,
      phone: rm.phone,
      dob: rm.dob,
      address: rm.address,
      experience: rm.experience,
      region: rm.region,
      status: rm.status,
      rmCode: rm.rmCode,
      JoiningDate: rm.createdAt,

      referralLink,
      /** Direct API reference only (POST JSON) — prefer sharing `referralLink` */
      partnerRegisterApiPath,

      // Flattened ASM details
      asmId: rm.asmId?._id || null,
      asmName: rm.asmId ? `${rm.asmId.firstName} ${rm.asmId.lastName}` : null,
      asmEmployeeId: rm.asmId?.employeeId || null,
      asmRegion: rm.asmId?.region || null,
      asmPhone: rm.asmId?.phone || null,

      // Flattened Personal Loan RSM details
      personalRsmId: rm.personalRsmId?._id || null,
      personalRsmName: rm.personalRsmId ? `${rm.personalRsmId.firstName} ${rm.personalRsmId.lastName}` : null,
      personalRsmEmployeeId: rm.personalRsmId?.employeeId || null,
      personalRsmPhone: rm.personalRsmId?.phone || null,
      personalRsmEmail: rm.personalRsmId?.email || null,

      // Flattened Business & Home Loan RSM details
      businessHomeRsmId: rm.businessHomeRsmId?._id || null,
      businessHomeRsmName: rm.businessHomeRsmId ? `${rm.businessHomeRsmId.firstName} ${rm.businessHomeRsmId.lastName}` : null,
      businessHomeRsmEmployeeId: rm.businessHomeRsmId?.employeeId || null,
      businessHomeRsmPhone: rm.businessHomeRsmId?.phone || null,
      businessHomeRsmEmail: rm.businessHomeRsmId?.email || null,
    });
  } catch (err) {
    console.error("Error fetching RM profile:", err);
    res.status(500).json({ message: err.message });
  }
});

// PATCH /rm/profile/update
router.patch(
  "/profile/update",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub; // RM id from token

      const {
        firstName,
        lastName,
        currentEmail,
        currentPassword,
        email,
        phone,
        dob,
        address,
        experience,
        region,
        bankName,
        accountNumber,
        ifscCode,
        accountHolderName,
      } = req.body;

      const updateData = {
        firstName,
        lastName,
        phone,
        dob,
        address,
        experience,
        region,
        bankName,
        accountNumber,
        ifscCode,
        accountHolderName,
      };

      // Remove undefined values
      Object.keys(updateData).forEach(
        (key) => updateData[key] === undefined && delete updateData[key]
      );

      const updatedRm = await User.findOneAndUpdate(
        { _id: rmId, role: ROLES.RM },
        { $set: updateData },
        { new: true, runValidators: true, projection: "-passwordHash" }
      );

      if (!updatedRm) return res.status(404).json({ message: "RM not found" });

      let emailChangePending = false;
      let emailChangeMessage = null;

      if (
        email &&
        String(email).toLowerCase() !== String(updatedRm.email).toLowerCase()
      ) {
        const normalizedEmail = String(email).toLowerCase();
        const exists = await User.findOne({
          email: normalizedEmail,
          _id: { $ne: rmId },
        });
        if (exists) {
          return res.status(409).json({ message: "Email already in use" });
        }
        const current = await User.findById(rmId).select("email firstName passwordHash");
        if (!currentPassword) {
          return res.status(400).json({ message: "Current password is required for email change." });
        }
        const passOk = await argon2.verify(current.passwordHash, String(currentPassword));
        if (!passOk) {
          return res.status(400).json({ message: "Current password is incorrect." });
        }
        if (
          currentEmail &&
          String(currentEmail).toLowerCase().trim() !== String(current.email).toLowerCase().trim()
        ) {
          return res.status(400).json({ message: "Current email does not match your active email." });
        }
        await createEmailChangeRequest({
          user: current,
          currentEmail: current.email,
          newEmail: normalizedEmail,
          clientUrl: process.env.CLIENT_URL,
        });
        emailChangePending = true;
        emailChangeMessage =
          "Email change link sent. Please confirm via the link in your inbox.";
      }

      const profileObj = updatedRm?.toObject ? updatedRm.toObject() : updatedRm;
      if (emailChangePending) {
        profileObj.emailChangePending = true;
        profileObj.emailChangeMessage = emailChangeMessage;
      }

      res.json({
        message: emailChangePending ? emailChangeMessage : "Profile updated successfully",
        profile: profileObj,
        emailChangePending,
      });
    } catch (err) {
      console.error("Error updating RM profile:", err);
      res.status(500).json({ message: err.message });
    }
  }
);

// ================== PARTNER TARGET ASSIGNMENT (REMOVED - ASM Only) ==================
// RM cannot assign partner targets - only ASM can assign partner targets
// RM can only view/monitor partner targets and follow up with partners
// This endpoint has been removed to match industry standards where ASM sets partner targets

// GET /api/rm/partner/:partnerId/analytics
// RM views analytics for a specific Partner (Hierarchical Access - RM can only see Partners)
router.get("/partner/:partnerId/analytics", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub;
    const { partnerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(partnerId)) {
      return res.status(400).json({ message: "Invalid partner ID" });
    }

    // Verify Partner belongs to this RM (Hierarchical Access Control)
    const partner = await User.findOne({
      _id: partnerId,
      rmId: rmId,
      role: ROLES.PARTNER
    }).lean();

    if (!partner) {
      return res.status(404).json({ message: "Partner not found or not under this RM" });
    }

    // Helper functions
    const sumDisbursedBy = async (filter) => {
      const agg = await Application.aggregate([
        { $match: { ...filter, status: "DISBURSED" } },
        {
          $group: {
            _id: null,
            total: { $sum: { $toDouble: "$approvedLoanAmount" } },
          },
        },
      ]);
      return agg.length > 0 ? Number(agg[0].total) : 0;
    };

    const getAssignedTarget = async (userId, role) => {
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();
      const t = await Target.findOne({
        assignedTo: userId,
        role,
        month: currentMonth,
        year: currentYear,
      });
      return t ? Number(t.targetValue) : 0;
    };

    // Base profile
    const base = {
      userId: partner._id,
      name: `${partner.firstName} ${partner.lastName}`,
      role: partner.role,
      email: partner.email,
      phone: partner.phone,
      employeeId: partner.employeeId || null,
      dob: partner.dob || null,
      address: partner.address || null,
      experience: partner.experience || null,
      region: partner.region || null,
      partnerCode: partner.partnerCode || null,
      status: partner.status,
      createdAt: partner.createdAt,
      updatedAt: partner.updatedAt,
    };

    let totals = {};
    let totalDisbursed = 0;
    let performance = "0.00";
    let assignedTargetValue = 0;
    let scope = ROLES.PARTNER;

    // ================= PARTNER ANALYTICS ONLY =================
    // RM can only view Partner analytics (hierarchical access - RM → Partner)
    const customers = await Application.distinct("customerId", {
      partnerId: partnerId,
    });

    totalDisbursed = await sumDisbursedBy({ partnerId: partnerId });
    assignedTargetValue = await getAssignedTarget(partnerId, ROLES.PARTNER);

    performance =
      assignedTargetValue > 0
        ? ((totalDisbursed / assignedTargetValue) * 100).toFixed(2)
        : "0.00";

    totals = { customers: customers.length };

    // ============== RESPONSE - Match Admin Analytics format =================
    return res.json({
      profile: base,
      analytics: {
        scope,
        totals,
        assignedTarget: {
          targetValue: assignedTargetValue,
          achievedValue: totalDisbursed
        },
        totalDisbursed,
        performance: `${performance}%`,
      },
    });
  } catch (err) {
    console.error("Universal analytics error:", err);
    res.status(500).json({ message: "Failed to fetch analytics" });
  }
});

// Payout endpoints moved to ASM and Admin routes


// router.get(
//   "/partner-reports",
//   auth,
//   requireRole(ROLES.RM),
//   async (req, res) => {
//     try {
//       const rmId = req.user.sub;

//       // Fetch partners under RM
//       const partners = await User.find({ rmId, role: ROLES.PARTNER }).lean();

//       const now = new Date();
//       const month = now.getMonth() + 1;
//       const year = now.getFullYear();

//       const partnerReports = await Promise.all(
//         partners.map(async (p) => {
//           // Count applications by status
//           const totalApplications = await Application.countDocuments({
//             partnerId: p._id,
//           });
//           const approvedCount = await Application.countDocuments({
//             partnerId: p._id,
//             status: "APPROVED",
//           });
//           const disbursedCount = await Application.countDocuments({
//             partnerId: p._id,
//             status: "DISBURSED",
//           });
//           const rejectedCount = await Application.countDocuments({
//             partnerId: p._id,
//             status: "REJECTED",
//           });

//           // Revenue: sum of approvedLoanAmount for disbursed applications
//           const revenueAgg = await Application.aggregate([
//             { $match: { partnerId: p._id, status: "DISBURSED" } },
//             {
//               $group: {
//                 _id: null,
//                 totalRevenue: { $sum: { $toDouble: "$approvedLoanAmount" } },
//               },
//             },
//           ]);
//           const revenue =
//             revenueAgg.length > 0 ? Number(revenueAgg[0].totalRevenue) : 0;

//           // Target assigned this month
//           const targetDoc = await Target.findOne({
//             assignedTo: p._id,
//             role: ROLES.PARTNER,
//             month,
//             year,
//           });
//           const targetValue = targetDoc ? Number(targetDoc.targetValue) : 0;

//           // Target achieved % based on revenue vs target
//           const targetAchievedPercent =
//             targetValue > 0
//               ? Math.min(100, ((revenue / targetValue) * 100).toFixed(0))
//               : 0;

//           // Target achieved in rupees (actual revenue contributed to target)
//           const targetAchievedAmount = Math.min(revenue, targetValue);

//           // Closed deals = number of disbursed applications (not %)
//           const closedDeals = disbursedCount;

//           return {
//             id: p._id,
//             name: `${p.firstName} ${p.lastName}`,
//             totalApplications,
//             approved: approvedCount,
//             disbursed: disbursedCount,
//             rejected: rejectedCount,
//             revenue, // total revenue from disbursed loans
//             targetValue,
//             targetAchievedPercent,
//             targetAchievedAmount,
//             closedDeals, // ✅ now showing as a count
//           };
//         })
//       );

//       res.json({ success: true, data: partnerReports });
//     } catch (err) {
//       console.error("Partner reports error:", err);
//       res
//         .status(500)
//         .json({ success: false, message: "Failed to fetch partner reports" });
//     }
//   }
// );

// router.get("/partner-reports", auth, requireRole(ROLES.RM), async (req, res) => {
//   try {
//     const rmId = req.user.sub;

//     // Fetch partners under RM
//     const partners = await User.find({ rmId, role: ROLES.PARTNER }).lean();
//     const now = new Date();
//     const month = now.getMonth() + 1;
//     const year = now.getFullYear();

//     // Fetch RM's target for this month
//     const rmTargetDoc = await Target.findOne({
//       assignedTo: rmId,
//       role: ROLES.RM,
//       month,
//       year,
//     });
//     const rmMonthlyTarget = rmTargetDoc ? Number(rmTargetDoc.targetValue) : 0;

//     const partnerReports = await Promise.all(
//       partners.map(async (p) => {
//         // Count applications by status
//         const totalApplications = await Application.countDocuments({ partnerId: p._id });
//         const approvedCount = await Application.countDocuments({ partnerId: p._id, status: "APPROVED" });
//         const disbursedCount = await Application.countDocuments({ partnerId: p._id, status: "DISBURSED" });
//         const rejectedCount = await Application.countDocuments({ partnerId: p._id, status: "REJECTED" });

//         // Revenue: sum of approvedLoanAmount for disbursed applications
//         const revenueAgg = await Application.aggregate([
//           { $match: { partnerId: p._id, status: "DISBURSED" } },
//           { $group: { _id: null, totalRevenue: { $sum: { $toDouble: "$approvedLoanAmount" } } } },
//         ]);
//         const revenue = revenueAgg.length > 0 ? Number(revenueAgg[0].totalRevenue) : 0;

//         // Assign monthly target proportionally to partner
//         const targetValue = partners.length > 0 ? Number((rmMonthlyTarget / partners.length).toFixed(2)) : 0;

//         // Target achieved % based on revenue vs target
//         const targetAchievedPercent = targetValue > 0 ? Math.min(100, ((revenue / targetValue) * 100).toFixed(0)) : 0;

//         // Target achieved amount
//         const targetAchievedAmount = Math.min(revenue, targetValue);

//         // Closed deals = number of disbursed applications
//         const closedDeals = disbursedCount;

//         return {
//           id: p._id,
//           name: `${p.firstName} ${p.lastName}`,
//           totalApplications,
//           approved: approvedCount,
//           disbursed: disbursedCount,
//           rejected: rejectedCount,
//           revenue,
//           targetValue,
//           targetAchievedPercent,
//           targetAchievedAmount,
//           closedDeals,
//         };
//       })
//     );

//     res.json({ success: true, data: partnerReports });
//   } catch (err) {
//     console.error("Partner reports error:", err);
//     res.status(500).json({ success: false, message: "Failed to fetch partner reports" });
//   }
// });


router.get("/partner-reports", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub;

    // Fetch partners under RM
    const partners = await User.find({ rmId, role: ROLES.PARTNER }).lean();
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    // Fetch RM's monthly target
    const rmTargetDoc = await Target.findOne({
      assignedTo: rmId,
      role: ROLES.RM,
      month,
      year,
    });
    const rmMonthlyTarget = rmTargetDoc ? Number(rmTargetDoc.targetValue) : 0;

    // Fetch all partner targets for this RM
    const partnerTargetDocs = await Target.find({
      assignedTo: { $in: partners.map(p => p._id) },
      role: ROLES.PARTNER,
      month,
      year,
    });

    const partnerReports = await Promise.all(
      partners.map(async (p) => {
        // Count applications by status
        const totalApplications = await Application.countDocuments({ partnerId: p._id });
        const approvedCount = await Application.countDocuments({ partnerId: p._id, status: "APPROVED" });
        const disbursedCount = await Application.countDocuments({ partnerId: p._id, status: "DISBURSED" });
        const rejectedCount = await Application.countDocuments({ partnerId: p._id, status: "REJECTED" });

        // Revenue: sum of approvedLoanAmount for disbursed applications
        const revenueAgg = await Application.aggregate([
          { $match: { partnerId: p._id, status: "DISBURSED" } },
          { $group: { _id: null, totalRevenue: { $sum: { $toDouble: "$approvedLoanAmount" } } } },
        ]);
        const revenue = revenueAgg.length > 0 ? Number(revenueAgg[0].totalRevenue) : 0;

        // Partner target: use assigned target if exists, otherwise assign proportion of RM target
        const partnerTargetDoc = partnerTargetDocs.find(t => t.assignedTo.toString() === p._id.toString());
        const targetValue = partnerTargetDoc
          ? Number(partnerTargetDoc.targetValue)
          : partners.length > 0
          ? Number((rmMonthlyTarget / partners.length).toFixed(2))
          : 0;

        // Target achieved
        const targetAchievedPercent = targetValue > 0
          ? Math.min(100, ((revenue / targetValue) * 100).toFixed(0))
          : 0;

        const targetAchievedAmount = Math.min(revenue, targetValue);

        return {
          id: p._id,
          name: `${p.firstName} ${p.lastName}`,
          totalApplications,
          approved: approvedCount,
          disbursed: disbursedCount,
          rejected: rejectedCount,
          revenue,
          targetValue,
          targetAchievedPercent,
          targetAchievedAmount,
          closedDeals: disbursedCount,
        };
      })
    );

    res.json({ success: true, data: partnerReports });
  } catch (err) {
    console.error("Partner reports error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch partner reports" });
  }
});


// ==================== PARTNER TARGET MANAGEMENT (RM) ====================

// GET /api/rm/partners/targets
// RM gets all partner targets under their hierarchy
router.get("/partners/targets", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub;
    const { year, month } = req.query;

    // Get all partners under this RM
    const partners = await User.find({
      role: ROLES.PARTNER,
      rmId: rmId,
    }).select("firstName lastName employeeId email phone rmId").lean();

    const partnerIds = partners.map((p) => p._id);

    // Build date filter
    const dateFilter = {};
    if (year && month) {
      dateFilter.month = Number(month);
      dateFilter.year = Number(year);
    }

    // Get targets for these partners
    const targets = await Target.find({
      assignedTo: { $in: partnerIds },
      role: ROLES.PARTNER,
      ...dateFilter,
    }).lean();

    // Get relevant applications for achievement calculation
    const relevantApps = await Application.find({
      partnerId: { $in: partnerIds },
      status: { $ne: "DRAFT" },
      ...(year && month ? {
        updatedAt: {
          $gte: new Date(year, month - 1, 1),
          $lt: new Date(year, month, 1)
        }
      } : {})
    }).lean();

    // Combine partner data with targets and achievements
    const partnerTargets = partners.map((partner) => {
      const target = targets.find(
        (t) => t.assignedTo.toString() === partner._id.toString()
      );
      const partnerApps = relevantApps.filter(
        (app) => app.partnerId.toString() === partner._id.toString()
      );

      const fileCountTarget = target?.fileCountTarget || 4;
      const disbursementTarget = target?.disbursementTarget || 2000000;
      const achievedFileCount = partnerApps.length;
      const achievedDisbursement = partnerApps
        .filter(app => app.status === "DISBURSED")
        .reduce(
          (sum, app) => sum + (parseFloat(app.approvedLoanAmount) || 0),
          0
        );

      return {
        partnerId: partner._id,
        partnerName: `${partner.firstName} ${partner.lastName}`,
        partnerEmployeeId: partner.employeeId,
        partnerEmail: partner.email,
        partnerPhone: partner.phone,
        rmId: partner.rmId,
        month: target?.month || (month ? Number(month) : new Date().getMonth() + 1),
        year: target?.year || (year ? Number(year) : new Date().getFullYear()),
        fileCountTarget,
        achievedFileCount,
        disbursementTarget,
        achievedDisbursement,
        fileTargetMet: achievedFileCount >= fileCountTarget,
        disbursementTargetMet: achievedDisbursement >= disbursementTarget,
        targetAchieved: achievedFileCount >= fileCountTarget && achievedDisbursement >= disbursementTarget,
        hasTarget: !!target,
      };
    });

    res.json(partnerTargets);
  } catch (err) {
    console.error("Error fetching partner targets:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

export default router;
