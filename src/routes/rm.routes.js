import { Router } from "express";
import argon2 from "argon2";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { User } from "../models/User.js";
import { makePartnerCode } from "../utils/codes.js";
import { Application, APP_STATUSES } from "../models/Application.js";
import { Payout } from "../models/Payout.js";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { Target } from "../models/Target.js";
import mongoose from "mongoose";
import mime from "mime-types";
import { partnerUpload } from "../middleware/profileUpload.js";
import { upload } from "../middleware/upload.js";
import { FollowUp } from "../models/followUp.js";
import dayjs from "dayjs";
import { sendMail } from "../utils/sendMail.js";
import axios from "axios";
import { emitDocumentStatusChanged, emitApplicationStatusChanged } from "../utils/socketEmitter.js";

const router = Router();

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
      const exists = await User.findOne({
        $or: [{ email: email.toLowerCase() }, { phone }],
      });

      if (exists) {
        return res
          .status(409)
          .json({ message: "Email or phone already in use" });
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
            <p>Regards,<br/>Trustline Fintech</p>
          `,
        });
        console.log("📧 Partner creation mail sent to:", partner.email);
      } catch (mailErr) {
        console.error(
          "❌ Failed to send partner creation email:",
          mailErr.message
        );
      }

      // 🔹 STEP 2: Redistribute RM target among all Partners
      const now = new Date();
      const month = now.getMonth() + 1; // current month
      const year = now.getFullYear();

      const rmTargetDoc = await Target.findOne({
        assignedTo: req.user.sub,
        role: ROLES.RM,
        month,
        year,
      });

      if (rmTargetDoc) {
        // Get all Partners under this RM
        const partners = await User.find({
          role: ROLES.PARTNER,
          rmId: req.user.sub,
        }).lean();

        const rawTargetValue = Number(rmTargetDoc.targetValue);
        const partnerCount = partners.length;

        // Avoid NaN/Infinity: only redistribute when we have a valid, positive target and at least one partner
        if (partnerCount > 0 && Number.isFinite(rawTargetValue) && rawTargetValue > 0) {
          const perPartnerTarget = rawTargetValue / partnerCount;

          for (let p of partners) {
            let pT = await Target.findOne({
              assignedTo: p._id,
              role: ROLES.PARTNER,
              month,
              year,
            });

            if (pT) {
              pT.targetValue = perPartnerTarget; // redistribute equally
              await pT.save();
            } else {
              pT = await Target.create({
                assignedBy: rmTargetDoc.assignedBy,
                assignedTo: p._id,
                role: ROLES.PARTNER,
                month,
                year,
                targetValue: perPartnerTarget,
              });
            }
          }
        }
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
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

router.get("/get-partners", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub;

    // Fetch all partners under this RM
    const partners = await User.find({ role: ROLES.PARTNER, rmId })
      .select("-passwordHash")
      .lean();

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const BASE_URL = process.env.BACKEND_URL || "http://localhost:5000";

    const partnerData = await Promise.all(
      partners.map(async (partner) => {
        // Get RM info to fetch ASM
        const rm = await User.findById(partner.rmId)
          .select("firstName lastName asmId")
          .lean();

        // Get ASM info from RM
        const asm = rm?.asmId
          ? await User.findById(rm.asmId).select("firstName lastName").lean()
          : null;

        // ===== Revenue (from Payouts) =====
        const revenueAgg = await Payout.aggregate([
          { $match: { partnerId: partner._id } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]);
        const revenueGenerated = revenueAgg[0]?.total || 0;

        // ===== Disbursed Loans =====
        const disbursedAgg = await Application.aggregate([
          { $match: { partnerId: partner._id, status: "DISBURSED" } },
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: "$approvedLoanAmount" } },
            },
          },
        ]);
        const totalDisbursed = disbursedAgg[0]?.total || 0;

        // ===== Assigned Target =====
        const targetDoc = await Target.findOne({
          assignedTo: partner._id,
          role: ROLES.PARTNER,
          month: currentMonth,
          year: currentYear,
        });
        const assignedTarget = targetDoc ? Number(targetDoc.targetValue) : 0;

        // ===== Performance % =====
        const performance =
          assignedTarget > 0
            ? ((totalDisbursed / assignedTarget) * 100).toFixed(2)
            : "0.00";

        // ===== Deals & Success =====
        const dealsCount = await Application.countDocuments({
          partnerId: partner._id,
        });
        const successCount = await Application.countDocuments({
          partnerId: partner._id,
          status: "APPROVED",
        });
        const successRate =
          dealsCount > 0 ? Math.round((successCount / dealsCount) * 100) : 0;

        // ===== Profile Pic =====
        const selfieDoc = (partner.docs || [])
          .find((doc) => doc.docType === "SELFIE");
        
        let profilePicUrl = null;
        if (selfieDoc?.url) {
          // Check if URL already starts with http/https (absolute URL)
          if (selfieDoc.url.startsWith("http://") || selfieDoc.url.startsWith("https://")) {
            profilePicUrl = selfieDoc.url;
          } else {
            // Relative URL - prepend BASE_URL
            const cleanPath = selfieDoc.url
              .replace(/\\/g, "/")
              .replace(/^\/+/, "");
            profilePicUrl = `${BASE_URL.replace(/\/$/, "")}/${cleanPath}`;
          }
        }

        return {
          id: partner._id,
          rmId: partner.rmId,
          rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,
          asmId: asm?._id || null,
          asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
          name: `${partner.firstName} ${partner.lastName}`,
          email: partner.email,
          phone: partner.phone,
          status: partner.status,
          rating: partner.rating || 0,

          // Existing
          dealsThisMonth: dealsCount,
          revenueGenerated,
          successRate,

          // Added analytics
          totalDisbursed,
          assignedTarget,
          performance: `${performance}%`,

          lastActive: partner.lastLoginAt,
          profilePic: profilePicUrl,
        };
      })
    );

    res.json(partnerData);
  } catch (err) {
    console.error("Error fetching partners list:", err);
    res.status(500).json({ message: "Error fetching partners list" });
  }
});

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

      // Fetch partners assigned to this RM
      const partners = await User.find({ role: ROLES.PARTNER, rmId })
        .select("employeeId firstName lastName phone email status")
        .lean();

      const partnerData = await Promise.all(
        partners.map(async (partner) => {
          // Get last follow-up (latest one)
          const lastFollowUp = await FollowUp.findOne({
            partnerId: partner._id,
          })
            .sort({ updatedAt: -1 })
            .lean();

          return {
            employeeId: partner?.employeeId,
            partnerId: partner._id,
            name: `${partner.firstName} ${partner.lastName}`,
            phone: partner.phone,
            status: lastFollowUp?.status || "N/A",
            remarks: lastFollowUp?.remarks || "",
            lastCall: lastFollowUp?.lastCall
              ? dayjs(lastFollowUp.lastCall).format("DD MMM YYYY, hh:mm a")
              : null,
          };
        })
      );

      res.json(partnerData);
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
      const { partnerId } = req.params;
      const { status, remarks, lastCall } = req.body;

      let parsedDate = new Date(); // default current date
      if (lastCall) {
        parsedDate = dayjs(lastCall, "DD MMM YYYY, hh:mm a").toDate();
      }

      const followUp = new FollowUp({
        partnerId,
        status,
        remarks,
        lastCall: parsedDate,
        updatedBy: req.user.sub,
      });

      await followUp.save();

      res.json({
        message: "Follow-up updated successfully",
        followUp: {
          ...followUp.toObject(),
          lastCall: dayjs(followUp.lastCall).format("DD MMM YYYY, hh:mm a"),
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
      const { to, note, approvedLoanAmount } = req.body;

      if (!to)
        return res.status(400).json({ message: "Target status 'to' required" });

      if (!APP_STATUSES.includes(to))
        return res.status(400).json({ message: "Invalid status" });

      const app = await Application.findOne({
        _id: req.params.id,
        rmId: req.user.sub,
      }).populate("customerId");

      if (!app)
        return res
          .status(404)
          .json({ message: "Application not found under this RM" });

      // ✅ Validate DOC_COMPLETE transition - all documents must be verified
      if (to === "DOC_COMPLETE") {
        const requiredDocTypes = app.getRequiredDocTypes();
        const uploadedDocs = app.docs || [];
        const missingDocs = [];
        const unverifiedDocs = [];
        
        // Check for missing or unverified documents
        for (const docType of requiredDocTypes) {
          const doc = uploadedDocs.find(
            (d) => d.docType?.toUpperCase() === docType.toUpperCase()
          );
          
          if (!doc) {
            missingDocs.push(docType);
          } else if (doc.status !== "VERIFIED") {
            unverifiedDocs.push(`${docType} (${doc.status})`);
          }
        }
        
        if (missingDocs.length > 0 || unverifiedDocs.length > 0) {
          let errorMessage = "Cannot set DOC_COMPLETE status. ";
          if (missingDocs.length > 0) {
            errorMessage += `Missing documents: ${missingDocs.join(", ")}. `;
          }
          if (unverifiedDocs.length > 0) {
            errorMessage += `Unverified documents: ${unverifiedDocs.join(", ")}. `;
          }
          errorMessage += "Please verify all required documents first or change status to DOC_INCOMPLETE.";
          
          return res.status(400).json({
            message: errorMessage,
            missingDocs,
            unverifiedDocs,
          });
        }
      }

      // ✅ Only set approvedLoanAmount for DISBURSED
      if (to === "DISBURSED") {
        if (approvedLoanAmount == null || isNaN(Number(approvedLoanAmount))) {
          return res.status(400).json({
            message: "approvedLoanAmount is required and must be a number",
          });
        }
        app.approvedLoanAmount = Number(approvedLoanAmount);
      }

      // Store old status before transition
      const oldStatus = app.status;

      // Transition
      app.transition(to, req.user.sub, note);

      // ✅ Auto-update document statuses based on application status change
      const now = new Date();
      if (to === "APPROVED" || to === "DISBURSED") {
        // When RM approves/disburses, mark all PENDING/UPDATED documents as VERIFIED
        app.docs.forEach((doc) => {
          if (doc.status === "PENDING" || doc.status === "UPDATED") {
            doc.status = "VERIFIED";
            doc.verifiedAt = now;
            doc.verifiedBy = req.user.sub;
            doc.updatedAt = now;
            // Clear rejection info if any
            doc.rejectedAt = null;
            doc.rejectedBy = null;
          }
        });
      } else if (to === "DOC_COMPLETE") {
        // When moving to DOC_COMPLETE, verify all PENDING/UPDATED documents
        app.docs.forEach((doc) => {
          if (doc.status === "PENDING" || doc.status === "UPDATED") {
            doc.status = "VERIFIED";
            doc.verifiedAt = now;
            doc.verifiedBy = req.user.sub;
            doc.updatedAt = now;
            // Clear rejection info if any
            doc.rejectedAt = null;
            doc.rejectedBy = null;
          }
        });
      } else if (to === "UNDER_REVIEW") {
        // When moving to UNDER_REVIEW, mark UPDATED documents as PENDING (awaiting review)
        app.docs.forEach((doc) => {
          if (doc.status === "UPDATED") {
            doc.status = "PENDING";
            doc.updatedAt = now;
          }
        });
      }

      await app.save();

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
      res.json({
        message: "Application status updated successfully",
        status: app.status,
        approvedLoanAmount: app.approvedLoanAmount,
        allDocumentsVerified: app.areAllDocumentsVerified(),
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
      }

      await app.save();

      // Send response immediately (don't wait for email)
      res.json({
        message: "Application status updated successfully",
        status: app.status,
        approvedLoanAmount: app.approvedLoanAmount,
        stageHistory: app.stageHistory,
      });

      // 📧 Send email asynchronously (non-blocking)
      setImmediate(async () => {
        try {
          let extraInfo = "";

          switch (to) {
            case "DISBURSED":
              extraInfo = `<p><b>Approved Loan Amount:</b> ₹${app.approvedLoanAmount}</p>`;
              break;
            case "AGREEMENT":
              extraInfo = `<p><b>Next Step:</b> Please review and sign your loan agreement.</p>`;
              break;
            case "APPROVED":
              extraInfo = `<p>Your loan application has been approved. 🎉</p>`;
              break;
            case "REJECTED":
              extraInfo = `<p>Unfortunately, your loan application has been rejected. You may reapply after 3 months.</p>`;
              break;
            default:
              extraInfo = `<p>Status updated successfully.</p>`;
          }

          await sendMail({
            to: app.customerId.email,
            subject: `Loan Application Status: ${to}`,
            html: `
              <p>Dear ${app.customerId.firstName || "Customer"},</p>
              <p>Your loan application status has been updated.</p>
              <p><b>New Status:</b> ${to}</p>
              ${note ? `<p><b>Remarks:</b> ${note}</p>` : ""}
              ${extraInfo}
              <br/>
              <p>Thank you,<br/>Trustline Fintech</p>
            `,
          });
        } catch (mailErr) {
          console.error("Failed to send status email:", mailErr.message);
        }
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: e.message });
    }
  }
);

router.post(
  "/deactivate-partner",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const { oldPartnerId } = req.body;

      if (!oldPartnerId) {
        return res.status(400).json({ message: "oldPartnerId is required" });
      }

      const oldId = new mongoose.Types.ObjectId(oldPartnerId);

      // 1️⃣ Validate old partner
      const oldPartner = await User.findById(oldId);
      if (!oldPartner || oldPartner.role !== ROLES.PARTNER) {
        return res
          .status(404)
          .json({ message: "Old partner not found or not a partner" });
      }

      // 2️⃣ Deactivate old partner
      const deactivatedPartner = await User.findByIdAndUpdate(
        oldId,
        { $set: { status: "SUSPENDED", updatedAt: new Date() } },
        { new: true }
      );
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
        message: `Partner ${deactivatedPartner.firstName} ${deactivatedPartner.lastName} has been deactivated.`,
        deactivatedPartner: {
          id: deactivatedPartner._id,
          name: `${deactivatedPartner.firstName} ${deactivatedPartner.lastName}`,
          email: deactivatedPartner.email,
        },
      });
    } catch (error) {
      console.error("Error in /deactivate-partner:", error);
      res
        .status(500)
        .json({ message: "Internal server error", error: error.message });
    }
  }
);

router.post("/partner/activate", async (req, res) => {
  try {
    const { partnerId } = req.body;

    if (!partnerId) {
      return res.status(400).json({ message: "partnerId is required" });
    }

    // Activate partner and get updated document
    const partner = await User.findByIdAndUpdate(
      partnerId,
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
          <p>Regards,<br/>Trustline Fintech</p>
        `,
      });
      console.log("📧 Activation mail sent to:", partner.email);
    } catch (mailErr) {
      console.error("❌ Failed to send activation email:", mailErr.message);
    }

    res.json({
      message: "Partner activated successfully and notified via email",
      partner,
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

    // RM Details
    const rm = await User.findOne({ _id: rmId, role: ROLES.RM }).lean();
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

    // 12-month RM targets and achieved
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    // RM's own monthly targets
    const monthlyTarget = await Target.aggregate([
      {
        $match: {
          assignedTo: rm._id,
          role: ROLES.RM,
          createdAt: { $gte: startOfYear },
        },
      },
      {
        $group: {
          _id: { month: { $month: "$createdAt" } },
          totalTarget: { $sum: "$targetValue" },
        },
      },
      { $sort: { "_id.month": 1 } },
    ]);

    // Monthly Achieved from Applications under RM (including from partners)
    const monthlyAchieved = await Application.aggregate([
      {
        $match: {
          $or: [
            { rmId: new mongoose.Types.ObjectId(rmId), status: "DISBURSED", createdAt: { $gte: startOfYear } },
            { partnerId: { $in: partnerIds }, status: "DISBURSED", createdAt: { $gte: startOfYear } }
          ]
        },
      },
      {
        $group: {
          _id: { month: { $month: "$createdAt" } },
          totalAchieved: { $sum: { $toDouble: "$approvedLoanAmount" } },
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
      const t =
        monthlyTarget.find((m) => m._id.month === month)?.totalTarget || 0;
      const a =
        monthlyAchieved.find((m) => m._id.month === month)?.totalAchieved || 0;
      return { month: monthNames[i], target: t, achieved: a };
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

    // Response
    res.json({
      totals: {
        totalPartners,
        activePartners,
        totalCustomers,
        totalRevenue,
        avgRating,
        inProcessApplications,
      },
      targets, // RM monthly targets & achieved
      highValueCustomers,
      salesPipeline,
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
    const applications = await Application.find({
      $or: [
        { rmId: rmId }, // Direct RM assignment
        { partnerId: { $in: partnerIds } } // Applications from partners under this RM
      ]
    })
      .populate("customerId", "employeeId firstName lastName email phone") // ✅ get employeeId from User
      .populate("partnerId", "firstName lastName email phone")
      .lean();

    // Get all payouts for these applications
    const appIds = applications.map((app) => app._id);
    const payouts = await Payout.find({ application: { $in: appIds } })
      .select("application payOutStatus")
      .lean();

    const payoutMap = {};
    payouts.forEach((p) => {
      payoutMap[p.application.toString()] = p.payOutStatus;
    });

    // Map customers list with application summary
    const customers = applications.map((app) => ({
      customerId: app.customerId?._id,
      customerEmployeeId: app.customerId?.employeeId || null, // employeeId from User
      customerName: `${app.customerId?.firstName ?? ""} ${
        app.customerId?.lastName ?? ""
      }`.trim(),
      contact: app.customerId?.phone || null,
      email: app.customerId?.email || null,
      loanType: app.loanType,
      requestedAmount: app.customer?.loanAmount || null,
      approvedAmount: app.approvedLoanAmount || null,
      status: app.status,
      payOutStatus: payoutMap[app._id.toString()] || "PENDING",
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
    }));

    return res.json(customers);
  } catch (err) {
    console.error("Error fetching RM customers:", err);
    return res.status(500).json({ message: "Error fetching RM customers" });
  }
});

router.get(
  "/customers/pending-payouts",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub;

      // Get all partners under this RM
      const partners = await User.find({ 
        rmId: rmId, 
        role: ROLES.PARTNER 
      }).select("_id").lean();
      const partnerIds = partners.map(p => p._id);

      // Fetch all applications under this RM:
      // 1. Applications where rmId directly matches, OR
      // 2. Applications from partners under this RM
      const applications = await Application.find({
        $or: [
          { rmId: rmId }, // Direct RM assignment
          { partnerId: { $in: partnerIds } } // Applications from partners under this RM
        ]
      })
        .populate("customerId", "employeeId firstName lastName email phone")
        .populate("partnerId", "firstName lastName email phone")
        .lean();

      // Get all payouts with DONE
      const donePayouts = await Payout.find({ payOutStatus: "DONE" })
        .select("application")
        .lean();

      const doneAppIds = new Set(
        donePayouts.map((p) => p.application.toString())
      );

      // Only consider applications with DISBURSED and NOT already DONE
      const disbursedApps = applications.filter(
        (app) =>
          app.status === "DISBURSED" && !doneAppIds.has(app._id.toString())
      );

      // Map to customer format
      const customers = disbursedApps.map((app) => ({
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
        payOutStatus: "PENDING",
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
      }));

      return res.json(customers);
    } catch (err) {
      console.error("Error fetching pending payout customers:", err);
      return res
        .status(500)
        .json({ message: "Server error", error: err.message });
    }
  }
);

router.get(
  "/customers/done-payouts",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub;

      // Get all partners under this RM
      const partners = await User.find({ 
        rmId: rmId, 
        role: ROLES.PARTNER 
      }).select("_id").lean();
      const partnerIds = partners.map(p => p._id);

      // Fetch all applications under this RM:
      // 1. Applications where rmId directly matches, OR
      // 2. Applications from partners under this RM
      const applications = await Application.find({
        $or: [
          { rmId: rmId }, // Direct RM assignment
          { partnerId: { $in: partnerIds } } // Applications from partners under this RM
        ]
      })
        .populate("customerId", "employeeId firstName lastName email phone")
        .populate("partnerId", "firstName lastName email phone")
        .lean();

      const appIds = applications.map((app) => app._id);

      const donePayouts = await Payout.find({
        application: { $in: appIds },
        payOutStatus: "DONE",
      })
        .select("application payOutStatus")
        .lean();

      const doneMap = {};
      donePayouts.forEach((p) => {
        doneMap[p.application.toString()] = p.payOutStatus;
      });

      const customers = applications
        .filter((app) => doneMap[app._id.toString()]) // only apps with DONE payout
        .map((app) => ({
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
          payOutStatus: "DONE",
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
        }));

      return res.json(customers);
    } catch (err) {
      console.error("Error fetching done payout customers:", err);
      return res
        .status(500)
        .json({ message: "Server error", error: err.message });
    }
  }
);

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

      // Find the full application belonging to this RM + Customer
      const application = await Application.findOne({
        _id: applicationId,
        rmId,
        customerId,
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

      const app = await Application.findOne({
        _id: id,
        rmId: req.user.sub,
      });

      if (!app) {
        return res.status(404).json({
          message: "Application not found or not assigned to this RM",
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
      
      // If document is rejected, update application status to DOC_INCOMPLETE
      if (status === "REJECTED" && app.status !== "DOC_INCOMPLETE") {
        try {
          app.transition("DOC_INCOMPLETE", req.user.sub, 
            `Document ${decodedDocType} marked as REJECTED. ${remarks || ""}`);
        } catch (transitionErr) {
          // If transition fails, still update the document but log the error
          console.error("Transition error (non-fatal):", transitionErr.message);
          // Manually set status if transition not allowed
          const oldStatus = app.status;
          if (oldStatus === "DRAFT" || oldStatus === "SUBMITTED" || oldStatus === "DOC_SUBMITTED" || oldStatus === "UNDER_REVIEW") {
            app.status = "DOC_INCOMPLETE";
            if (!app.stageHistory) app.stageHistory = [];
            app.stageHistory.push({
              from: oldStatus,
              to: "DOC_INCOMPLETE",
              by: req.user.sub,
              at: new Date(),
              note: `Document ${decodedDocType} marked as REJECTED. ${remarks || ""}`
            });
          }
        }
      }

      // Ensure uploadedAt exists
      if (!app.docs[docIndex].uploadedAt) {
        app.docs[docIndex].uploadedAt = now;
      }

      // If all documents are verified and application is DOC_INCOMPLETE, check if can move to DOC_COMPLETE
      if (status === "VERIFIED" && app.status === "DOC_INCOMPLETE") {
        const allDocsVerified = app.docs.every(doc => 
          doc.status === "VERIFIED"
        );
        
        if (allDocsVerified && app.docs.length > 0) {
          try {
            app.transition("DOC_COMPLETE", req.user.sub, 
              "All documents have been verified");
          } catch (transitionErr) {
            console.error("Transition to DOC_COMPLETE error:", transitionErr.message);
          }
        }
      }
      
      // When RM marks document as UPDATED, it means they acknowledge the re-upload
      // This will be changed to VERIFIED or REJECTED after RM reviews
      // When RM verifies an UPDATED document, it becomes VERIFIED
      // When RM rejects an UPDATED document, it becomes REJECTED (partner needs to re-upload again)

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
        allDocumentsVerified: app.docs.every(doc => doc.status === "VERIFIED"),
      });

      // Send email notification asynchronously (non-blocking)
      setImmediate(async () => {
        try {
          const partner = await User.findById(app.partnerId).lean();
          if (partner && partner.email) {
            const statusMessage = status === "REJECTED" 
              ? "has been REJECTED and needs to be re-uploaded"
              : status === "VERIFIED"
              ? "has been VERIFIED"
              : status === "UPDATED"
              ? "has been marked as UPDATED and is under review"
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
                <p>Thank you,<br/>Trustline Fintech</p>
              `,
            });
          }
        } catch (mailErr) {
          console.error("Failed to send email notification:", mailErr.message);
          // Don't fail the request if email fails
        }
      });
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

      const app = await Application.findOne({
        _id: id,
        rmId: req.user.sub,
      });

      if (!app) {
        console.log("Application not found", { id, rmId: req.user.sub });
        return res.status(404).json({
          message: "Application not found or not assigned to this RM",
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
      
      if (status === "REJECTED" && app.status !== "DOC_INCOMPLETE") {
        try {
          app.transition("DOC_INCOMPLETE", req.user.sub, 
            `Document ${decodedDocType} marked as REJECTED. ${remarks || ""}`);
        } catch (transitionErr) {
          console.error("Transition error (non-fatal):", transitionErr.message);
          const oldStatus = app.status;
          if (oldStatus === "DRAFT" || oldStatus === "SUBMITTED" || oldStatus === "DOC_SUBMITTED" || oldStatus === "UNDER_REVIEW") {
            app.status = "DOC_INCOMPLETE";
            if (!app.stageHistory) app.stageHistory = [];
            app.stageHistory.push({
              from: oldStatus,
              to: "DOC_INCOMPLETE",
              by: req.user.sub,
              at: new Date(),
              note: `Document ${decodedDocType} marked as REJECTED. ${remarks || ""}`
            });
          }
        }
      }

      if (!app.docs[docIndex].uploadedAt) {
        app.docs[docIndex].uploadedAt = new Date();
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
              <p>Thank you,<br/>Trustline Fintech</p>
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
      const app = await Application.findById(id).lean();

      if (!app) {
        return res.status(404).json({ message: "Application not found" });
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
      .lean();

    if (!rm) {
      return res.status(404).json({ message: "RM not found" });
    }

    // ✅ Generate referral link using rmCode
    const referralLink = `${
      process.env.BASE_URL || "http://localhost:" + process.env.PORT
    }/api/rm/partner/register-by-rmcode?ref=${rm.rmCode}`;

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

      // ✅ new field
      referralLink,

      // Flattened ASM details
      asmId: rm.asmId?._id || null,
      asmName: rm.asmId ? `${rm.asmId.firstName} ${rm.asmId.lastName}` : null,
      asmEmployeeId: rm.asmId?.employeeId || null,
      asmRegion: rm.asmId?.region || null,
      asmPhone: rm.asmId?.phone || null,
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

      res.json({ message: "Profile updated successfully", profile: updatedRm });
    } catch (err) {
      console.error("Error updating RM profile:", err);
      res.status(500).json({ message: err.message });
    }
  }
);

// POST /target/assign-partner-bulk
router.post(
  "/target/assign-partner-bulk",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      let { month, year, totalTarget } = req.body;

      if (!month || !year || !totalTarget) {
        return res
          .status(400)
          .json({ message: "Month, year, and totalTarget are required" });
      }

      // Convert totalTarget to number
      totalTarget = Number(totalTarget);
      year = Number(year);

      // Map month name to number
      const monthMap = {
        January: 1,
        February: 2,
        March: 3,
        April: 4,
        May: 5,
        June: 6,
        July: 7,
        August: 8,
        September: 9,
        October: 10,
        November: 11,
        December: 12,
      };

      if (typeof month === "string") {
        month = monthMap[month];
      }

      // Validate month
      if (!month || month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month value" });
      }

      const rmId = req.user.sub; // logged-in RM ID

      // Get all partners under this RM
      const partners = await User.find({
        role: ROLES.PARTNER,
        rmId: rmId,
      }).lean();

      if (!partners.length) {
        return res
          .status(404)
          .json({ message: "No Partners found under this RM" });
      }

      const perPartnerTarget = Math.floor(totalTarget / partners.length);
      const bulkAssignments = [];

      for (let partner of partners) {
        let target = await Target.findOne({
          assignedTo: partner._id,
          month,
          year,
          role: ROLES.PARTNER,
        });

        if (target) {
          target.targetValue = perPartnerTarget;
          target.assignedBy = rmId;
          await target.save();
          bulkAssignments.push(target);
        } else {
          const newTarget = await Target.create({
            assignedBy: rmId,
            assignedTo: partner._id,
            role: ROLES.PARTNER,
            month,
            year,
            targetValue: perPartnerTarget,
          });
          bulkAssignments.push(newTarget);
        }
      }

      res.status(201).json({
        message:
          "Bulk target assigned successfully to all Partners under this RM",
        totalTarget,
        perPartnerTarget,
        month, // number (1-12)
        year,
        assignments: bulkAssignments,
      });
    } catch (err) {
      console.error("Assign Partner bulk error:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Universal analytics/dashboard API with user profile
router.get("/:id/analytics", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const user = await User.findById(id).lean();
    if (!user) return res.status(404).json({ message: "User not found" });

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
      userId: user._id,
      name: `${user.firstName} ${user.lastName}`,
      role: user.role,
      email: user.email,
      phone: user.phone,
      employeeId: user.employeeId || null,
      dob: user.dob || null,
      address: user.address || null,
      experience: user.experience || null,
      region: user.region || null,
      asmCode: user.asmCode || null,
      rmCode: user.rmCode || null,
      partnerCode: user.partnerCode || null,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };

    let totals = {};
    let totalDisbursed = 0;
    let performance = "0.00";
    let assignedTargetValue = 0;
    let scope = user.role;

    // ================= ROLE LOGIC =================
    switch (user.role) {
      case ROLES.ASM: {
        const rms = await User.find({ asmId: id, role: ROLES.RM })
          .select("_id")
          .lean();
        const rmIds = rms.map((x) => x._id);

        const partners = await User.find({
          rmId: { $in: rmIds },
          role: ROLES.PARTNER,
        })
          .select("_id")
          .lean();
        const partnerIds = partners.map((x) => x._id);

        const customers = await Application.distinct("customerId", {
          partnerId: { $in: partnerIds },
        });

        totalDisbursed = await sumDisbursedBy({
          partnerId: { $in: partnerIds },
        });
        assignedTargetValue = await getAssignedTarget(user._id, ROLES.ASM);

        performance =
          assignedTargetValue > 0
            ? ((totalDisbursed / assignedTargetValue) * 100).toFixed(2)
            : "0.00";

        totals = {
          rms: rmIds.length,
          partners: partnerIds.length,
          customers: customers.length,
        };
        break;
      }

      case ROLES.RM: {
        const partners = await User.find({ rmId: id, role: ROLES.PARTNER })
          .select("_id")
          .lean();
        const partnerIds = partners.map((x) => x._id);

        const customers = await Application.distinct("customerId", {
          partnerId: { $in: partnerIds },
        });

        totalDisbursed = await sumDisbursedBy({ rmId: user._id });
        assignedTargetValue = await getAssignedTarget(user._id, ROLES.RM);

        performance =
          assignedTargetValue > 0
            ? ((totalDisbursed / assignedTargetValue) * 100).toFixed(2)
            : "0.00";

        totals = { partners: partnerIds.length, customers: customers.length };
        break;
      }

      case ROLES.PARTNER: {
        const customers = await Application.distinct("customerId", {
          partnerId: user._id,
        });

        totalDisbursed = await sumDisbursedBy({ partnerId: user._id });
        assignedTargetValue = await getAssignedTarget(user._id, ROLES.PARTNER);

        performance =
          assignedTargetValue > 0
            ? ((totalDisbursed / assignedTargetValue) * 100).toFixed(2)
            : "0.00";

        totals = { customers: customers.length };
        break;
      }

      case ROLES.CUSTOMER: {
        totalDisbursed = await sumDisbursedBy({ customerId: user._id });
        assignedTargetValue = 0;
        performance = undefined;
        totals = {};
        break;
      }
    }

    // ============== RESPONSE =================
    return res.json({
      profile: base,
      analytics: {
        scope,
        totals,
        assignedTarget: assignedTargetValue,
        totalDisbursed,
        performance:
          scope === ROLES.ASM || scope === ROLES.RM || scope === ROLES.PARTNER
            ? `${performance}%`
            : undefined,
      },
    });
  } catch (err) {
    console.error("Universal analytics error:", err);
    res.status(500).json({ message: "Failed to fetch analytics" });
  }
});

router.get(
  "/customer/:customerId/partners-payout",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const { customerId } = req.params;

      // Find all applications for this customer
      const applications = await Application.find({ customerId })
        .select("_id partnerId approvedLoanAmount status")
        .lean();

      if (!applications.length) {
        return res
          .status(404)
          .json({ message: "No partners found for this customer" });
      }

      // Get unique partner IDs
      const partnerIds = [
        ...new Set(applications.map((app) => app.partnerId.toString())),
      ];

      // Fetch partner details
      const partnersData = await User.find({ _id: { $in: partnerIds } })
        .select(
          "firstName lastName email phone bankName accountNumber ifscCode accountHolderName"
        )
        .lean();

      // Fetch payouts for these applications
      const appIds = applications.map((app) => app._id);
      const payouts = await Payout.find({ application: { $in: appIds } })
        .select("application partnerId status")
        .lean();

      // Map partner details + application info + payout status
      const partners = partnersData.map((partner) => {
        // Find all applications for this partner for this customer
        const apps = applications.filter(
          (app) => app.partnerId.toString() === partner._id.toString()
        );

        // Pick latest application
        const latestApp = apps[apps.length - 1];

        // Find payout for this application if exists
        const payout = payouts.find(
          (p) =>
            p.application.toString() === latestApp._id.toString() &&
            p.partnerId.toString() === partner._id.toString()
        );

        return {
          _id: partner._id,
          firstName: partner.firstName,
          lastName: partner.lastName,
          email: partner.email,
          phone: partner.phone,
          accountHolderName: partner.accountHolderName,
          accountNumber: partner.accountNumber,
          bankName: partner.bankName,
          ifscCode: partner.ifscCode,
          approvedLoanAmount: latestApp.approvedLoanAmount || 0,
          payoutStatus: payout?.status || "PENDING",
          applicationId: appIds[0],
        };
      });

      return res.json({
        customerId,
        partners,
      });
    } catch (err) {
      console.error("Error fetching partners for customer with payout:", err);
      return res
        .status(500)
        .json({ message: "Server error", error: err.message });
    }
  }
);

// POST /rm/payouts
router.post("/set-payouts", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const { applicationId, partnerId, payoutPercentage, note, payOutStatus } =
      req.body;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(applicationId)) {
      return res.status(400).json({ message: "Invalid application ID" });
    }

    // Fetch application
    const application = await Application.findById(applicationId).select(
      "approvedLoanAmount partnerId"
    );
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    // Ensure partner matches
    if (application.partnerId.toString() !== partnerId) {
      return res
        .status(400)
        .json({ message: "Application does not belong to this partner" });
    }

    // Calculate payout amount
    let payoutAmount = 0;
    if (payoutPercentage) {
      payoutAmount = (application.approvedLoanAmount * payoutPercentage) / 100;
    }

    // Check if payout already exists
    let payout = await Payout.findOne({
      application: applicationId,
      partnerId,
    });

    if (payout) {
      // ✅ Update existing payout
      payout.amount = payoutAmount || payout.amount;
      payout.note = note || payout.note;
      if (payOutStatus && ["PENDING", "DONE"].includes(payOutStatus)) {
        payout.payOutStatus = payOutStatus;
      }
      await payout.save();
    } else {
      // ✅ Create new payout
      payout = await Payout.create({
        application: applicationId,
        partnerId,
        amount: payoutAmount,
        note,
        payOutStatus:
          payOutStatus && ["PENDING", "DONE"].includes(payOutStatus)
            ? payOutStatus
            : "PENDING",
        addedBy: req.user.sub, // RM user
      });
    }

    return res.status(201).json({
      message: "Payout saved successfully",
      payout,
    });
  } catch (err) {
    console.error("Error saving payout:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});


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


export default router;
