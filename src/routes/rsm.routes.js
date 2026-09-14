import { Router } from "express";
import argon2 from "argon2";
import mongoose from "mongoose";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES, RSM_TYPES } from "../config/roles.js";
import { User } from "../models/User.js";
import { Application, APP_STATUSES } from "../models/Application.js";
import { BankMaster } from "../models/BankMaster.js";
import { BankRm } from "../models/BankRm.js";
import { Payout } from "../models/Payout.js";
import { Incentive } from "../models/Incentive.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { sendUserAccountEmail, sendApplicationStatusEmail } from "../utils/emailService.js";
import { sendMail } from "../utils/sendMail.js";
import { createEmailChangeRequest } from "../utils/emailChangeService.js";
import { emitApplicationStatusChanged } from "../utils/socketEmitter.js";
import { activeApplicationsFilter } from "../utils/activeApplicationsFilter.js";
import { makeRmCode } from "../utils/codes.js";
import { Target } from "../models/Target.js";
import fs from "fs";
import path from "path";
import mime from "mime-types";
import axios from "axios";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3, BUCKET_NAME } from "../config/s3.js";
import { extractS3KeyFromUrl } from "../utils/docUploadLimits.js";
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
  reassignRmWorkload,
  reassignPartnerWorkload,
} from "../utils/safeTransfer.js";
import {
  deriveCurrentTargetContext,
  rebalanceHierarchyTargetsReplace,
} from "../utils/targetRebalanceService.js";
import {
  normalizeRsmTypeValue,
  rmReportingLineMatch,
} from "../utils/rmRsmHierarchy.js";
import { activeUsersFilter } from "../utils/activeUsersFilter.js";
import {
  parseFollowUpPeriod,
  latestFollowUpsByTargets,
  applicationCountsByRm,
  partnerFillStatsByRm,
  formatFollowUpLastCall,
  buildRmFollowUpSummary,
  isValidFollowUpStatus,
} from "../utils/followUpHelpers.js";
import { FollowUp } from "../models/followUp.js";

const router = Router();

// --- RSM visibility: normalize profile + align loan types with PERSONAL vs BUSINESS_HOME ---

function toObjectId(id) {
  try {
    return mongoose.Types.ObjectId.isValid(String(id))
      ? new mongoose.Types.ObjectId(String(id))
      : id;
  } catch {
    return id;
  }
}

/** RMs on this RSM's reporting line only (personal slot vs business/home slot). */
async function loadRsmReportingScope(rsmId) {
  const rsm = await User.findById(rsmId).select("role rsmType asmType").lean();
  if (rsm?.role === ROLES.RSM) {
    return { $or: [{ rsmId: toObjectId(rsmId) }, { asmId: toObjectId(rsmId) }] };
  }
  return rmReportingLineMatch(rsmId, normalizeRsmTypeValue(rsm?.rsmType || rsm?.asmType));
}

function loanTypeMatchesRsmRole(loanType, rsmTypeNorm) {
  if (!rsmTypeNorm) return true;
  if (rsmTypeNorm === RSM_TYPES.PERSONAL) return loanType === "PERSONAL";
  if (rsmTypeNorm === RSM_TYPES.BUSINESS) return loanType === "BUSINESS";
  if (rsmTypeNorm === RSM_TYPES.HOME_LAP) {
    return ["HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED", "LAP_SALARIED", "LAP_SELF_EMPLOYED", "LAP"].includes(loanType);
  }
  if (rsmTypeNorm === RSM_TYPES.BUSINESS_HOME) {
    return ["BUSINESS", "HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED", "LAP_SALARIED", "LAP_SELF_EMPLOYED", "LAP"].includes(loanType);
  }
  return true;
}

function loanTypeFilterForRsmType(rsmTypeNorm) {
  if (rsmTypeNorm === RSM_TYPES.PERSONAL) return { loanType: "PERSONAL" };
  if (rsmTypeNorm === RSM_TYPES.BUSINESS) return { loanType: "BUSINESS" };
  if (rsmTypeNorm === RSM_TYPES.HOME_LAP) {
    return {
      loanType: { $in: ["HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED", "LAP_SALARIED", "LAP_SELF_EMPLOYED", "LAP"] },
    };
  }
  if (rsmTypeNorm === RSM_TYPES.BUSINESS_HOME) {
    return {
      loanType: { $in: ["BUSINESS", "HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED", "LAP_SALARIED", "LAP_SELF_EMPLOYED", "LAP"] },
    };
  }
  return {};
}

async function eligibleRmIdsForRsmHierarchy(rsmObjectId, rsmTypeNorm) {
  const base = { role: ROLES.RM };
  if (rsmTypeNorm === RSM_TYPES.PERSONAL) {
    return User.find({ ...base, $or: [{ personalAsmId: rsmObjectId }, { personalRsmId: rsmObjectId }] }).distinct("_id");
  }
  if (rsmTypeNorm === RSM_TYPES.BUSINESS) {
    return User.find({
      ...base,
      $or: [
        { businessAsmId: rsmObjectId },
        { businessRsmId: rsmObjectId },
        { businessHomeRsmId: rsmObjectId },
        { businessHomeAsmId: rsmObjectId },
      ],
    }).distinct("_id");
  }
  if (rsmTypeNorm === RSM_TYPES.HOME_LAP) {
    return User.find({
      ...base,
      $or: [
        { homeLapAsmId: rsmObjectId },
        { homeLapRsmId: rsmObjectId },
        { businessHomeRsmId: rsmObjectId },
        { businessHomeAsmId: rsmObjectId },
      ],
    }).distinct("_id");
  }
  if (rsmTypeNorm === RSM_TYPES.BUSINESS_HOME) {
    return User.find({
      ...base,
      $or: [
        { businessHomeAsmId: rsmObjectId },
        { businessHomeRsmId: rsmObjectId },
        { businessAsmId: rsmObjectId },
        { businessRsmId: rsmObjectId },
        { homeLapAsmId: rsmObjectId },
        { homeLapRsmId: rsmObjectId },
      ],
    }).distinct("_id");
  }
  return User.find({
    ...base,
    $or: [
      { personalAsmId: rsmObjectId },
      { personalRsmId: rsmObjectId },
      { businessAsmId: rsmObjectId },
      { businessRsmId: rsmObjectId },
      { homeLapAsmId: rsmObjectId },
      { homeLapRsmId: rsmObjectId },
      { businessHomeRsmId: rsmObjectId },
      { businessHomeAsmId: rsmObjectId },
      { asmId: rsmObjectId },
      { rsmId: rsmObjectId },
    ],
  }).distinct("_id");
}

const RSM_ALLOWED_STATUSES = [
  "DOC_COMPLETE",
  "LOGIN",
  "UNDER_REVIEW",
  "APPROVED",
  "AGREEMENT",
  "DISBURSED",
  "REJECTED",
];

function expectedRsmIdForApplication(app) {
  const rm = app.rmId;
  if (!rm) return null;
  if (app.loanType === "PERSONAL") return rm.personalAsmId || rm.personalRsmId || null;
  if (app.loanType === "BUSINESS") return rm.businessAsmId || rm.businessHomeAsmId || rm.businessRsmId || rm.businessHomeRsmId || null;
  if (
    ["HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED", "LAP_SALARIED", "LAP_SELF_EMPLOYED", "LAP"].includes(
      app.loanType
    )
  ) {
    return rm.homeLapAsmId || rm.businessHomeAsmId || rm.homeLapRsmId || rm.businessHomeRsmId || null;
  }
  return null;
}

/**
 * Fix application routing: set asmId/rsmId when missing or wrong.
 * Only applies to applications where documents have been completed by RM (DOC_COMPLETE and subsequent stages).
 */
async function repairDocCompleteRoutingForRsm(rsmUserId) {
  const rsmObjectId = toObjectId(rsmUserId);
  const rsm = await User.findById(rsmUserId).select("asmType rsmType rsmId asmId").lean();
  if (!rsm) return;

  const rsmTypeNorm = normalizeRsmTypeValue(rsm.asmType || rsm.rsmType);
  const loanFilter = loanTypeFilterForRsmType(rsmTypeNorm);
  const eligibleRmIds = await eligibleRmIdsForRsmHierarchy(rsmObjectId, rsmTypeNorm);
  if (!eligibleRmIds.length) return;

  const candidates = await Application.find({
    rmId: { $in: eligibleRmIds },
    status: { $in: RSM_ALLOWED_STATUSES },
    ...loanFilter,
  })
    .select("_id appNo asmId rsmId rmId loanType status")
    .populate("rmId", "personalAsmId businessAsmId homeLapAsmId personalRsmId businessRsmId homeLapRsmId businessHomeRsmId")
    .lean();

  const me = rsmObjectId.toString();

  for (const row of candidates) {
    const appLike = { ...row, rmId: row.rmId };
    const expected = expectedRsmIdForApplication(appLike);
    if (!expected || expected.toString() !== me) continue;

    const cur = row.asmId ? row.asmId.toString() : (row.rsmId ? row.rsmId.toString() : null);
    if (cur === me) continue;

    await Application.updateOne(
      { _id: row._id },
      { $set: { asmId: rsmObjectId, rsmId: rsm.rsmId || rsm.asmId || null } }
    );
  }
}

/**
 * Load application for detail/doc download: trust rsmId if already this RSM; else allow
 * when RM mapping says this RSM owns the loan type, and fix routing in DB.
 * Only allows access if the application has completed document stage (DOC_COMPLETE or beyond).
 */
async function loadApplicationForRsm(applicationId, rsmUserId) {
  const rsmObjectId = toObjectId(rsmUserId);
  const rsmProfile = await User.findById(rsmUserId).select("asmType rsmType rsmId asmId").lean();
  if (!rsmProfile) return null;

  const rsmTypeNorm = normalizeRsmTypeValue(rsmProfile.asmType || rsmProfile.rsmType);
  const app = await Application.findById(applicationId).populate(
    "rmId",
    "personalAsmId businessAsmId homeLapAsmId personalRsmId businessRsmId homeLapRsmId businessHomeRsmId"
  );
  if (!app || !app.rmId) return null;

  // RSM/ASM can ONLY access applications that are at DOC_COMPLETE or beyond
  if (!RSM_ALLOWED_STATUSES.includes(app.status)) {
    return null;
  }

  if (!loanTypeMatchesRsmRole(app.loanType, rsmTypeNorm)) return null;

  const meStr = rsmObjectId.toString();
  const assignedStr = app.asmId ? app.asmId.toString() : (app.rsmId ? app.rsmId.toString() : null);

  if (assignedStr === meStr) {
    return app;
  }

  const expected = expectedRsmIdForApplication(app);
  const mappingSaysUs = expected?.toString() === meStr;

  if (mappingSaysUs) {
    app.asmId = rsmObjectId;
    app.rsmId = rsmProfile.rsmId || rsmProfile.asmId || null;
    await app.save();
    return app;
  }

  return null;
}

// GET /api/rsm/my-rsms  (or /my-asms)
// List subordinate specialized ASMs under the logged-in Senior RSM
router.get(["/my-rsms", "/my-asms"], auth, requireRole(ROLES.RSM, ROLES.ASM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const managerId = req.user.sub;
    let filter;

    if (req.user.role === ROLES.SUPER_ADMIN || req.user.role === ROLES.ADMIN) {
      filter = { role: ROLES.ASM, status: "ACTIVE" };
    } else {
      filter = {
        role: ROLES.ASM,
        status: "ACTIVE",
        $or: [{ rsmId: managerId }, { asmId: managerId }],
      };
    }

    const list = await User.find(activeUsersFilter(filter))
      .select("-passwordHash -__v")
      .lean();

    const formatted = list.map((s) => ({
      ...s,
      asmType: s.asmType || s.rsmType || null,
      rsmType: s.asmType || s.rsmType || null,
      asmId: s.rsmId || s.asmId || null,
      rsmId: s.rsmId || s.asmId || null,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching ASMs for RSM:", err);
    res.status(500).json({ message: "Error fetching ASMs" });
  }
});

// POST /api/rsm/create-rm
// RSM creates an RM and assigns them to Personal or Business/Home RSM type
router.post(
  "/create-rm",
  auth,
  requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { firstName, lastName, phone, dob, joinDate, region, email, password, assignToRsmType } = req.body || {};
      const rsmId = req.user.sub; // RSM creating the RM

      if (!firstName || !lastName || !email || !phone) {
        return res.status(400).json({ message: "firstName, lastName, email, phone are required" });
      }

      // Validate assignToRsmType
      if (!assignToRsmType || !Object.values(RSM_TYPES).includes(assignToRsmType)) {
        return res.status(400).json({
          message: `assignToRsmType is required and must be one of: ${Object.values(RSM_TYPES).join(", ")}`
        });
      }

      // Get the RSM creating the RM to verify their type
      const rsm = await User.findById(rsmId).select("rsmType asmId");
      if (!rsm) {
        return res.status(404).json({ message: "RSM not found" });
      }

      // Verify RSM type matches (RSM Personal can only assign to Personal, etc.)
      if (rsm.rsmType !== assignToRsmType) {
        return res.status(403).json({
          message: `RSM type mismatch. Your RSM type is ${rsm.rsmType}, but you're trying to assign RM to ${assignToRsmType}`
        });
      }

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

      const rawPassword = password || `Rm@${Math.random().toString(36).slice(2, 10)}`;

      // Determine which RSM field to set based on assignToRsmType
      const rmData = {
        employeeId: await generateEmployeeId("RM"),
        firstName,
        lastName,
        phone,
        dob,
        joinDate: joinDate ? new Date(joinDate) : new Date(),
        region,
        email: email.toLowerCase(),
        passwordHash: await argon2.hash(rawPassword),
        role: ROLES.RM,
        rmCode: makeRmCode(),
      };

      // Set the appropriate RSM link based on type
      if (assignToRsmType === RSM_TYPES.PERSONAL) {
        rmData.personalRsmId = rsmId;
      } else if (assignToRsmType === RSM_TYPES.BUSINESS) {
        rmData.businessRsmId = rsmId;
        rmData.businessHomeRsmId = rsmId; // backward-compatibility
      } else if (assignToRsmType === RSM_TYPES.HOME_LAP) {
        rmData.homeLapRsmId = rsmId;
        rmData.businessHomeRsmId = rsmId; // backward-compatibility
      } else if (assignToRsmType === RSM_TYPES.BUSINESS_HOME) {
        rmData.businessHomeRsmId = rsmId;
        rmData.businessRsmId = rsmId;
        rmData.homeLapRsmId = rsmId;
      }

      // Also set asmId for convenience (inherited from RSM)
      rmData.asmId = rsm.asmId;

      const rm = await User.create(rmData);

      // 📧 Send mail to RM after creation
      try {
        const emailSent = await sendUserAccountEmail(
          rm,
          "RM",
          password ? null : rawPassword,
          {
            firstName: rsm.firstName || "RSM",
            lastName: rsm.lastName || "",
          }
        );
        if (emailSent) {
          console.log(`✅ RM creation email sent to: ${rm.email}`);
        }
      } catch (mailErr) {
        console.error("❌ Failed to send RM creation email:", mailErr.message);
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

      return res.status(201).json({
        message: "RM created successfully",
        id: rm._id,
        rmCode: rm.rmCode,
        employeeId: rm.employeeId,
        personalRsmId: rm.personalRsmId,
        businessRsmId: rm.businessRsmId,
        homeLapRsmId: rm.homeLapRsmId,
        businessHomeRsmId: rm.businessHomeRsmId,
        tempPassword: password ? undefined : rawPassword,
      });
    } catch (err) {
      console.error("Error creating RM:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// GET /api/rsm/my-rms
// RMs reporting to this Senior RSM or specialized ASM
router.get("/my-rms", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const scope = await loadRsmReportingScope(rsmId);

    const rms = await User.find(
      activeUsersFilter({
        role: ROLES.RM,
        status: "ACTIVE",
        ...scope,
      })
    )
      .select("-passwordHash -__v")
      .populate("personalAsmId", "firstName lastName employeeId asmType phone email")
      .populate("businessAsmId", "firstName lastName employeeId asmType phone email")
      .populate("homeLapAsmId", "firstName lastName employeeId asmType phone email")
      .populate("rsmId", "firstName lastName employeeId phone email")
      .lean();

    res.json(rms);
  } catch (err) {
    console.error("Error fetching RMs for RSM:", err);
    res.status(500).json({ message: "Error fetching RMs" });
  }
});

/**
 * RSM LOAN PROCESSING ROUTES
 * ---------------------------------
 * RSM handles loan processing statuses: UNDER_REVIEW → APPROVED/REJECTED → AGREEMENT → DISBURSED
 * Reject is allowed until DISBURSED (from UNDER_REVIEW, APPROVED, AGREEMENT).
 */

// POST /api/rsm/applications/:id/transition
// RSM transitions loan applications through processing stages
router.post(
  "/applications/:id/transition",
  auth,
  requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { to, note, approvedLoanAmount } = req.body;
      const rsmId = req.user.sub;

      if (!to)
        return res.status(400).json({ message: "Target status 'to' required" });

      // ✅ RSM can handle processing statuses as well as unblocking/reverting to DOC_INCOMPLETE for RM
      const RSM_ALLOWED_STATUSES = [
        "LOGIN",
        "UNDER_REVIEW",
        "APPROVED",
        "AGREEMENT",
        "REJECTED",
        "DISBURSED",
        "DOC_INCOMPLETE"
      ];

      if (!RSM_ALLOWED_STATUSES.includes(to)) {
        return res.status(403).json({
          message: `RSM can only transition to statuses: ${RSM_ALLOWED_STATUSES.join(", ")}.`
        });
      }

      if (!APP_STATUSES.includes(to))
        return res.status(400).json({ message: "Invalid status" });

      await repairDocCompleteRoutingForRsm(rsmId);

      // Find application assigned to this RSM
      const app = await Application.findOne({
        _id: req.params.id,
        rsmId: rsmId,
      })
        .populate("customerId")
        .populate("rmId", "firstName lastName employeeId")
        .populate("partnerId", "firstName lastName employeeId");

      if (!app)
        return res
          .status(404)
          .json({ message: "Application not found under this RSM" });

      // Validate status transition is allowed from current status
      const currentStatus = app.status;
      const allowedTransitions = {
        // After RM marks DOC_COMPLETE, RSM can move to LOGIN or send back to DOC_INCOMPLETE
        DOC_COMPLETE: ["LOGIN", "DOC_INCOMPLETE"],
        LOGIN: ["UNDER_REVIEW", "DOC_INCOMPLETE"],
        UNDER_REVIEW: ["APPROVED", "REJECTED", "DOC_INCOMPLETE"],
        APPROVED: ["AGREEMENT", "DISBURSED", "DOC_INCOMPLETE", "REJECTED"],
        AGREEMENT: ["DISBURSED", "DOC_INCOMPLETE", "REJECTED"],
        REJECTED: ["DOC_INCOMPLETE"],
      };

      if (!allowedTransitions[currentStatus]?.includes(to)) {
        return res.status(400).json({
          message: `Cannot transition from ${currentStatus} to ${to}. Allowed transitions: ${allowedTransitions[currentStatus]?.join(", ") || "none"
            }`,
        });
      }

      if (currentStatus === "DISBURSED") {
        return res.status(400).json({
          message: "Cannot reject or change status after DISBURSED.",
        });
      }

      if (to === "REJECTED" && (!note || !String(note).trim())) {
        return res.status(400).json({
          message: "A remark/reason is required to reject this application.",
        });
      }

      // ✅ Set approvedLoanAmount for DISBURSED
      // When moving to APPROVED, approvedLoanAmount is REQUIRED
      if (to === "APPROVED") {
        if (approvedLoanAmount == null || isNaN(Number(approvedLoanAmount))) {
          return res.status(400).json({
            message: "approvedLoanAmount is required and must be a number for APPROVED status",
          });
        }
        app.approvedLoanAmount = Number(approvedLoanAmount);
      }

      // When moving to DISBURSED, we keep existing approvedLoanAmount.
      // If frontend still sends a value, we accept it and overwrite.
      if (to === "DISBURSED" && approvedLoanAmount != null && !isNaN(Number(approvedLoanAmount))) {
        app.approvedLoanAmount = Number(approvedLoanAmount);
      }

      // Store old status before transition
      const oldStatus = app.status;

      // Transition
      app.transition(to, rsmId, note);

      // Persist rejection remark on the application so partners can see it in app/web
      if (to === "REJECTED" && note && String(note).trim()) {
        app.remarks = String(note).trim();
      }

      // ✅ Auto-update document statuses based on application status change
      const now = new Date();
      if (to === "APPROVED" || to === "DISBURSED") {
        // When RSM approves/disburses, mark all PENDING/UPDATED documents as VERIFIED
        app.docs.forEach((doc) => {
          if (doc.status === "PENDING" || doc.status === "UPDATED") {
            doc.status = "VERIFIED";
            doc.verifiedAt = now;
            doc.verifiedBy = rsmId;
            doc.updatedAt = now;
            // Clear rejection info if any
            doc.rejectedAt = null;
            doc.rejectedBy = null;
          }
        });
      }

      await app.save();

      // Partner→partner disbursal referral rewards: handled in Application post("save") hook

      // Emit socket notification
      try {
        const io = global.io;
        if (io) {
          console.log("🔔 RSM Route: Emitting application status change", {
            applicationId: app._id,
            oldStatus,
            newStatus: to,
            actionBy: rsmId,
          });

          // Populate application for socket emission
          await app.populate("partnerId", "firstName lastName email employeeId");
          await app.populate("customerId", "firstName middleName lastName email phone");
          await app.populate("rmId", "firstName lastName email employeeId");
          await app.populate("rsmId", "firstName lastName email employeeId");
          await app.populate("asmId", "firstName lastName email employeeId");

          await emitApplicationStatusChanged(
            io,
            app,
            oldStatus,
            to,
            rsmId
          );

          console.log("✅ Socket emission completed");
        } else {
          console.error("❌ Socket io instance not available (global.io is null)");
        }
      } catch (socketErr) {
        console.error("❌ Error emitting socket event:", socketErr);
        // Don't fail the request if socket fails
      }

      // Send response immediately
      res.json({
        message: "Application status updated successfully",
        status: app.status,
        approvedLoanAmount: app.approvedLoanAmount,
        stageHistory: app.stageHistory,
      });

      // ✅ If status = REJECTED → mark for auto-delete after 3 months (Application only)
      if (to === "REJECTED") {
        const threeMonthsLater = new Date(
          Date.now() + 90 * 24 * 60 * 60 * 1000
        );
        app.deletedAt = threeMonthsLater; // Application soft-delete scheduled
        // Customer is NO LONGER deleted, so we retain the lead info
        await app.save();
      }

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
    } catch (err) {
      console.error("RSM Application transition error:", err);
      res.status(500).json({ message: err.message });
    }
  }
);

// GET /api/rsm/applications
// List all applications assigned to this RSM
router.get("/applications", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { status } = req.query;
    const rsmObjectId = toObjectId(rsmId);

    const rsm = await User.findById(rsmId).select("asmType rsmType").lean();
    if (!rsm) {
      return res.status(404).json({ message: "Manager not found" });
    }

    const rsmTypeNorm = normalizeRsmTypeValue(rsm.asmType || rsm.rsmType);
    const loanTypeFilter = loanTypeFilterForRsmType(rsmTypeNorm);

    if (rsmTypeNorm) {
      console.log(`🔍 Manager ${rsmId} list: type ${rsmTypeNorm}`);
    } else {
      console.log(
        `⚠️ Manager ${rsmId} has no usable asmType (${rsm.asmType || rsm.rsmType}); listing all loans for this manager`
      );
    }

    // Fix all rows: missing or wrong asmId vs RM mapping (for completed documents)
    await repairDocCompleteRoutingForRsm(rsmId);

    const eligibleRmIds = await eligibleRmIdsForRsmHierarchy(rsmObjectId, rsmTypeNorm);
    const statusFilter = status && status !== "All"
      ? (RSM_ALLOWED_STATUSES.includes(status) ? { status } : { status: "__NONE__" })
      : { status: { $in: RSM_ALLOWED_STATUSES } };

    const filter = {
      $and: [
        {
          $or: [
            { asmId: rsmObjectId },
            { rsmId: rsmObjectId },
            ...(eligibleRmIds.length ? [{ rmId: { $in: eligibleRmIds }, ...loanTypeFilter }] : []),
          ],
        },
        loanTypeFilter,
        statusFilter,
      ],
    };

    console.log(`🔍 RSM applications filter:`, JSON.stringify(filter));

    let applications = await Application.find(activeApplicationsFilter(filter))
      .populate("customerId", "firstName lastName email phone employeeId")
      .populate("partnerId", "firstName lastName employeeId")
      .populate("rmId", "firstName lastName employeeId")
      .select("-stageHistory") // Include docs, exclude stageHistory
      .sort({ createdAt: -1 })
      .lean();

    console.log(
      `✅ RSM ${rsmId} fetched ${applications.length} applications (after routing repair)`
    );

    // Attach payout info (only status + amount) to each application
    const appIds = applications.map((app) => app._id);
    const payouts = await Payout.find({ application: { $in: appIds } })
      .select("application amount payOutStatus")
      .lean();

    const payoutMap = {};
    payouts.forEach((p) => {
      payoutMap[p.application.toString()] = p;
    });

    const result = applications.map((app) => {
      const payout = payoutMap[app._id.toString()];
      return {
        ...app,
        payoutAmount: payout?.amount || 0,
        payOutStatus: payout?.payOutStatus || "PENDING",
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Error fetching RSM applications:", err);
    res.status(500).json({ message: "Error fetching applications" });
  }
});

// GET /api/rsm/applications/:id
// Get single application details for RSM
router.get("/applications/:id", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { id } = req.params;

    const access = await loadApplicationForRsm(id, rsmId);
    if (!access) {
      return res.status(404).json({
        message: "Application not found or not assigned to this RSM",
      });
    }

    const application = await Application.findById(id)
      .populate("customerId", "firstName lastName email phone employeeId")
      .populate("partnerId", "firstName lastName email phone employeeId")
      .populate("rmId", "firstName lastName email phone employeeId")
      .populate("docs.uploadedBy", "firstName lastName email")
      .lean();

    if (!application) {
      return res.status(404).json({
        message: "Application not found or not assigned to this RSM",
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
    console.error("Error fetching RSM application details:", err);
    return res.status(500).json({ message: "Error fetching application details" });
  }
});

// GET /api/rsm/applications/:id/docs/:docType/download
// RSM downloads a document from an application
router.get(
  "/applications/:id/docs/:docType/download",
  auth,
  requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id, docType } = req.params;
      const rsmId = req.user.sub;

      const access = await loadApplicationForRsm(id, rsmId);
      if (!access) {
        return res.status(404).json({ message: "Application not found or not assigned to this RSM" });
      }

      const app = await Application.findById(id).lean();

      if (!app) {
        return res.status(404).json({ message: "Application not found or not assigned to this RSM" });
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

      console.log(`RSM downloading document: docType=${docType}, actualUrl=${actualUrl.substring(0, 100)}...`);

      // Check if it's a remote URL (S3, external CDN, etc.)
      if (actualUrl.startsWith("http://") || actualUrl.startsWith("https://")) {
        // 🔹 Remote URL (S3, CDN, etc.)
        try {
          let responseStream;
          if (actualUrl.includes("amazonaws.com") && extractS3KeyFromUrl(actualUrl)) {
            const s3Key = extractS3KeyFromUrl(actualUrl);
            const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key });
            const s3Response = await s3.send(command);
            responseStream = s3Response.Body;
            contentType = s3Response.ContentType || "application/octet-stream";
          } else {
            const response = await axios.get(actualUrl, {
              responseType: "stream",
              timeout: 30000, // 30 second timeout
              maxRedirects: 5
            });
            responseStream = response.data;
            contentType = response.headers["content-type"] || "application/octet-stream";
          }

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

          responseStream.pipe(res);

          responseStream.on("error", (err) => {
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
      console.error("RSM Download error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          message: "Error downloading document",
          error: err.message
        });
      }
    }
  }
);

// GET /api/rsm/dashboard
// RSM dashboard with KPIs
router.get("/dashboard", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;

    // RSM/ASM profile
    const rsm = await User.findOne({ _id: rsmId, role: { $in: [ROLES.ASM, ROLES.RSM] } }).lean();
    if (!rsm) return res.status(404).json({ message: "Manager not found" });

    const rsmTypeNorm = normalizeRsmTypeValue(rsm.asmType || rsm.rsmType);
    await repairDocCompleteRoutingForRsm(rsmId);
    const ltFilter = loanTypeFilterForRsmType(rsmTypeNorm);
    const rsmObjectId = toObjectId(rsmId);

    let rmScope = {};
    if (rsm.role === ROLES.RSM) {
      rmScope = await loadRsmReportingScope(rsmId);
    } else if (rsmTypeNorm === RSM_TYPES.PERSONAL) {
      rmScope = { $or: [{ personalAsmId: rsmObjectId }, { personalRsmId: rsmObjectId }] };
    } else if (rsmTypeNorm === RSM_TYPES.BUSINESS) {
      rmScope = { $or: [{ businessAsmId: rsmObjectId }, { businessRsmId: rsmObjectId }, { businessHomeRsmId: rsmObjectId }, { businessHomeAsmId: rsmObjectId }] };
    } else if (rsmTypeNorm === RSM_TYPES.HOME_LAP) {
      rmScope = { $or: [{ homeLapAsmId: rsmObjectId }, { homeLapRsmId: rsmObjectId }, { businessHomeRsmId: rsmObjectId }, { businessHomeAsmId: rsmObjectId }] };
    } else if (rsmTypeNorm === RSM_TYPES.BUSINESS_HOME) {
      rmScope = {
        $or: [{ businessHomeRsmId: rsmObjectId }, { businessHomeAsmId: rsmObjectId }, { businessRsmId: rsmObjectId }, { homeLapRsmId: rsmObjectId }, { businessAsmId: rsmObjectId }, { homeLapAsmId: rsmObjectId }],
      };
    } else {
      rmScope = {
        $or: [
          { rsmId: rsmObjectId },
          { asmId: rsmObjectId },
          { personalAsmId: rsmObjectId },
          { businessAsmId: rsmObjectId },
          { homeLapAsmId: rsmObjectId },
          { personalRsmId: rsmObjectId },
          { businessRsmId: rsmObjectId },
          { homeLapRsmId: rsmObjectId },
          { businessHomeRsmId: rsmObjectId },
        ],
      };
    }
    const rms = await User.find(activeUsersFilter({ role: ROLES.RM, status: "ACTIVE", ...rmScope })).lean();
    const rmIds = rms.map((rm) => rm._id);

    const appScope = activeApplicationsFilter({
      $and: [
        {
          $or: [
            { asmId: rsmObjectId },
            { rsmId: rsmObjectId },
            ...(rmIds.length ? [{ rmId: { $in: rmIds }, ...ltFilter }] : []),
          ],
        },
        ltFilter,
        { status: { $in: RSM_ALLOWED_STATUSES } },
      ],
    });

    // All partners under these RMs or directly linked (approved, non-deleted)
    const partners = await User.find(
      activeUsersFilter({
        role: ROLES.PARTNER,
        status: { $ne: "PENDING" },
        $or: [
          ...(rmIds.length ? [{ rmId: { $in: rmIds } }] : []),
          { asmId: rsmObjectId },
          { rsmId: rsmObjectId },
        ],
      })
    ).lean();
    const partnerIds = partners.map((p) => p._id);

    // Subordinate ASMs under this RSM
    const asms = await User.find(
      activeUsersFilter({
        role: ROLES.ASM,
        status: "ACTIVE",
        $or: [{ rsmId: rsmObjectId }, { asmId: rsmObjectId }],
      })
    ).lean();
    const totalASMs = asms.length;

    // Totals
    const totalRMs = rms.length;
    const totalPartners = partners.length;
    const activePartners = partners.filter((p) => p.status === "ACTIVE").length;
    const inactivePartners = partners.filter((p) => p.status === "INACTIVE").length;

    const customers = await Application.distinct("customerId", appScope);
    const totalCustomers = customers.length;

    const totalApplications = await Application.countDocuments(appScope);
    // Applications by status
    const inProcessApplications = await Application.countDocuments({
      ...appScope,
      status: { $in: ["LOGIN", "UNDER_REVIEW", "APPROVED", "AGREEMENT"] },
    });

    const pendingApplications = await Application.countDocuments({
      ...appScope,
      status: "DOC_COMPLETE",
    });

    const disbursedApplications = await Application.countDocuments({
      ...appScope,
      status: "DISBURSED",
    });

    const rejectedApplications = await Application.countDocuments({
      ...appScope,
      status: "REJECTED",
    });

    // Revenue from disbursed loans
    const revenueAgg = await Application.aggregate([
      {
        $match: {
          rsmId: new mongoose.Types.ObjectId(rsmId),
          status: "DISBURSED",
          ...ltFilter,
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

    // Avg rating of partners
    const ratings = partners.map((p) => p.rating || 0);
    const avgRating = ratings.length
      ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
      : 0;

    // Current Month Target (RSM's hierarchical target - sum of RM targets)
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // Get RSM's current month target (hierarchical - sum of RM targets)
    const rsmTarget = await Target.findOne({
      assignedTo: new mongoose.Types.ObjectId(rsmId),
      role: ROLES.RSM,
      month: currentMonth,
      year: currentYear,
    }).lean();

    // Calculate current month achievements (disbursed applications)
    const currentMonthStart = new Date(currentYear, currentMonth - 1, 1);
    const currentMonthEnd = new Date(currentYear, currentMonth, 1);

    const currentMonthDisbursed = await Application.aggregate([
      {
        $match: {
          rsmId: new mongoose.Types.ObjectId(rsmId),
          status: { $ne: "DRAFT" },
          ...ltFilter,
          updatedAt: {
            $gte: currentMonthStart,
            $lt: currentMonthEnd,
          },
        },
      },
      {
        $group: {
          _id: null,
          totalDisbursement: {
            $sum: {
              $cond: [{ $eq: ["$status", "DISBURSED"] }, { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } }, 0]
            }
          },
          totalFiles: { $sum: 1 },
        },
      },
    ]);

    const currentMonthAchievedDisbursement = currentMonthDisbursed[0]?.totalDisbursement || 0;
    const currentMonthAchievedFileCount = currentMonthDisbursed[0]?.totalFiles || 0;

    // 12-Month Target (RSM's hierarchical targets)
    const startOfYear = new Date(currentYear, 0, 1);

    const monthlyTarget = await Target.find({
      assignedTo: new mongoose.Types.ObjectId(rsmId),
      role: ROLES.RSM,
      year: currentYear,
    }).lean();

    // 12-Month Achieved
    const monthlyAchieved = await Application.aggregate([
      {
        $match: {
          rsmId: new mongoose.Types.ObjectId(rsmId),
          status: { $ne: "DRAFT" },
          ...ltFilter,
          updatedAt: { $gte: startOfYear },
        },
      },
      {
        $group: {
          _id: { month: { $month: "$updatedAt" } },
          totalAchieved: {
            $sum: {
              $cond: [{ $eq: ["$status", "DISBURSED"] }, { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } }, 0]
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

    // Top Performers (RMs under this RSM)
    const topRMs = await Application.aggregate([
      {
        $match: {
          rmId: { $in: rmIds.map((id) => new mongoose.Types.ObjectId(id)) },
          status: "DISBURSED",
          ...ltFilter,
        },
      },
      {
        $group: {
          _id: "$rmId",
          totalRevenue: { $sum: { $ifNull: ["$approvedLoanAmount", 0] } },
          totalDisbursedApps: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 },
    ]);

    const topPerformers = await Promise.all(
      topRMs.map(async (tr) => {
        const rm = await User.findById(tr._id).select(
          "firstName lastName email rating"
        );
        return {
          id: rm._id,
          name: `${rm.firstName} ${rm.lastName}`,
          email: rm.email,
          rating: rm.rating || 0,
          totalRevenue: tr.totalRevenue,
          totalDisbursedApps: tr.totalDisbursedApps,
        };
      })
    );

    // Top ASM Performers under this RSM
    const asmOids = asms.map((a) => a._id);
    const topASMs = asmOids.length > 0 ? await Application.aggregate([
      {
        $match: {
          $or: [{ asmId: { $in: asmOids } }, { rsmId: { $in: asmOids } }],
          status: "DISBURSED",
        },
      },
      {
        $group: {
          _id: { $ifNull: ["$asmId", "$rsmId"] },
          totalRevenue: { $sum: { $ifNull: ["$approvedLoanAmount", 0] } },
          totalDisbursedApps: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 },
    ]) : [];

    const topASMPerformers = await Promise.all(
      topASMs.map(async (ta) => {
        const asmUser = await User.findById(ta._id).select(
          "firstName lastName email asmType rsmType"
        );
        return {
          id: asmUser?._id || ta._id,
          name: asmUser ? `${asmUser.firstName} ${asmUser.lastName}` : "ASM",
          email: asmUser?.email || "",
          asmType: asmUser?.asmType || asmUser?.rsmType || "ASM",
          totalRevenue: ta.totalRevenue,
          totalDisbursedApps: ta.totalDisbursedApps,
        };
      })
    );

    // Recent Applications for Pipeline (last 10 applications)
    const recentApplications = await Application.find(
      activeApplicationsFilter({
        ...appScope,
        status: { $in: ["DOC_COMPLETE", "UNDER_REVIEW", "APPROVED", "AGREEMENT"] },
      })
    )
      .populate("customerId", "firstName lastName phone")
      .select("appNo loanType loanAmount status customerId createdAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const formattedRecentApplications = recentApplications.map((app) => ({
      appNo: app.appNo,
      loanType: app.loanType,
      loanAmount: app.loanAmount || 0,
      status: app.status,
      customerName: app.customerId
        ? `${app.customerId.firstName || ""} ${app.customerId.lastName || ""}`.trim()
        : "N/A",
      phone: app.customerId?.phone || "",
      createdAt: app.createdAt,
    }));

    // Final Response
    res.json({
      totals: {
        totalASMs,
        totalRMs,
        totalPartners,
        activePartners,
        inactivePartners,
        totalCustomers,
        totalRevenue,
        avgRating,
        totalApplications,
        inProcessApplications,
        pendingApplications,
        disbursedApplications,
        rejectedApplications,
      },
      // Current month target and achievement
      currentMonthTarget: {
        fileCountTarget: rsmTarget?.fileCountTarget || 0,
        disbursementTarget: rsmTarget?.disbursementTarget || 0,
        achievedFileCount: currentMonthAchievedFileCount,
        achievedDisbursement: currentMonthAchievedDisbursement,
        fileTargetMet: currentMonthAchievedFileCount >= (rsmTarget?.fileCountTarget || 0),
        disbursementTargetMet: currentMonthAchievedDisbursement >= (rsmTarget?.disbursementTarget || 0),
        targetAchieved: currentMonthAchievedFileCount >= (rsmTarget?.fileCountTarget || 0) &&
          currentMonthAchievedDisbursement >= (rsmTarget?.disbursementTarget || 0),
      },
      targets, // 12-month breakdown
      topPerformers,
      topASMPerformers,
      recentApplications: formattedRecentApplications,
      rsmType: rsm.rsmType,
    });
  } catch (error) {
    console.error("Error in RSM dashboard:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/rsm/profile
// Get RSM profile with ASM details
router.get("/profile", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsm = await User.findById(req.user.sub)
      .select("-passwordHash")
      .populate({
        path: "asmId",
        select: "firstName lastName employeeId region phone email",
      })
      .lean();

    if (!rsm) {
      return res.status(404).json({ message: "RSM not found" });
    }

    res.json({
      _id: rsm._id,
      id: rsm._id,
      employeeId: rsm.employeeId,
      firstName: rsm.firstName,
      lastName: rsm.lastName,
      email: rsm.email,
      phone: rsm.phone,
      dob: rsm.dob,
      address: rsm.address,
      region: rsm.region,
      experience: rsm.experience,
      status: rsm.status,
      rsmType: rsm.rsmType,
      JoiningDate: rsm.createdAt,
      // Flattened ASM details
      asmId: rsm.asmId?._id || null,
      asmName: rsm.asmId ? `${rsm.asmId.firstName} ${rsm.asmId.lastName}` : null,
      asmEmployeeId: rsm.asmId?.employeeId || null,
      asmRegion: rsm.asmId?.region || null,
      asmPhone: rsm.asmId?.phone || null,
      asmEmail: rsm.asmId?.email || null,
    });
  } catch (err) {
    console.error("Error fetching RSM profile:", err);
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/rsm/profile/update
router.patch("/profile/update", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const {
      firstName,
      lastName,
      currentEmail,
      currentPassword,
      email,
      phone,
      dob,
      address,
      region,
      experience,
    } = req.body || {};

    const updateData = {
      firstName,
      lastName,
      dob,
      address,
      region,
      experience,
    };

    if (phone) {
      const normalizedPhone = String(phone).replace(/\D/g, "").slice(-10);
      const existingPhoneUser = await User.findOne({
        phone: normalizedPhone,
        _id: { $ne: rsmId },
      }).select("_id");
      if (existingPhoneUser) {
        return res.status(409).json({
          message: `The mobile number ${phone} is already registered to another user.`,
        });
      }
      updateData.phone = normalizedPhone;
    }

    if (email) {
      const normalizedEmail = String(email).toLowerCase().trim();
      const existingEmailUser = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: rsmId },
      }).select("_id");
      if (existingEmailUser) {
        return res.status(409).json({
          message: `The email address ${email} is already registered to another user.`,
        });
      }
      updateData.email = normalizedEmail;
    }

    Object.keys(updateData).forEach(
      (key) => updateData[key] === undefined && delete updateData[key]
    );

    const updatedRsm = await User.findOneAndUpdate(
      { _id: rsmId, role: { $in: [ROLES.RSM, ROLES.ASM, ROLES.SUPER_ADMIN] } },
      { $set: updateData },
      { new: true, runValidators: true, projection: "-passwordHash" }
    );

    if (!updatedRsm) return res.status(404).json({ message: "Profile not found" });

    const profileObj = updatedRsm?.toObject ? updatedRsm.toObject() : updatedRsm;

    res.json({
      message: "Profile updated successfully",
      profile: profileObj,
    });
  } catch (err) {
    console.error("Error updating RSM profile:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== BANK MASTER (RSM) ====================

// GET /api/rsm/banks
// RSM fetches banks allowed for their rsmType
router.get("/banks", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsm = await User.findById(req.user.sub)
      .select("asmType rsmType")
      .lean();

    if (!rsm) {
      return res.status(404).json({ message: "Manager not found" });
    }

    const managerType = String(rsm.asmType || rsm.rsmType || "").trim().toUpperCase();
    const bankFilter = { isActive: true };
    if (managerType) {
      bankFilter.$or = [
        { asmTypes: managerType },
        { rsmTypes: managerType },
      ];
    }

    const banks = await BankMaster.find(bankFilter)
      .sort({ bankName: 1 })
      .lean();

    // Filter according to Application.js LOAN_TYPES:
    // PERSONAL RSM -> PERSONAL
    // BUSINESS_HOME RSM -> BUSINESS + HOME_LOAN_SALARIED + HOME_LOAN_SELF_EMPLOYED
    // Normalize legacy values PERSONAL_LOAN/BUSINESS_LOAN to PERSONAL/BUSINESS.
    const normalizeLoanType = (lt) => {
      const raw = String(lt || "").trim().toUpperCase();
      if (raw === "PERSONAL_LOAN") return "PERSONAL";
      if (raw === "BUSINESS_LOAN") return "BUSINESS";
      return raw;
    };

    const rsmType = String(rsm.rsmType || "").trim().toUpperCase();
    let filtered = banks.filter((b) => {
      const lt = normalizeLoanType(b.loanType);
      if (rsmType === String(RSM_TYPES.PERSONAL)) return lt === "PERSONAL";
      if (rsmType === String(RSM_TYPES.BUSINESS)) return lt === "BUSINESS";
      if (rsmType === String(RSM_TYPES.HOME_LAP)) return lt.startsWith("HOME_LOAN_") || lt.startsWith("LAP_") || lt === "LAP";
      if (rsmType === String(RSM_TYPES.BUSINESS_HOME)) return lt === "BUSINESS" || lt.startsWith("HOME_LOAN_") || lt.startsWith("LAP_") || lt === "LAP";
      return true;
    });

    const { pincode, loanType: queryLoanType } = req.query;

    if (queryLoanType) {
      filtered = filtered.filter(b => normalizeLoanType(b.loanType) === normalizeLoanType(queryLoanType));
    }

    if (pincode) {
      const pin = String(pincode).trim();
      filtered = filtered.filter((b) => {
        const pins = (b.serviceablePincodes || [])
          .map((p) => String(p).trim())
          .filter(Boolean);
        // Banks with no pincode list must NOT appear in pincode-based search
        if (pins.length === 0) return false;
        return pins.includes(pin);
      });
    }

    return res.json(filtered);
  } catch (err) {
    console.error("Error fetching banks for RSM:", err);
    return res.status(500).json({ message: "Error fetching banks" });
  }
});

// ==================== BANK RM DIRECTORY (RSM / ASM) ====================

const pickContact = (body = {}, prefix) => {
  const nested = body?.[prefix] && typeof body[prefix] === "object" ? body[prefix] : {};
  const name = String(nested.name ?? body[`${prefix}Name`] ?? "").trim();
  const phone = String(nested.phone ?? body[`${prefix}Phone`] ?? "").trim();
  const email = String(nested.email ?? body[`${prefix}Email`] ?? "")
    .trim()
    .toLowerCase();
  const product = String(nested.product ?? body[`${prefix}Product`] ?? "").trim();
  return { name, phone, email, product };
};

const normalizeBankRmPayload = (body = {}) => {
  const pick = (key) => String(body[key] ?? "").trim();
  const rm = pickContact(body, "rm");
  const asm = pickContact(body, "asm");
  const rsm = pickContact(body, "rsm");
  const isPanIndia =
    body.isPanIndia === true ||
    body.isPanIndia === "true" ||
    body.isPanIndia === 1 ||
    body.isPanIndia === "1" ||
    String(body.state || "").trim().toLowerCase() === "pan india" ||
    String(body.state || "").trim().toLowerCase() === "open india";

  let stateVal = pick("state");
  let cityVal = pick("city");
  if (isPanIndia) {
    if (!stateVal || stateVal.toLowerCase() === "open india") stateVal = "PAN India";
    if (!cityVal) cityVal = "All Cities";
  }

  return {
    bankNbfcName: pick("bankNbfcName"),
    loginCode: pick("loginCode"),
    product: pick("product"),
    marketType: pick("marketType"),
    city: cityVal,
    state: stateVal,
    company: pick("company"),
    isPanIndia,
    rm,
    asm,
    rsm,
    rmName: rm.name,
    rmPhone: rm.phone,
    rmEmail: rm.email,
  };
};

const validateOptionalEmail = (email, label) => {
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return `${label} email must be a valid email address`;
  }
  return null;
};

const validateOptionalPhone = (phone, label) => {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 10) {
    return `${label} phone must be at least 10 digits`;
  }
  return null;
};

const validateBankRmPayload = (payload) => {
  const required = [
    "bankNbfcName",
    "loginCode",
    "product",
    "marketType",
    "company",
  ];
  if (!payload.isPanIndia) {
    required.push("city", "state");
  } else {
    if (!payload.state) payload.state = "PAN India";
    if (!payload.city) payload.city = "All Cities";
  }
  const missing = required.filter((key) => !payload[key]);
  if (missing.length) {
    return `Missing required fields: ${missing.join(", ")}`;
  }

  for (const [key, label] of [
    ["rm", "RM"],
    ["asm", "ASM"],
    ["rsm", "RSM"],
  ]) {
    const contact = payload[key] || {};
    const phoneErr = validateOptionalPhone(contact.phone, label);
    if (phoneErr) return phoneErr;
    const emailErr = validateOptionalEmail(contact.email, label);
    if (emailErr) return emailErr;
  }
  return null;
};

const buildBankRmActiveFilter = (query = {}) => {
  const filter = { isActive: true };
  if (query.bank) filter.bankNbfcName = String(query.bank).trim();
  if (query.product) filter.product = String(query.product).trim();
  if (query.marketType) filter.marketType = String(query.marketType).trim();
  if (query.state) {
    const stateTrimmed = String(query.state).trim();
    if (
      stateTrimmed.toLowerCase() === "pan india" ||
      stateTrimmed.toLowerCase() === "open india"
    ) {
      filter.$or = [
        { state: { $regex: /^pan\s*india$/i } },
        { state: { $regex: /^open\s*india$/i } },
        { isPanIndia: true },
      ];
    } else {
      filter.$or = [
        { state: stateTrimmed },
        { isPanIndia: true },
        { state: { $regex: /^pan\s*india$/i } },
        { state: { $regex: /^open\s*india$/i } },
      ];
    }
  }
  if (query.city) {
    const cityTrimmed = String(query.city).trim();
    if (cityTrimmed.toLowerCase() !== "all cities") {
      if (filter.$or) {
        const stateOr = filter.$or;
        filter.$and = [
          { $or: stateOr },
          {
            $or: [
              { city: cityTrimmed },
              { isPanIndia: true },
              { city: { $regex: /^all\s*cities$/i } },
            ],
          },
        ];
        delete filter.$or;
      } else {
        filter.$or = [
          { city: cityTrimmed },
          { isPanIndia: true },
          { city: { $regex: /^all\s*cities$/i } },
        ];
      }
    }
  }
  return filter;
};

// GET /api/rsm/bank-rms/filter-options
// Cascading distinct values for ASM/RSM search dropdowns
router.get(
  "/bank-rms/filter-options",
  auth,
  requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { bank, product, marketType, state } = req.query || {};
      const base = { isActive: true };

      const banks = await BankRm.distinct("bankNbfcName", base);

      const productFilter = { ...base };
      if (bank) productFilter.bankNbfcName = String(bank).trim();
      const products = await BankRm.distinct("product", productFilter);

      const marketFilter = { ...productFilter };
      if (product) marketFilter.product = String(product).trim();
      const marketTypes = await BankRm.distinct("marketType", marketFilter);

      const stateFilter = { ...marketFilter };
      if (marketType) stateFilter.marketType = String(marketType).trim();
      const rawStates = await BankRm.distinct("state", stateFilter);
      const stateSet = new Set(rawStates.map((v) => String(v || "").trim()).filter(Boolean));
      stateSet.add("PAN India");

      const cityFilter = { ...stateFilter };
      if (state) {
        const sTrim = String(state).trim();
        if (sTrim.toLowerCase() !== "pan india") {
          cityFilter.state = sTrim;
        }
      }
      const rawCities = await BankRm.distinct("city", cityFilter);
      const citySet = new Set(rawCities.map((v) => String(v || "").trim()).filter(Boolean));
      if (state && String(state).trim().toLowerCase() === "pan india") {
        citySet.add("All Cities");
      }

      const sortAlpha = (arr) =>
        Array.from(arr)
          .map((v) => String(v || "").trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));

      return res.json({
        banks: sortAlpha(banks),
        products: sortAlpha(products),
        marketTypes: sortAlpha(marketTypes),
        states: sortAlpha(stateSet),
        cities: sortAlpha(citySet),
      });
    } catch (err) {
      console.error("Error fetching bank RM filter options:", err);
      return res.status(500).json({ message: "Error fetching filter options" });
    }
  }
);

// GET /api/rsm/bank-rms
router.get(
  "/bank-rms",
  auth,
  requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const filter = buildBankRmActiveFilter(req.query || {});
      const bankRms = await BankRm.find(filter)
        .populate("createdBy", "firstName lastName role email")
        .populate("updatedBy", "firstName lastName role email")
        .sort({ updatedAt: -1, bankNbfcName: 1, city: 1 })
        .lean();
      return res.json({ bankRms });
    } catch (err) {
      console.error("Error fetching bank RMs:", err);
      return res.status(500).json({ message: "Error fetching bank RMs" });
    }
  }
);

// POST /api/rsm/bank-rms (RSM + admin only)
router.post(
  "/bank-rms",
  auth,
  requireRole(ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const payload = normalizeBankRmPayload(req.body);
      const validationError = validateBankRmPayload(payload);
      if (validationError) {
        return res.status(400).json({ message: validationError });
      }

      const bankRm = await BankRm.create({
        ...payload,
        createdBy: req.user.sub,
      });

      return res.status(201).json({
        message: "Bank RM created successfully",
        bankRm,
      });
    } catch (err) {
      console.error("Error creating bank RM (rsm):", err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  }
);

// PUT /api/rsm/bank-rms/:id
router.put(
  "/bank-rms/:id",
  auth,
  requireRole(ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params || {};
      const existing = await BankRm.findById(id);
      if (!existing) {
        return res.status(404).json({ message: "Bank RM not found" });
      }

      const existingObj = existing.toObject();
      const mergeBody = {
        bankNbfcName: req.body?.bankNbfcName ?? existingObj.bankNbfcName,
        loginCode: req.body?.loginCode ?? existingObj.loginCode,
        product: req.body?.product ?? existingObj.product,
        marketType: req.body?.marketType ?? existingObj.marketType,
        city: req.body?.city ?? existingObj.city,
        state: req.body?.state ?? existingObj.state,
        company: req.body?.company ?? existingObj.company,
        rm: {
          name: req.body?.rmName ?? req.body?.rm?.name ?? existingObj.rm?.name ?? existingObj.rmName,
          phone: req.body?.rmPhone ?? req.body?.rm?.phone ?? existingObj.rm?.phone ?? existingObj.rmPhone,
          email: req.body?.rmEmail ?? req.body?.rm?.email ?? existingObj.rm?.email ?? existingObj.rmEmail,
          product: req.body?.rmProduct ?? req.body?.rm?.product ?? existingObj.rm?.product,
        },
        asm: {
          name: req.body?.asmName ?? req.body?.asm?.name ?? existingObj.asm?.name,
          phone: req.body?.asmPhone ?? req.body?.asm?.phone ?? existingObj.asm?.phone,
          email: req.body?.asmEmail ?? req.body?.asm?.email ?? existingObj.asm?.email,
          product: req.body?.asmProduct ?? req.body?.asm?.product ?? existingObj.asm?.product,
        },
        rsm: {
          name: req.body?.rsmName ?? req.body?.rsm?.name ?? existingObj.rsm?.name,
          phone: req.body?.rsmPhone ?? req.body?.rsm?.phone ?? existingObj.rsm?.phone,
          email: req.body?.rsmEmail ?? req.body?.rsm?.email ?? existingObj.rsm?.email,
          product: req.body?.rsmProduct ?? req.body?.rsm?.product ?? existingObj.rsm?.product,
        },
      };

      const payload = normalizeBankRmPayload(mergeBody);
      const validationError = validateBankRmPayload(payload);
      if (validationError) {
        return res.status(400).json({ message: validationError });
      }

      Object.assign(existing, payload);
      existing.updatedBy = req.user.sub;

      if (req.body?.isActive !== undefined) {
        const activeVal =
          req.body.isActive === true ||
          req.body.isActive === "true" ||
          req.body.isActive === 1 ||
          req.body.isActive === "1";
        existing.isActive = Boolean(activeVal);
      }

      await existing.save();
      return res.json({
        message: "Bank RM updated successfully",
        bankRm: existing,
      });
    } catch (err) {
      console.error("Error updating bank RM (rsm):", err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  }
);

// DELETE /api/rsm/bank-rms/:id (soft delete)
router.delete(
  "/bank-rms/:id",
  auth,
  requireRole(ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params || {};
      const updated = await BankRm.findByIdAndUpdate(
        id,
        { $set: { isActive: false, updatedBy: req.user.sub } },
        { new: true }
      ).lean();

      if (!updated) {
        return res.status(404).json({ message: "Bank RM not found" });
      }

      return res.json({
        message: "Bank RM deleted successfully",
        bankRm: updated,
      });
    } catch (err) {
      console.error("Error deleting bank RM (rsm):", err);
      return res.status(500).json({ message: "Error deleting bank RM" });
    }
  }
);

// GET /api/rsm/rm/:rmId/analytics
// RSM views analytics for a specific RM
router.get("/rm/:rmId/analytics", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { rmId } = req.params;
    const scope = await loadRsmReportingScope(rsmId);

    const rm = await User.findOne({
      _id: rmId,
      role: ROLES.RM,
      ...scope,
    }).lean();

    if (!rm) {
      return res.status(404).json({ message: "RM not found or not under this RSM" });
    }

    // Get partners under this RM (exclude admin-queue pending signups)
    const partners = await User.find({
      rmId,
      role: ROLES.PARTNER,
      status: { $ne: "PENDING" },
    }).lean();

    // Applications assigned to this RM (or from partners under this RM)
    const partnerIds = partners.map((p) => p._id);
    const totalApplications = await Application.countDocuments(
      activeApplicationsFilter({
        $or: [
          { rmId },
          { partnerId: { $in: partnerIds } }
        ]
      })
    );

    const disbursedApplications = await Application.countDocuments(
      activeApplicationsFilter({
        $or: [
          { rmId },
          { partnerId: { $in: partnerIds } }
        ],
        status: "DISBURSED"
      })
    );

    const inProcessApplications = await Application.countDocuments(
      activeApplicationsFilter({
        $or: [
          { rmId },
          { partnerId: { $in: partnerIds } }
        ],
        status: { $in: ["UNDER_REVIEW", "APPROVED", "AGREEMENT", "DOC_COMPLETE"] },
      })
    );

    // Revenue from disbursed loans
    const revenueAgg = await Application.aggregate([
      {
        $match: activeApplicationsFilter({
          $or: [
            { rmId: new mongoose.Types.ObjectId(rmId) },
            { partnerId: { $in: partnerIds.map(id => new mongoose.Types.ObjectId(id)) } }
          ],
          status: "DISBURSED",
        }),
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ["$approvedLoanAmount", 0] } },
        },
      },
    ]);
    const totalRevenue = revenueAgg[0]?.total || 0;

    // Get current month target and achievement
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const targetDoc = await Target.findOne({
      assignedTo: rmId,
      role: ROLES.RM,
      month: currentMonth,
      year: currentYear,
    }).lean();

    // Get target value - prefer disbursementTarget, fallback to targetValue
    const targetValue = targetDoc ? Number(targetDoc.disbursementTarget || targetDoc.targetValue || 0) : 0;

    // Calculate achieved value for current month
    const currentMonthAchievedAgg = await Application.aggregate([
      {
        $match: {
          $or: [
            { rmId: new mongoose.Types.ObjectId(rmId) },
            { partnerId: { $in: partnerIds.map(id => new mongoose.Types.ObjectId(id)) } }
          ],
          status: "DISBURSED",
          $expr: {
            $and: [
              { $eq: [{ $month: { $ifNull: ["$disbursedDate", "$createdAt"] } }, currentMonth] },
              { $eq: [{ $year: { $ifNull: ["$disbursedDate", "$createdAt"] } }, currentYear] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } } },
        },
      },
    ]);
    const achievedValue = currentMonthAchievedAgg.length > 0 ? Number(currentMonthAchievedAgg[0].total) : 0;

    // Monthly performance
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const monthlyAchieved = await Application.aggregate([
      {
        $match: {
          $or: [
            { rmId: new mongoose.Types.ObjectId(rmId) },
            { partnerId: { $in: partnerIds.map(id => new mongoose.Types.ObjectId(id)) } }
          ],
          status: "DISBURSED",
          createdAt: { $gte: startOfYear },
        },
      },
      {
        $group: {
          _id: { month: { $month: "$createdAt" } },
          totalAchieved: { $sum: { $toDouble: "$approvedLoanAmount" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.month": 1 } },
    ]);

    // Get customer count
    const customers = await Application.distinct(
      "customerId",
      activeApplicationsFilter({
        $or: [
          { rmId },
          { partnerId: { $in: partnerIds } }
        ]
      })
    );

    res.json({
      profile: {
        userId: rm._id,
        name: `${rm.firstName} ${rm.lastName}`,
        email: rm.email,
        phone: rm.phone || "N/A",
        employeeId: rm.employeeId || "N/A",
        status: rm.status || "ACTIVE",
      },
      analytics: {
        scope: ROLES.RM,
        totals: {
          totalPartners: partners.length,
          totalApplications,
          disbursedApplications,
          inProcessApplications,
          customers: customers.length,
        },
        assignedTarget: {
          month: now.toLocaleString('default', { month: 'long' }),
          year: currentYear,
          targetValue,
          achievedValue,
        },
        totalDisbursed: totalRevenue, // Overall total disbursed
        performance: targetValue > 0 ? `${((totalRevenue / targetValue) * 100).toFixed(2)}%` : "0.00%",
        monthlyPerformance: monthlyAchieved,
      },
    });
  } catch (error) {
    console.error("Error fetching RM analytics:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/rsm/rm/:rmId/follow-up
// RSM takes follow-up from RM
router.post("/rm/:rmId/follow-up", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { rmId } = req.params;
    const { status, remarks } = req.body;
    const scope = await loadRsmReportingScope(rsmId);

    const rm = await User.findOne({
      _id: rmId,
      role: ROLES.RM,
      ...scope,
    });

    if (!rm) {
      return res.status(404).json({ message: "RM not found or not under this RSM" });
    }

    if (!isValidFollowUpStatus(status)) {
      return res.status(400).json({ message: "Valid status is required" });
    }

    const followUp = new FollowUp({
      targetId: rmId,
      followUpType: "RM",
      status,
      remarks: remarks || "",
      lastCall: new Date(),
      updatedBy: rsmId,
    });

    await followUp.save();

    res.json({
      message: "Follow-up recorded successfully",
      followUp: {
        ...followUp.toObject(),
        lastCall: followUp.lastCall.toISOString(),
        lastCallFormatted: formatFollowUpLastCall(followUp.lastCall),
      },
    });
  } catch (error) {
    console.error("Error recording RM follow-up:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/rsm/rms/follow-ups
// RSM gets all RM follow-ups (+ partner fill performance)
router.get("/rms/follow-ups", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const scope = await loadRsmReportingScope(rsmId);
    const period = parseFollowUpPeriod(req.query);
    const statusFilter = String(req.query.status || "").trim();
    const performanceFilter = String(req.query.performance || "").trim();

    const rms = await User.find({
      role: ROLES.RM,
      ...scope,
    })
      .select("firstName lastName employeeId email phone status")
      .lean();
    const rmIds = rms.map((rm) => rm._id);

    const [followMap, appCounts, fillStats] = await Promise.all([
      latestFollowUpsByTargets({
        targetIds: rmIds,
        followUpType: "RM",
        period,
      }),
      applicationCountsByRm(rmIds, null),
      partnerFillStatsByRm(rmIds, null),
    ]);

    let items = rms.map((rm) => {
      const rk = String(rm._id);
      const followUp = followMap.get(rk);
      const applicationCount = appCounts.get(rk) || 0;
      const stats = fillStats.get(rk) || {
        partnerCount: 0,
        partnersFilled: 0,
        partnersNotFilled: 0,
      };
      const performance = applicationCount > 0 ? "working" : "non_working";

      return {
        rm: {
          id: rm._id,
          name: `${rm.firstName || ""} ${rm.lastName || ""}`.trim(),
          email: rm.email,
          phone: rm.phone,
          employeeId: rm.employeeId,
          accountStatus: rm.status,
        },
        followUp: followUp
          ? {
              status: followUp.status,
              remarks: followUp.remarks,
              lastCall: followUp.lastCall,
              lastCallFormatted: formatFollowUpLastCall(followUp.lastCall),
              updatedBy: followUp.updatedBy
                ? {
                    name: `${followUp.updatedBy.firstName || ""} ${followUp.updatedBy.lastName || ""}`.trim(),
                    employeeId: followUp.updatedBy.employeeId,
                  }
                : null,
            }
          : null,
        applicationCount,
        partnerCount: stats.partnerCount,
        partnersFilled: stats.partnersFilled,
        partnersNotFilled: stats.partnersNotFilled,
        hasFilledForm: stats.partnersFilled > 0,
        performance,
        status: followUp?.status || "N/A",
        remarks: followUp?.remarks || "",
        lastCall: formatFollowUpLastCall(followUp?.lastCall),
      };
    });

    if (statusFilter && statusFilter !== "N/A") {
      items = items.filter((i) => i.status === statusFilter);
    } else if (statusFilter === "N/A") {
      items = items.filter((i) => i.status === "N/A");
    }

    if (performanceFilter === "working" || performanceFilter === "filled") {
      items = items.filter((i) => i.performance === "working");
    } else if (
      performanceFilter === "non_working" ||
      performanceFilter === "not_filled"
    ) {
      items = items.filter((i) => i.performance === "non_working");
    }

    const summary = buildRmFollowUpSummary(items);

    res.json({
      period: period
        ? { start: period.start, end: period.end, label: period.label }
        : null,
      summary,
      items,
      data: items,
    });
  } catch (error) {
    console.error("Error fetching RM follow-ups:", error);
    res.status(500).json({ message: "Server error" });
  }
});



// POST /api/rsm/rm/activate (RSM can activate their RMs)
router.post("/rm-activate", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { rmId } = req.body;

    if (!rmId) {
      return res.status(400).json({ message: "rmId is required" });
    }

    const rsmId = req.user.sub;
    const scope = await loadRsmReportingScope(rsmId);

    const rm = await User.findOne({
      _id: rmId,
      role: ROLES.RM,
      ...scope,
    });

    if (!rm) {
      return res.status(404).json({ message: "RM not found or not under your management" });
    }

    // Activate RM
    const updatedRm = await User.findByIdAndUpdate(
      rmId,
      { status: "ACTIVE" },
      { new: true }
    );

    // 📧 Send activation email
    try {
      await sendMail({
        to: updatedRm.email,
        subject: "Your RM Account Has Been Activated",
        html: `
          <p>Dear ${updatedRm.firstName} ${updatedRm.lastName},</p>
          <p>We are pleased to inform you that your RM account has been <b>activated</b> successfully.</p>
          <p><b>Employee ID:</b> ${updatedRm.employeeId || "-"}<br/>
          <b>RM Code:</b> ${updatedRm.rmCode || "-"}</p>
          <p>You can now log in and continue managing your Partners and their Customers as usual.</p>
          <br/>
          <p>Regards,<br/>DhanSource Capital</p>
        `,
      });
      console.log("📧 RM activation mail sent to:", updatedRm.email);
    } catch (mailErr) {
      console.error("❌ Failed to send RM activation email:", mailErr.message);
    }

    res.json({
      message: "RM activated successfully and notified via email",
    });
  } catch (error) {
    console.error("Error in /rsm/rm/activate:", error);
    res.status(500).json({ message: error.message });
  }
});

// POST /api/rsm/rm/deactivate (RSM can deactivate their RMs) - with automatic reassignment
router.post("/rm-deactivate", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const rmId = req.body?.rmId || req.body?.oldRmId;
    const newRmId = req.body?.newRmId;

    if (!rmId || !newRmId) {
      return res.status(400).json({ message: "Both rmId (or oldRmId) and newRmId are required" });
    }

    const rsmId = req.user.sub;
    const scope = await loadRsmReportingScope(rsmId);

    let newRm;
    let deactivatedRm;
    let partnersModifiedCount = 0;
    let applicationsModifiedCount = 0;
    let customersUpdated = 0;
    let reassignmentAudit;
    let transferStats;
    await session.withTransaction(async () => {
      const oldRm = await User.findOne({
        _id: rmId,
        role: ROLES.RM,
        ...scope,
      }).session(session);

      if (!oldRm) {
        throw new Error("RM not found or not under your management");
      }

      newRm = await User.findOne({
        role: ROLES.RM,
        status: "ACTIVE",
        _id: newRmId,
        ...scope,
      }).session(session);
      if (!newRm) {
        throw new Error("Cannot deactivate RM. The selected replacement active RM was not found.");
      }

      transferStats = await reassignRmWorkload({
        oldRmId: rmId,
        newRmId,
        session,
      });
      partnersModifiedCount = transferStats.movedPartners || 0;
      applicationsModifiedCount = transferStats.movedApplications || 0;
      customersUpdated = transferStats.syncedCustomers || 0;

      deactivatedRm = await User.findByIdAndUpdate(
        rmId,
        { status: "SUSPENDED" },
        { new: true, session }
      );
      reassignmentAudit = buildReassignmentAudit({
        changedBy: req.user.sub,
        oldUserId: rmId,
        newUserId: newRmId,
        action: "rsm_rm_deactivate",
      });
      await persistReassignmentAudit(reassignmentAudit, req, session);
    });

    // 📧 Send deactivation email to old RM
    try {
      await sendMail({
        to: deactivatedRm.email,
        subject: "Your RM Account Has Been Deactivated",
        html: `
          <p>Dear ${deactivatedRm.firstName} ${deactivatedRm.lastName},</p>
          <p>Your RM account has been <b>deactivated</b> by your RSM.</p>
          <p>All your Applications, Partners, and Customers have been reassigned to another RM.</p>
          <p><b>Employee ID:</b> ${deactivatedRm.employeeId || "-"}<br/>
          <b>RM Code:</b> ${deactivatedRm.rmCode || "-"}</p>
          <p>If you believe this action was incorrect, please contact support.</p>
          <br/>
          <p>Regards,<br/>DhanSource Capital</p>
        `,
      });
      console.log("📧 RM deactivation mail sent to:", deactivatedRm.email);
    } catch (mailErr) {
      console.error("❌ Failed to send RM deactivation email:", mailErr.message);
    }

    // 📧 Send notification email to new RM
    try {
      await sendMail({
        to: newRm.email,
        subject: "You Have Been Assigned New Data",
        html: `
          <p>Dear ${newRm.firstName} ${newRm.lastName},</p>
          <p>You have been assigned new Applications, Partners, and Customers from a deactivated RM.</p>
          <p><b>Employee ID:</b> ${newRm.employeeId || "-"}<br/>
          <b>RM Code:</b> ${newRm.rmCode || "-"}</p>
          <p>Please check your dashboard for details.</p>
          <br/>
          <p>Regards,<br/>DhanSource Capital</p>
        `,
      });
      console.log("📧 Assignment mail sent to:", newRm.email);
    } catch (mailErr) {
      console.error("❌ Failed to send assignment email:", mailErr.message);
    }

    res.json({
      message:
        "RM deactivated successfully. Active workload reassigned to another RM while settled history is preserved.",
      reassignmentAudit,
    });
  } catch (error) {
    if (
      error.message === "RM not found or not under your management" ||
      error.message === "Cannot deactivate RM. The selected replacement active RM was not found."
    ) {
      const status =
        error.message === "RM not found or not under your management" ? 404 : 400;
      return res.status(status).json({ message: error.message });
    }
    console.error("Error in /rsm/rm/deactivate:", error);
    res.status(500).json({ message: error.message });
  } finally {
    await session.endSession();
  }
});

// ==================== PARTNERS DIRECTORY (RSM) ====================

// GET /api/rsm/get-partners — partners under RSM → RMs hierarchy
router.get("/get-partners", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const scope = await loadRsmReportingScope(rsmId);

    const rms = await User.find({
      role: ROLES.RM,
      ...scope,
    })
      .select("_id firstName lastName employeeId")
      .lean();
    const rmIds = rms.map((rm) => rm._id);
    const rmMap = Object.fromEntries(rms.map((rm) => [String(rm._id), rm]));

    const rsmOid = toObjectId(rsmId);
    const userBase = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
    const { status } = req.query || {};
    const query = {
      role: ROLES.PARTNER,
      $or: [
        ...(rmIds.length ? [{ rmId: { $in: rmIds } }] : []),
        { asmId: rsmOid },
        { rsmId: rsmOid },
      ],
      ...userBase,
    };
    if (status && status !== "ALL") {
      query.status = status.toUpperCase();
    }

    const partners = await User.find(query)
      .select("-passwordHash -__v")
      .lean();

    const formatted = partners.map((partner) => {
      const rm = rmMap[String(partner.rmId)] || null;
      return {
        ...partner,
        rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,
        rmEmployeeId: rm ? rm.employeeId : null,
        rmId: rm ? rm._id : partner.rmId || null,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching RSM partners:", err);
    res.status(500).json({ message: "Error fetching RSM partners" });
  }
});

// ==================== PARTNER TARGET MANAGEMENT (RSM) ====================

// GET /api/rsm/partners/targets
// RSM gets all partner targets under their hierarchy
router.get("/partners/targets", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { year, month } = req.query;
    const scope = await loadRsmReportingScope(rsmId);

    const rms = await User.find({
      role: ROLES.RM,
      ...scope,
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get all partners under these RMs
    const partners = await User.find({
      role: ROLES.PARTNER,
      rmId: { $in: rmIds },
      status: { $ne: "PENDING" },
    }).select("firstName lastName employeeId email phone rmId region").lean();

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
    const relevantApps = await Application.find(
      activeApplicationsFilter({
        partnerId: { $in: partnerIds },
        status: { $ne: "DRAFT" },
        ...(year && month ? {
          updatedAt: {
            $gte: new Date(year, month - 1, 1),
            $lt: new Date(year, month, 1)
          }
        } : {})
      })
    ).lean();

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
        region: partner.region || null,
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


// partner deactivate
router.post("/partner-deactivate", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { oldPartnerId, newPartnerId } = req.body;
    const rsmId = req.user.sub;

    if (!oldPartnerId || !newPartnerId) {
      return res
        .status(400)
        .json({ message: "Both oldPartnerId and newPartnerId are required" });
    }

    const scope = await loadRsmReportingScope(rsmId);
    const rms = await User.find({
      role: ROLES.RM,
      ...scope,
    })
      .select("_id")
      .session(session);
    const rmIds = rms.map((rm) => rm._id);

    const oldId = new mongoose.Types.ObjectId(oldPartnerId);
    let reassignedCustomers = 0;
    let reassignedApplications = 0;
    let reassignedPayouts = 0;
    let reassignedIncentives = 0;
    let preservedPayoutsDone = 0;
    let preservedIncentivesPaid = 0;
    let deactivatedPartner = null;
    let reassignmentAudit = null;
    let transferStats = null;

    await session.withTransaction(async () => {
      const oldPartner = await User.findById(oldId).session(session);
      if (!oldPartner || oldPartner.role !== ROLES.PARTNER) {
        throw new Error("Old partner not found or not a partner");
      }
      if (!rmIds.some((id) => String(id) === String(oldPartner.rmId))) {
        throw new Error("Partner not under your management");
      }

      const newId = new mongoose.Types.ObjectId(newPartnerId);
      const newPartner = await User.findById(newId).session(session);
      if (
        !newPartner ||
        newPartner.role !== ROLES.PARTNER ||
        !rmIds.some((id) => String(id) === String(newPartner.rmId)) ||
        String(newPartner._id) === String(oldPartner._id)
      ) {
        throw new Error("Valid newPartnerId under your RSM is required");
      }

      transferStats = await reassignPartnerWorkload({
        oldPartnerId,
        newPartnerId,
        session,
      });
      reassignedCustomers = transferStats.movedCustomers || 0;
      reassignedApplications = transferStats.movedApplications || 0;
      reassignedPayouts = transferStats.movedPayouts || 0;
      reassignedIncentives = transferStats.movedIncentives || 0;
      preservedPayoutsDone = transferStats.lockedPayouts || 0;
      preservedIncentivesPaid = transferStats.lockedIncentives || 0;

      deactivatedPartner = await User.findByIdAndUpdate(
        oldId,
        { $set: { status: "SUSPENDED", updatedAt: new Date() } },
        { new: true, session }
      );

      reassignmentAudit = buildReassignmentAudit({
        changedBy: req.user.sub,
        oldUserId: oldPartnerId,
        newUserId: newPartnerId,
        action: "rsm_partner_deactivate",
      });
      await persistReassignmentAudit(reassignmentAudit, req, session);
    });

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
    } catch (mailErr) {
      console.error("❌ Failed to send partner deactivation email:", mailErr.message);
    }

    return res.json({
      message: `Partner ${deactivatedPartner.firstName} ${deactivatedPartner.lastName} has been deactivated. Active workload moved, settled finance/history preserved.`,
      reassignmentAudit,
    });
  } catch (error) {
    if (error.message === "Old partner not found or not a partner") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Partner not under your management") {
      return res.status(403).json({ message: error.message });
    }
    if (error.message === "Valid newPartnerId under your RSM is required") {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error in /rsm/partner/deactivate:", error);
    res.status(500).json({ message: error.message });
  } finally {
    await session.endSession();
  }
});


// partner activate
router.post("/partner-activate", auth, requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { partnerId } = req.body;
  } catch (error) {
    console.error("Error in /rsm/partner/activate:", error);
    res.status(500).json({ message: error.message });
  }
});
export default router;


