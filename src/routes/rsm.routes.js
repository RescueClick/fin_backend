import { Router } from "express";
import argon2 from "argon2";
import mongoose from "mongoose";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES, RSM_TYPES } from "../config/roles.js";
import { User } from "../models/User.js";
import { Application, APP_STATUSES } from "../models/Application.js";
import { BankMaster } from "../models/BankMaster.js";
import { Payout } from "../models/Payout.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { sendUserAccountEmail, sendApplicationStatusEmail } from "../utils/emailService.js";
import { sendMail } from "../utils/sendMail.js";
import { createEmailChangeRequest } from "../utils/emailChangeService.js";
import { emitApplicationStatusChanged } from "../utils/socketEmitter.js";
import { makeRmCode } from "../utils/codes.js";
import { Target } from "../models/Target.js";
import fs from "fs";
import path from "path";
import mime from "mime-types";
import axios from "axios";

const router = Router();

// GET /api/rsm/my-rsms  (ASM only)
// List RSMs under the logged-in ASM
router.get("/my-rsms", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    const list = await User.find({ role: ROLES.RSM, asmId })
      .select("-passwordHash -__v")
      .lean();

    res.json(list);
  } catch (err) {
    console.error("Error fetching RSMs for ASM:", err);
    res.status(500).json({ message: "Error fetching RSMs" });
  }
});

// POST /api/rsm/create-rm
// RSM creates an RM and assigns them to Personal or Business/Home RSM type
router.post(
  "/create-rm",
  auth,
  requireRole(ROLES.RSM),
  async (req, res) => {
    try {
      const { firstName, lastName, phone, dob, region, email, password, assignToRsmType } = req.body || {};
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

      const exists = await User.findOne({ email: email.toLowerCase() });
      if (exists) {
        return res.status(409).json({ message: "Email already in use" });
      }

      const rawPassword = password || `Rm@${Math.random().toString(36).slice(2, 10)}`;

      // Determine which RSM field to set based on assignToRsmType
      const rmData = {
        employeeId: await generateEmployeeId("RM"),
        firstName,
        lastName,
        phone,
        dob,
        region,
        email: email.toLowerCase(),
        passwordHash: await argon2.hash(rawPassword),
        role: ROLES.RM,
        rmCode: makeRmCode(),
      };

      // Set the appropriate RSM link based on type
      if (assignToRsmType === RSM_TYPES.PERSONAL) {
        rmData.personalRsmId = rsmId;
      } else if (assignToRsmType === RSM_TYPES.BUSINESS_HOME) {
        rmData.businessHomeRsmId = rsmId;
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

      return res.status(201).json({
        message: "RM created successfully",
        id: rm._id,
        rmCode: rm.rmCode,
        employeeId: rm.employeeId,
        personalRsmId: rm.personalRsmId,
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
// List RMs under this RSM (both Personal and Business/Home)
router.get("/my-rms", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsmId = req.user.sub;

    // Find RMs assigned to this RSM (either personalRsmId or businessHomeRsmId)
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
    })
      .select("-passwordHash -__v")
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
 * RSM handles loan processing statuses: UNDER_REVIEW → APPROVED/REJECTED → DISBURSED
 */

// POST /api/rsm/applications/:id/transition
// RSM transitions loan applications through processing stages
router.post(
  "/applications/:id/transition",
  auth,
  requireRole(ROLES.RSM),
  async (req, res) => {
    try {
      const { to, note, approvedLoanAmount } = req.body;
      const rsmId = req.user.sub;

      if (!to)
        return res.status(400).json({ message: "Target status 'to' required" });

      // ✅ RSM can ONLY handle processing statuses (including LOGIN)
      const RSM_ALLOWED_STATUSES = [
        "LOGIN",
        "UNDER_REVIEW",
        "APPROVED",
        "AGREEMENT",
        "REJECTED",
        "DISBURSED"
      ];

      if (!RSM_ALLOWED_STATUSES.includes(to)) {
        return res.status(403).json({
            message: `RSM can only transition to processing statuses: ${RSM_ALLOWED_STATUSES.join(", ")}. Document statuses are handled by RM.`
        });
      }

      if (!APP_STATUSES.includes(to))
        return res.status(400).json({ message: "Invalid status" });

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
        // After RM marks DOC_COMPLETE, RSM must first LOGIN, then move to UNDER_REVIEW
        DOC_COMPLETE: ["LOGIN"],
        LOGIN: ["UNDER_REVIEW"],
        UNDER_REVIEW: ["APPROVED", "REJECTED"],
        APPROVED: ["AGREEMENT", "DISBURSED"],
        AGREEMENT: ["DISBURSED"],
      };

      if (!allowedTransitions[currentStatus]?.includes(to)) {
        return res.status(400).json({
          message: `Cannot transition from ${currentStatus} to ${to}. Allowed transitions: ${
            allowedTransitions[currentStatus]?.join(", ") || "none"
          }`,
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

      // ✅ If status = REJECTED → mark for auto-delete after 3 months
      if (to === "REJECTED") {
        const threeMonthsLater = new Date(
          Date.now() + 90 * 24 * 60 * 60 * 1000
        );
        app.deletedAt = threeMonthsLater; // Application TTL
        await User.findByIdAndUpdate(app.customerId._id, {
          deletedAt: threeMonthsLater, // Customer TTL
        });
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
router.get("/applications", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { status } = req.query;

    // ✅ Convert rsmId to ObjectId to ensure proper matching
    let rsmObjectId;
    try {
      rsmObjectId = mongoose.Types.ObjectId.isValid(rsmId) 
        ? new mongoose.Types.ObjectId(rsmId) 
        : rsmId;
    } catch (err) {
      console.error("Error converting rsmId to ObjectId:", err);
      rsmObjectId = rsmId;
    }

    // ✅ Get RSM details to verify rsmType and filter by loan type
    const rsm = await User.findById(rsmId).select("rsmType").lean();
    if (!rsm) {
      return res.status(404).json({ message: "RSM not found" });
    }

    // ✅ Filter by loan type based on RSM type
    // PERSONAL RSM → only PERSONAL loans
    // BUSINESS_HOME RSM → BUSINESS, HOME_LOAN_SALARIED, HOME_LOAN_SELF_EMPLOYED loans
    // If rsmType is not set, show all applications with this rsmId (for backward compatibility)
    let loanTypeFilter = {};
    if (rsm.rsmType === RSM_TYPES.PERSONAL) {
      loanTypeFilter = { loanType: "PERSONAL" };
      console.log(`   🔍 Filtering for PERSONAL loans only (RSM Type: ${rsm.rsmType})`);
    } else if (rsm.rsmType === RSM_TYPES.BUSINESS_HOME) {
      loanTypeFilter = { loanType: { $in: ["BUSINESS", "HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED"] } };
      console.log(`   🔍 Filtering for BUSINESS/HOME loans only (RSM Type: ${rsm.rsmType})`);
    } else {
      // If rsmType is not set, don't filter by loan type - show all applications assigned to this RSM
      console.log(`   ⚠️ RSM has no rsmType set (${rsm.rsmType}), showing ALL applications with this rsmId (no loan type filter)`);
    }

    // ✅ RSM should see all applications assigned to them (rsmId matches)
    const filter = { 
      rsmId: rsmObjectId,
      ...loanTypeFilter
    };
    
    // If status filter is provided, use it; otherwise show all applications assigned to this RSM
    if (status) {
      filter.status = status;
    }
    // Note: We don't restrict by status by default - RSM should see all applications assigned to them
    // Typically these will be DOC_COMPLETE or beyond, but we allow flexibility

    console.log(`🔍 RSM ${rsmId} (Type: ${rsm.rsmType}, ObjectId: ${rsmObjectId}) query filter:`, JSON.stringify(filter, null, 2));

    // ✅ BACKFILL: Find DOC_COMPLETE applications without rsmId and assign them to this RSM if they match
    // This handles cases where applications were set to DOC_COMPLETE before the routing logic was added
    let backfilledCount = 0;
    
    // First, find all DOC_COMPLETE applications without rsmId (regardless of loan type for now)
    const docCompleteWithoutRsm = await Application.find({
      status: "DOC_COMPLETE",
      $or: [
        { rsmId: { $exists: false } },
        { rsmId: null }
      ]
    })
      .populate("rmId", "personalRsmId businessHomeRsmId")
      .select("_id appNo loanType rmId")
      .lean();

    console.log(`   🔍 Found ${docCompleteWithoutRsm.length} DOC_COMPLETE applications without rsmId (all loan types)`);
    
    if (docCompleteWithoutRsm.length > 0) {
      console.log(`   🔄 Attempting backfill for RSM ${rsmId} (Type: ${rsm.rsmType})...`);
      
      for (const app of docCompleteWithoutRsm) {
        if (!app.rmId) {
          console.log(`   ⚠️ Application ${app.appNo} has no RM assigned, skipping`);
          continue;
        }
        
        // Determine which RSM should handle this based on RM's assignment
        let shouldAssignToThisRsm = false;
        const rmPersonalRsmId = app.rmId.personalRsmId?.toString();
        const rmBusinessHomeRsmId = app.rmId.businessHomeRsmId?.toString();
        const currentRsmIdStr = rsmObjectId.toString();
        
        console.log(`   🔍 Checking app ${app.appNo} (${app.loanType}): RM personalRsmId=${rmPersonalRsmId}, businessHomeRsmId=${rmBusinessHomeRsmId}, current RSM=${currentRsmIdStr}`);
        
        if (app.loanType === "PERSONAL") {
          if (rmPersonalRsmId === currentRsmIdStr) {
            shouldAssignToThisRsm = true;
            console.log(`   ✅ Match: PERSONAL loan matches this RSM`);
          } else {
            console.log(`   ❌ No match: PERSONAL loan RSM (${rmPersonalRsmId}) != current RSM (${currentRsmIdStr})`);
          }
        } else if (
          ["BUSINESS", "HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED"].includes(app.loanType)
        ) {
          if (rmBusinessHomeRsmId === currentRsmIdStr) {
            shouldAssignToThisRsm = true;
            console.log(`   ✅ Match: ${app.loanType} loan matches this RSM`);
          } else {
            console.log(`   ❌ No match: ${app.loanType} loan RSM (${rmBusinessHomeRsmId}) != current RSM (${currentRsmIdStr})`);
          }
        } else {
          console.log(`   ⚠️ Unknown loan type: ${app.loanType}`);
        }
        
        if (shouldAssignToThisRsm) {
          // Get ASM from RSM
          const rsmWithAsm = await User.findById(rsmObjectId).select("asmId").lean();
          const asmId = rsmWithAsm?.asmId || null;
          
          await Application.updateOne(
            { _id: app._id },
            { 
              $set: { 
                rsmId: rsmObjectId,
                asmId: asmId
              }
            }
          );
          backfilledCount++;
          console.log(`   ✅ Backfilled application ${app.appNo} (${app.loanType}) → RSM ${rsmId} (ASM: ${asmId})`);
        }
      }
      
      console.log(`   📊 Backfilled ${backfilledCount} applications for RSM ${rsmId}`);
      
      // Also check for applications that couldn't be backfilled because RM doesn't have RSM assigned
      const unassignedApps = docCompleteWithoutRsm.filter(app => {
        if (!app.rmId) return false;
        if (app.loanType === "PERSONAL" && !app.rmId.personalRsmId) return true;
        if (["BUSINESS", "HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED"].includes(app.loanType) && !app.rmId.businessHomeRsmId) return true;
        return false;
      });
      
      if (unassignedApps.length > 0) {
        console.log(`   ⚠️ WARNING: ${unassignedApps.length} DOC_COMPLETE applications cannot be assigned because their RM doesn't have an RSM assigned:`);
        unassignedApps.forEach(app => {
          console.log(`      - ${app.appNo} (${app.loanType}): RM ${app.rmId._id || app.rmId} missing ${app.loanType === "PERSONAL" ? "personalRsmId" : "businessHomeRsmId"}`);
        });
      }
    }

    // ✅ Fetch applications with documents included so RSM can see all document details
    let applications = await Application.find(filter)
      .populate("customerId", "firstName lastName email phone employeeId")
      .populate("partnerId", "firstName lastName employeeId")
      .populate("rmId", "firstName lastName employeeId")
      .select("-stageHistory") // Include docs, exclude stageHistory
      .sort({ createdAt: -1 })
      .lean();

    console.log(`✅ RSM ${rsmId} (Type: ${rsm.rsmType}) fetched ${applications.length} applications after backfill`);
    
    // If we backfilled applications, they should now appear in the query
    // But if still no results, let's check if there are any applications with this rsmId (without loan type filter)
    if (applications.length === 0 && backfilledCount === 0) {
      console.log(`   🔍 No applications found with filter. Checking all applications with rsmId=${rsmObjectId} (no loan type filter)...`);
      const allAppsWithRsmId = await Application.find({ rsmId: rsmObjectId })
        .select("appNo status loanType rsmId")
        .lean();
      console.log(`   📊 Found ${allAppsWithRsmId.length} total applications with rsmId=${rsmObjectId}`);
      if (allAppsWithRsmId.length > 0) {
        console.log(`   📋 Applications:`, allAppsWithRsmId.map(a => `${a.appNo}: ${a.status} (${a.loanType})`));
        // If RSM has rsmType set but we found apps with different loan types, that's the issue
        if (rsm.rsmType) {
          const matchingLoanTypes = allAppsWithRsmId.filter(a => 
            (rsm.rsmType === RSM_TYPES.PERSONAL && a.loanType === "PERSONAL") ||
            (rsm.rsmType === RSM_TYPES.BUSINESS_HOME && ["BUSINESS", "HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED"].includes(a.loanType))
          );
          console.log(`   ⚠️ Only ${matchingLoanTypes.length} applications match RSM's loan type filter`);
        }
      }
    }
    if (applications.length > 0) {
      const statusCounts = applications.reduce((acc, app) => {
        acc[app.status] = (acc[app.status] || 0) + 1;
        return acc;
      }, {});
      const loanTypeCounts = applications.reduce((acc, app) => {
        acc[app.loanType] = (acc[app.loanType] || 0) + 1;
        return acc;
      }, {});
      console.log(`   Status breakdown:`, statusCounts);
      console.log(`   Loan type breakdown:`, loanTypeCounts);
      console.log(`   DOC_COMPLETE applications: ${statusCounts.DOC_COMPLETE || 0}`);
    } else {
      // Debug: Check if there are any applications with this rsmId but different status
      const allApps = await Application.find({ rsmId: rsmObjectId }).select("appNo status rsmId loanType").lean();
      console.log(`   ⚠️ Found ${allApps.length} total applications with rsmId=${rsmId} (ObjectId: ${rsmObjectId}):`, allApps.map(a => `${a.appNo || a._id}: ${a.status} (loanType: ${a.loanType}, rsmId: ${a.rsmId})`));
      
      // Check if loan type filter is excluding applications
      if (rsm.rsmType === RSM_TYPES.PERSONAL) {
        const personalApps = allApps.filter(a => a.loanType === "PERSONAL");
        console.log(`   📊 Personal loan applications with this rsmId: ${personalApps.length}`);
        if (personalApps.length > 0) {
          console.log(`   📋 Personal loan apps:`, personalApps.map(a => `${a.appNo}: ${a.status}`));
        }
        if (allApps.length > personalApps.length) {
          console.log(`   ⚠️ WARNING: ${allApps.length - personalApps.length} non-PERSONAL applications found but filtered out`);
        }
      } else if (rsm.rsmType === RSM_TYPES.BUSINESS_HOME) {
        const businessHomeApps = allApps.filter(a => ["BUSINESS", "HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED"].includes(a.loanType));
        console.log(`   📊 Business/Home loan applications with this rsmId: ${businessHomeApps.length}`);
        if (businessHomeApps.length > 0) {
          console.log(`   📋 Business/Home loan apps:`, businessHomeApps.map(a => `${a.appNo}: ${a.status} (${a.loanType})`));
        }
        if (allApps.length > businessHomeApps.length) {
          console.log(`   ⚠️ WARNING: ${allApps.length - businessHomeApps.length} non-BUSINESS/HOME applications found but filtered out`);
        }
      }
      
      // Also check for DOC_COMPLETE applications that might not have rsmId set yet
      const docCompleteApps = await Application.find({ 
        status: "DOC_COMPLETE",
        $or: [
          { rsmId: { $exists: false } },
          { rsmId: null }
        ]
      }).select("appNo status loanType rmId").lean();
      if (docCompleteApps.length > 0) {
        console.log(`   ⚠️ Found ${docCompleteApps.length} DOC_COMPLETE applications without rsmId assigned`);
      }
      
      // Check all DOC_COMPLETE applications to see their rsmId values
      const allDocComplete = await Application.find({ status: "DOC_COMPLETE" })
        .select("appNo status rsmId loanType")
        .lean();
      console.log(`   📊 Total DOC_COMPLETE applications: ${allDocComplete.length}`);
      if (allDocComplete.length > 0) {
        const rsmIdCounts = {};
        allDocComplete.forEach(app => {
          const rsmIdStr = app.rsmId ? app.rsmId.toString() : "null";
          rsmIdCounts[rsmIdStr] = (rsmIdCounts[rsmIdStr] || 0) + 1;
        });
        console.log(`   📊 DOC_COMPLETE applications by rsmId:`, rsmIdCounts);
        console.log(`   🔍 Looking for rsmId: ${rsmId} (ObjectId: ${rsmObjectId.toString()})`);
      }
    }

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
router.get("/applications/:id", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { id } = req.params;

    // Find application assigned to this RSM
    const application = await Application.findOne({
      _id: id,
      rsmId: rsmId,
    })
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
  requireRole(ROLES.RSM),
  async (req, res) => {
    try {
      const { id, docType } = req.params;
      const rsmId = req.user.sub;

      // Find application assigned to this RSM
      const app = await Application.findOne({
        _id: id,
        rsmId: rsmId,
      }).lean();

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
          const response = await axios.get(actualUrl, { 
            responseType: "stream",
            timeout: 30000, // 30 second timeout
            maxRedirects: 5
          });
          
          contentType = response.headers["content-type"] || "application/octet-stream";
          
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
router.get("/dashboard", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsmId = req.user.sub;

    // RSM profile
    const rsm = await User.findOne({ _id: rsmId, role: ROLES.RSM }).lean();
    if (!rsm) return res.status(404).json({ message: "RSM not found" });

    // Get all RMs under this RSM (via personalRsmId OR businessHomeRsmId)
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // All partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).lean();
    const partnerIds = partners.map((p) => p._id);

    // Totals
    const totalRMs = rms.length;
    const totalPartners = partners.length;
    const activePartners = await User.countDocuments({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
      status: "ACTIVE",
    });

    const customers = await Application.distinct("customerId", {
      rsmId: rsmId,
    });
    const totalCustomers = customers.length;

    // Applications by status
    const inProcessApplications = await Application.countDocuments({
      rsmId: rsmId,
      status: { $in: ["UNDER_REVIEW", "APPROVED", "AGREEMENT"] },
    });

    const pendingApplications = await Application.countDocuments({
      rsmId: rsmId,
      status: "DOC_COMPLETE",
    });

    const disbursedApplications = await Application.countDocuments({
      rsmId: rsmId,
      status: "DISBURSED",
    });

    const rejectedApplications = await Application.countDocuments({
      rsmId: rsmId,
      status: "REJECTED",
    });

    // Revenue from disbursed loans
    const revenueAgg = await Application.aggregate([
      {
        $match: {
          rsmId: new mongoose.Types.ObjectId(rsmId),
          status: "DISBURSED",
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
          status: "DISBURSED",
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
          status: "DISBURSED",
          updatedAt: { $gte: startOfYear },
        },
      },
      {
        $group: {
          _id: { month: { $month: "$updatedAt" } },
          totalAchieved: { $sum: { $toDouble: "$approvedLoanAmount" } },
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

    // Recent Applications for Pipeline (last 10 applications)
    const recentApplications = await Application.find({
      rsmId: rsmId,
      status: { $in: ["DOC_COMPLETE", "UNDER_REVIEW", "APPROVED", "AGREEMENT"] },
    })
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
        totalRMs,
        totalPartners,
        activePartners,
        totalCustomers,
        totalRevenue,
        avgRating,
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
router.get("/profile", auth, requireRole(ROLES.RSM), async (req, res) => {
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
router.patch("/profile/update", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const {
      firstName,
      lastName,
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
      phone,
      dob,
      address,
      region,
      experience,
    };

    Object.keys(updateData).forEach(
      (key) => updateData[key] === undefined && delete updateData[key]
    );

    const updatedRsm = await User.findOneAndUpdate(
      { _id: rsmId, role: ROLES.RSM },
      { $set: updateData },
      { new: true, runValidators: true, projection: "-passwordHash" }
    );

    if (!updatedRsm) return res.status(404).json({ message: "RSM not found" });

    let emailChangePending = false;
    let emailChangeMessage = null;

    if (
      email &&
      String(email).toLowerCase() !== String(updatedRsm.email).toLowerCase()
    ) {
      const normalizedEmail = String(email).toLowerCase();

      const exists = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: rsmId },
      });

      if (exists) return res.status(409).json({ message: "Email already in use" });

      const currentRsm = await User.findById(rsmId).select("email firstName");

      await createEmailChangeRequest({
        user: currentRsm,
        newEmail: normalizedEmail,
        clientUrl: process.env.CLIENT_URL,
      });

      emailChangePending = true;
      emailChangeMessage =
        "Email change link sent. Please confirm via the link in your inbox.";
    }

    const profileObj = updatedRsm?.toObject ? updatedRsm.toObject() : updatedRsm;
    if (emailChangePending) {
      profileObj.emailChangePending = true;
      profileObj.emailChangeMessage = emailChangeMessage;
    }

    res.json({
      message: emailChangePending
        ? emailChangeMessage
        : "Profile updated successfully",
      profile: profileObj,
      emailChangePending,
    });
  } catch (err) {
    console.error("Error updating RSM profile:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== BANK MASTER (RSM) ====================

// GET /api/rsm/banks
// RSM fetches banks allowed for their rsmType
router.get("/banks", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsm = await User.findById(req.user.sub)
      .select("rsmType")
      .lean();

    if (!rsm) {
      return res.status(404).json({ message: "RSM not found" });
    }

    if (!rsm.rsmType) {
      return res.status(400).json({
        message: "RSM type is not set for this user. Please contact admin.",
      });
    }

    const banks = await BankMaster.find({
      isActive: true,
      rsmTypes: rsm.rsmType,
    })
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
    const filtered = banks.filter((b) => {
      const lt = normalizeLoanType(b.loanType);
      if (rsmType === String(RSM_TYPES.PERSONAL)) return lt === "PERSONAL";
      if (rsmType === String(RSM_TYPES.BUSINESS_HOME)) return lt === "BUSINESS" || lt.startsWith("HOME_LOAN_");
      return true;
    });

    return res.json(filtered);
  } catch (err) {
    console.error("Error fetching banks for RSM:", err);
    return res.status(500).json({ message: "Error fetching banks" });
  }
});

// GET /api/rsm/rm/:rmId/analytics
// RSM views analytics for a specific RM
router.get("/rm/:rmId/analytics", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { rmId } = req.params;

    // Verify RM belongs to this RSM
    const rm = await User.findOne({
      _id: rmId,
      role: ROLES.RM,
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
    }).lean();
    
    if (!rm) {
      return res.status(404).json({ message: "RM not found or not under this RSM" });
    }

    // Get partners under this RM
    const partners = await User.find({
      rmId,
      role: ROLES.PARTNER,
    }).lean();

    // Applications assigned to this RM (or from partners under this RM)
    const partnerIds = partners.map((p) => p._id);
    const totalApplications = await Application.countDocuments({
      $or: [
        { rmId },
        { partnerId: { $in: partnerIds } }
      ]
    });
    
    const disbursedApplications = await Application.countDocuments({ 
      $or: [
        { rmId },
        { partnerId: { $in: partnerIds } }
      ],
      status: "DISBURSED" 
    });
    
    const inProcessApplications = await Application.countDocuments({
      $or: [
        { rmId },
        { partnerId: { $in: partnerIds } }
      ],
      status: { $in: ["UNDER_REVIEW", "APPROVED", "AGREEMENT", "DOC_COMPLETE"] },
    });

    // Revenue from disbursed loans
    const revenueAgg = await Application.aggregate([
      {
        $match: {
          $or: [
            { rmId: new mongoose.Types.ObjectId(rmId) },
            { partnerId: { $in: partnerIds.map(id => new mongoose.Types.ObjectId(id)) } }
          ],
          status: "DISBURSED",
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
    const customers = await Application.distinct("customerId", {
      $or: [
        { rmId },
        { partnerId: { $in: partnerIds } }
      ]
    });
    
    // Wrap in data object to match universal format
    res.json({
      data: {
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
      },
    });
  } catch (error) {
    console.error("Error fetching RM analytics:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/rsm/rm/:rmId/follow-up
// RSM takes follow-up from RM
router.post("/rm/:rmId/follow-up", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { rmId } = req.params;
    const { status, remarks } = req.body;

    // Verify RM belongs to this RSM
    const rm = await User.findOne({
      _id: rmId,
      role: ROLES.RM,
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
    });
    
    if (!rm) {
      return res.status(404).json({ message: "RM not found or not under this RSM" });
    }

    if (!status || !["Connected", "Ringing", "Switch Off", "Not Reachable"].includes(status)) {
      return res.status(400).json({ message: "Valid status is required" });
    }

    const FollowUp = (await import("../models/followUp.js")).FollowUp;
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
      },
    });
  } catch (error) {
    console.error("Error recording RM follow-up:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/rsm/rms/follow-ups
// RSM gets all RM follow-ups
router.get("/rms/follow-ups", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsmId = req.user.sub;

    // Get all RMs under this RSM
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    const FollowUp = (await import("../models/followUp.js")).FollowUp;
    
    // Get latest follow-up for each RM
    const followUps = await FollowUp.find({
      targetId: { $in: rmIds },
      followUpType: "RM",
    })
      .sort({ lastCall: -1 })
      .populate("targetId", "firstName lastName employeeId email phone")
      .populate("updatedBy", "firstName lastName employeeId")
      .lean();

    // Group by RM and get latest
    const rmFollowUpsMap = {};
    followUps.forEach((fu) => {
      const rmId = fu.targetId._id.toString();
      if (!rmFollowUpsMap[rmId] || new Date(fu.lastCall) > new Date(rmFollowUpsMap[rmId].lastCall)) {
        rmFollowUpsMap[rmId] = fu;
      }
    });

    // Format response
    const formatted = rms.map((rm) => {
      const followUp = rmFollowUpsMap[rm._id.toString()];
      return {
        rm: {
          id: rm._id,
          name: `${rm.firstName} ${rm.lastName}`,
          email: rm.email,
          phone: rm.phone,
          employeeId: rm.employeeId,
        },
        followUp: followUp
          ? {
              status: followUp.status,
              remarks: followUp.remarks,
              lastCall: followUp.lastCall,
              updatedBy: followUp.updatedBy
                ? {
                    name: `${followUp.updatedBy.firstName} ${followUp.updatedBy.lastName}`,
                    employeeId: followUp.updatedBy.employeeId,
                  }
                : null,
            }
          : null,
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error("Error fetching RM follow-ups:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/rsm/activate (ASM can activate RSM)
router.post("/activate", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { rsmId } = req.body;

    if (!rsmId) {
      return res.status(400).json({ message: "rsmId is required" });
    }

    const asmId = req.user.sub;

    // Verify RSM belongs to this ASM
    const rsm = await User.findOneAndUpdate(
      { _id: rsmId, role: ROLES.RSM, asmId },
      { status: "ACTIVE" },
      { new: true }
    );

    if (!rsm) {
      return res.status(404).json({ message: "RSM not found or not under your management" });
    }

    // 📧 Send activation email
    try {
      await sendMail({
        to: rsm.email,
        subject: "Your RSM Account Has Been Activated",
        html: `
          <p>Dear ${rsm.firstName} ${rsm.lastName},</p>
          <p>We are pleased to inform you that your RSM account has been <b>activated</b> successfully.</p>
          <p><b>Employee ID:</b> ${rsm.employeeId || "-"}<br/>
          <b>RSM Type:</b> ${rsm.rsmType || "-"}</p>
          <p>You can now log in and start managing your RMs and applications as usual.</p>
          <br/>
          <p>Regards,<br/>Trustline Fintech</p>
        `,
      });
      console.log("📧 RSM activation mail sent to:", rsm.email);
    } catch (mailErr) {
      console.error("❌ Failed to send RSM activation email:", mailErr.message);
    }

    res.json({
      message: "RSM activated successfully and notified via email",
      rsm,
    });
  } catch (error) {
    console.error("Error in /rsm/activate:", error);
    res.status(500).json({ message: error.message });
  }
});

// POST /api/rsm/deactivate (ASM can deactivate RSM)
router.post("/deactivate", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { rsmId } = req.body;

    if (!rsmId) {
      return res.status(400).json({ message: "rsmId is required" });
    }

    const asmId = req.user.sub;

    // Verify RSM belongs to this ASM
    const rsm = await User.findOneAndUpdate(
      { _id: rsmId, role: ROLES.RSM, asmId },
      { status: "SUSPENDED" },
      { new: true }
    );

    if (!rsm) {
      return res.status(404).json({ message: "RSM not found or not under your management" });
    }

    // 📧 Send deactivation email
    try {
      await sendMail({
        to: rsm.email,
        subject: "Your RSM Account Has Been Deactivated",
        html: `
          <p>Dear ${rsm.firstName} ${rsm.lastName},</p>
          <p>Your RSM account has been <b>deactivated</b> by your ASM.</p>
          <p><b>Employee ID:</b> ${rsm.employeeId || "-"}<br/>
          <b>RSM Type:</b> ${rsm.rsmType || "-"}</p>
          <p>If you believe this action was incorrect, please contact support.</p>
          <br/>
          <p>Regards,<br/>Trustline Fintech</p>
        `,
      });
      console.log("📧 RSM deactivation mail sent to:", rsm.email);
    } catch (mailErr) {
      console.error("❌ Failed to send RSM deactivation email:", mailErr.message);
    }

    res.json({
      message: "RSM deactivated successfully and notified via email",
      rsm,
    });
  } catch (error) {
    console.error("Error in /rsm/deactivate:", error);
    res.status(500).json({ message: error.message });
  }
});

// POST /api/rsm/rm/activate (RSM can activate their RMs)
router.post("/rm/activate", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const { rmId } = req.body;

    if (!rmId) {
      return res.status(400).json({ message: "rmId is required" });
    }

    const rsmId = req.user.sub;

    // Verify RM belongs to this RSM (either personalRsmId or businessHomeRsmId)
    const rm = await User.findOne({
      _id: rmId,
      role: ROLES.RM,
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
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
          <p>Regards,<br/>Trustline Fintech</p>
        `,
      });
      console.log("📧 RM activation mail sent to:", updatedRm.email);
    } catch (mailErr) {
      console.error("❌ Failed to send RM activation email:", mailErr.message);
    }

    res.json({
      message: "RM activated successfully and notified via email",
      rm: updatedRm,
    });
  } catch (error) {
    console.error("Error in /rsm/rm/activate:", error);
    res.status(500).json({ message: error.message });
  }
});

// POST /api/rsm/rm/deactivate (RSM can deactivate their RMs) - with automatic reassignment
router.post("/rm/deactivate", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const { rmId } = req.body;

    if (!rmId) {
      return res.status(400).json({ message: "rmId is required" });
    }

    const rsmId = req.user.sub;

    // Verify RM belongs to this RSM (either personalRsmId or businessHomeRsmId)
    const oldRm = await User.findOne({
      _id: rmId,
      role: ROLES.RM,
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
    });

    if (!oldRm) {
      return res.status(404).json({ message: "RM not found or not under your management" });
    }

    // Find another active RM under this RSM
    let newRm = await User.findOne({
      role: ROLES.RM,
      status: "ACTIVE",
      _id: { $ne: rmId },
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
    });

    // If no RM found under this RSM, find any active RM under the same ASM
    if (!newRm && oldRm.asmId) {
      newRm = await User.findOne({
        role: ROLES.RM,
        status: "ACTIVE",
        _id: { $ne: rmId },
        asmId: oldRm.asmId
      });
    }

    if (!newRm) {
      return res.status(400).json({ 
        message: "Cannot deactivate RM. No other active RM found under your management to reassign data." 
      });
    }

    // 1️⃣ Reassign all Partners from old RM to new RM first
    const partners = await User.find(
      { role: ROLES.PARTNER, rmId: rmId },
      "_id"
    );
    const partnerIds = partners.map((p) => p._id);
    const partnersUpdated = await User.updateMany(
      { role: ROLES.PARTNER, rmId: rmId },
      { $set: { rmId: newRm._id } }
    );

    // 2️⃣ Reassign all Applications from old RM to new RM
    // This includes both direct rmId assignments and applications via partners
    const appsUpdated = await Application.updateMany(
      {
        $or: [
          { rmId: rmId }, // Direct RM assignment
          { partnerId: { $in: partnerIds } } // Applications from partners under old RM
        ]
      },
      { $set: { rmId: newRm._id } }
    );

    // 3️⃣ Reassign all Customers of those Partners
    let customersUpdated = 0;
    if (partnerIds.length > 0) {
      const customerUpdate = await User.updateMany(
        { partnerId: { $in: partnerIds } },
        { $set: { rmId: newRm._id } }
      );
      customersUpdated = customerUpdate.modifiedCount;
    }

    // 4️⃣ Deactivate the old RM
    const deactivatedRm = await User.findByIdAndUpdate(
      rmId,
      { status: "SUSPENDED" },
      { new: true }
    );

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
          <p>Regards,<br/>Trustline Fintech</p>
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
          <p>Regards,<br/>Trustline Fintech</p>
        `,
      });
      console.log("📧 Assignment mail sent to:", newRm.email);
    } catch (mailErr) {
      console.error("❌ Failed to send assignment email:", mailErr.message);
    }

    res.json({
      message: "RM deactivated successfully. All data reassigned to another RM.",
      reassigned: {
        applications: appsUpdated.modifiedCount,
        partners: partnersUpdated.modifiedCount,
        customers: customersUpdated
      },
      newRm: {
        id: newRm._id,
        name: `${newRm.firstName} ${newRm.lastName}`,
        employeeId: newRm.employeeId
      }
    });
  } catch (error) {
    console.error("Error in /rsm/rm/deactivate:", error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== PARTNER TARGET MANAGEMENT (RSM) ====================

// GET /api/rsm/partners/targets
// RSM gets all partner targets under their hierarchy
router.get("/partners/targets", auth, requireRole(ROLES.RSM), async (req, res) => {
  try {
    const rsmId = req.user.sub;
    const { year, month } = req.query;

    // Get all RMs under this RSM
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get all partners under these RMs
    const partners = await User.find({
      role: ROLES.PARTNER,
      rmId: { $in: rmIds },
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

    // Get disbursed applications for achievement calculation
    const disbursedApps = await Application.find({
      status: "DISBURSED",
      partnerId: { $in: partnerIds },
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
      const partnerDisbursed = disbursedApps.filter(
        (app) => app.partnerId.toString() === partner._id.toString()
      );

      const fileCountTarget = target?.fileCountTarget || 4;
      const disbursementTarget = target?.disbursementTarget || 2000000;
      const achievedFileCount = partnerDisbursed.length;
      const achievedDisbursement = partnerDisbursed.reduce(
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


