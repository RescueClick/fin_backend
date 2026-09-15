import express from "express";
import mongoose from "mongoose";
import argon2 from "argon2";
import { User } from "../models/User.js";
import { Application, APP_STATUSES, LOAN_TYPES } from "../models/Application.js";
import { ROLES } from "../config/roles.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { resolveSpecializedAsmForLoanType } from "../utils/rmRsmHierarchy.js";
import { createNotification } from "../utils/notificationService.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { activeApplicationsFilter } from "../utils/activeApplicationsFilter.js";

const router = express.Router();

/** Optional auth middleware to detect logged in Partner or Customer without 401 blocking guests */
function optionalAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (token && token !== "null" && token !== "undefined") {
      const decoded = verifyAccessToken(token);
      if (decoded?.sub) {
        req.user = decoded;
      }
    }
  } catch (err) {
    // Ignore invalid/expired token and proceed as guest
  }
  next();
}

/** Helper to clean phone numbers */
function cleanPhone(val) {
  const digits = String(val ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Helper to clean emails */
function cleanEmail(val) {
  return String(val ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/** Default company partner code */
const DEFAULT_COMPANY_PARTNER_CODE = "PT-SG772096";

/**
 * POST /api/leads/capture-step1
 * Captures Step 1 (Personal Info + Financial Info) as a LEAD immediately when user clicks "Next".
 * Accessible by: Logged-in Partner, Logged-in Customer, or Public User with Referral Code / Default.
 */
router.post("/capture-step1", optionalAuth, async (req, res) => {
  try {
    const {
      loanType = "PERSONAL",
      customer = {},
      financialDetails = {},
      partnerReferralCode = "",
      applicationId = null,
    } = req.body || {};

    const normalizedLoanType = String(loanType || "PERSONAL").trim().toUpperCase();
    if (!LOAN_TYPES.includes(normalizedLoanType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid loanType. Supported types: ${LOAN_TYPES.join(", ")}`,
      });
    }

    const firstName = String(customer.firstName || "").trim();
    const middleName = String(customer.middleName || "").trim();
    const lastName = String(customer.lastName || "").trim();
    const email = cleanEmail(customer.email);
    const phone = cleanPhone(customer.phone || customer.contactNo);

    if (!firstName || !lastName) {
      return res.status(400).json({
        success: false,
        message: "Customer First Name and Last Name are required.",
      });
    }

    if (!phone || phone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "A valid 10-digit customer mobile number is required.",
      });
    }

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: "A valid customer email address is required.",
      });
    }

    // 1. Resolve Financial Fields
    const rawRunning = financialDetails.hasRunningLoan ?? customer.hasRunningLoan ?? "NO";
    const hasRunningLoan =
      rawRunning === "YES" || rawRunning === "Yes" || rawRunning === true || rawRunning === "true"
        ? "YES"
        : "NO";

    const monthlyEmiPaying =
      hasRunningLoan === "YES"
        ? Number(financialDetails.monthlyEmiPaying ?? customer.monthlyEmiPaying ?? 0) || 0
        : 0;

    const loanPurpose = String(
      financialDetails.loanPurpose ?? customer.loanPurpose ?? ""
    ).trim();

    const loanAmount = Number(customer.loanAmount) || 0;

    // 2. Resolve Partner & Lead Source
    let leadSource = "CUSTOMER_DIRECT";
    let assignedPartner = null;

    if (req.user?.role === ROLES.PARTNER) {
      leadSource = "PARTNER";
      assignedPartner = await User.findOne({
        _id: req.user.sub,
        role: ROLES.PARTNER,
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      });
    } else if (partnerReferralCode && typeof partnerReferralCode === "string" && partnerReferralCode.trim()) {
      leadSource = "PUBLIC_REFERRAL";
      const cleanRef = partnerReferralCode.trim();
      assignedPartner = await User.findOne({
        $or: [{ partnerCode: cleanRef }, { referralCode: cleanRef }],
        role: ROLES.PARTNER,
        status: "ACTIVE",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      });
    }

    // If partner not resolved yet, fallback to default company partner PT-SG772096
    if (!assignedPartner) {
      assignedPartner = await User.findOne({
        partnerCode: DEFAULT_COMPANY_PARTNER_CODE,
        role: ROLES.PARTNER,
      });

      // If specific code not found, fallback to any active partner with an RM
      if (!assignedPartner) {
        assignedPartner = await User.findOne({
          role: ROLES.PARTNER,
          rmId: { $ne: null },
          status: "ACTIVE",
        });
      }
    }

    if (!assignedPartner) {
      return res.status(500).json({
        success: false,
        message: "Unable to route lead: No active company partner found.",
      });
    }

    // 3. Resolve RM, ASM, and RSM Hierarchy
    let assignedRmId = assignedPartner.rmId || null;
    let assignedAsmId = null;
    let assignedRsmId = null;

    if (assignedRmId) {
      const rmDoc = await User.findById(assignedRmId)
        .select("rsmId asmId personalAsmId businessAsmId homeLapAsmId businessHomeAsmId personalRsmId businessRsmId homeLapRsmId businessHomeRsmId")
        .lean();

      if (rmDoc) {
        assignedAsmId = resolveSpecializedAsmForLoanType(rmDoc, normalizedLoanType);
        if (normalizedLoanType === "PERSONAL") {
          assignedRsmId = rmDoc.personalRsmId || rmDoc.rsmId || null;
        } else if (normalizedLoanType === "BUSINESS") {
          assignedRsmId = rmDoc.businessRsmId || rmDoc.businessHomeRsmId || rmDoc.rsmId || null;
        } else {
          assignedRsmId = rmDoc.homeLapRsmId || rmDoc.businessHomeRsmId || rmDoc.rsmId || null;
        }
      }
    } else {
      // Fallback: assign to first active RM in system
      const fallbackRm = await User.findOne({ role: ROLES.RM, status: "ACTIVE" }).select("_id").lean();
      if (fallbackRm) assignedRmId = fallbackRm._id;
    }

    // 4. Find or Create Customer User
    let customerUser = await User.findOne({
      $or: [{ email }, { phone }],
      role: ROLES.CUSTOMER,
    });

    if (!customerUser) {
      const tempPassword = customer.password || `Temp@${Math.random().toString(36).slice(2, 10)}`;
      const employeeId = await generateEmployeeId("CUSTOMER");

      customerUser = await User.create({
        employeeId,
        firstName,
        middleName,
        lastName,
        email,
        phone,
        passwordHash: await argon2.hash(tempPassword),
        role: ROLES.CUSTOMER,
        status: "ACTIVE",
        partnerId: assignedPartner._id,
        rmId: assignedRmId,
      });
    } else {
      // Update partner / RM mapping if not set
      const updateFields = {};
      if (!customerUser.partnerId) updateFields.partnerId = assignedPartner._id;
      if (!customerUser.rmId && assignedRmId) updateFields.rmId = assignedRmId;
      if (Object.keys(updateFields).length > 0) {
        await User.updateOne({ _id: customerUser._id }, { $set: updateFields });
      }
    }

    // 5. Customer Sub-Document
    const customerPayload = {
      firstName,
      middleName,
      lastName,
      email,
      officialEmail: customer.officialEmail || "",
      phone,
      alternatePhone: customer.alternatePhone || "",
      mothersName: customer.mothersName || customer.motherName || "",
      panNumber: (customer.panNumber || customer.pan || "").toUpperCase(),
      dateOfBirth: customer.dateOfBirth || customer.dob || null,
      gender: customer.gender || "Other",
      maritalStatus: customer.maritalStatus || "Single",
      spouseName: customer.spouseName || customer.wifeName || "",
      loanAmount: loanAmount,
      hasRunningLoan,
      monthlyEmiPaying,
      loanPurpose,
      partnerId: assignedPartner._id,
      rmId: assignedRmId,
    };

    // 6. Find Existing Lead or Create New
    let app = null;

    if (applicationId && mongoose.Types.ObjectId.isValid(applicationId)) {
      app = await Application.findOne({
        _id: applicationId,
        status: "LEAD",
      });
    }

    if (!app) {
      // Check for a recent LEAD application (within last 7 days) by same customer for same loan type
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      app = await Application.findOne({
        customerId: customerUser._id,
        loanType: normalizedLoanType,
        status: "LEAD",
        isArchived: { $ne: true },
        createdAt: { $gte: sevenDaysAgo },
      }).sort({ updatedAt: -1 });
    }

    if (app) {
      // Update existing LEAD
      app.customer = { ...app.customer?.toObject?.(), ...customerPayload };
      app.hasRunningLoan = hasRunningLoan;
      app.monthlyEmiPaying = monthlyEmiPaying;
      app.loanPurpose = loanPurpose;
      app.requestedAmount = loanAmount || app.requestedAmount || 0;
      app.partnerId = assignedPartner._id;
      app.rmId = assignedRmId || app.rmId;
      // Per rule: LEADs stay with RM and do not route to ASM/RSM until DOC_COMPLETE
      app.asmId = null;
      app.rsmId = null;
      app.updatedAt = new Date();
      await app.save();
    } else {
      // Create new Application with status LEAD
      let appCreated = false;
      let appRetries = 0;
      const maxAppRetries = 5;

      while (!appCreated && appRetries < maxAppRetries) {
        try {
          const appNo = await generateEmployeeId("APPLICATION");
          app = await Application.create({
            appNo,
            partnerId: assignedPartner._id,
            rmId: assignedRmId,
            rsmId: null, // Routed to RSM only on DOC_COMPLETE
            asmId: null, // Routed to ASM only on DOC_COMPLETE
            customerId: customerUser._id,
            loanType: normalizedLoanType,
            customer: customerPayload,
            hasRunningLoan,
            monthlyEmiPaying,
            loanPurpose,
            leadSource,
            requestedAmount: loanAmount,
            leadFollowUp: {
              status: "NEW",
              remarks: "",
              lastContactedAt: null,
              nextFollowUpDate: null,
            },
            status: "LEAD",
            stageHistory: [
              {
                from: null,
                to: "LEAD",
                by: req.user?.sub || customerUser._id,
                at: new Date(),
                note: `Lead captured on Step 1 Next (${leadSource}). Purpose: ${loanPurpose || "N/A"}`,
              },
            ],
          });
          appCreated = true;
        } catch (createError) {
          if (createError.code === 11000 && createError.keyPattern?.appNo) {
            appRetries++;
            if (appRetries >= maxAppRetries) throw createError;
            await new Promise((resolve) => setTimeout(resolve, 100 * appRetries));
          } else {
            throw createError;
          }
        }
      }

      // Notify RM of the new lead
      if (assignedRmId) {
        try {
          await createNotification(String(assignedRmId), {
            title: `New Lead: ${firstName} ${lastName}`,
            message: `New ${normalizedLoanType} lead captured (₹${loanAmount.toLocaleString("en-IN")}). Running Loan: ${hasRunningLoan}, EMI: ₹${monthlyEmiPaying}, Purpose: ${loanPurpose || "N/A"}. Source: ${leadSource}.`,
            type: "APPLICATION",
            meta: {
              applicationId: app._id,
              appNo: app.appNo,
              customerName: `${firstName} ${lastName}`,
              phone,
            },
          });
        } catch (notifErr) {
          console.warn("Could not send lead notification to RM:", notifErr.message);
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Lead recorded successfully",
      applicationId: app._id,
      appNo: app.appNo,
      status: app.status,
      assignedPartner: {
        id: assignedPartner._id,
        name: `${assignedPartner.firstName || ""} ${assignedPartner.lastName || ""}`.trim(),
        code: assignedPartner.partnerCode,
      },
    });
  } catch (error) {
    console.error("Error in capture-step1:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to capture lead",
    });
  }
});

/**
 * GET /api/leads/rm
 * Get all leads assigned to the logged-in RM (or partners under this RM).
 */
router.get("/rm", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub;

    const partners = await User.find({
      rmId,
      role: ROLES.PARTNER,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    })
      .select("_id")
      .lean();

    const partnerIds = partners.map((p) => p._id);

    const rmScopeFilter = {
      $or: [{ rmId }, { partnerId: { $in: partnerIds } }],
      status: "LEAD",
    };

    const leads = await Application.find(activeApplicationsFilter(rmScopeFilter))
      .populate("customerId", "employeeId firstName lastName email phone")
      .populate("partnerId", "firstName lastName email phone partnerCode")
      .sort({ updatedAt: -1 })
      .lean();

    const formattedLeads = leads.map((app) => ({
      id: app._id,
      applicationId: app._id,
      appNo: app.appNo,
      customerName: `${app.customer?.firstName || app.customerId?.firstName || ""} ${
        app.customer?.lastName || app.customerId?.lastName || ""
      }`.trim(),
      email: app.customer?.email || app.customerId?.email || "",
      phone: app.customer?.phone || app.customerId?.phone || "",
      loanType: app.loanType,
      requestedAmount: app.customer?.loanAmount || app.requestedAmount || 0,
      hasRunningLoan: app.hasRunningLoan || app.customer?.hasRunningLoan || "NO",
      monthlyEmiPaying: app.monthlyEmiPaying ?? app.customer?.monthlyEmiPaying ?? 0,
      loanPurpose: app.loanPurpose || app.customer?.loanPurpose || "",
      leadSource: app.leadSource || "PARTNER",
      leadFollowUp: app.leadFollowUp || { status: "NEW", remarks: "" },
      status: app.status,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      partner: {
        id: app.partnerId?._id,
        name: `${app.partnerId?.firstName || ""} ${app.partnerId?.lastName || ""}`.trim(),
        code: app.partnerId?.partnerCode || "",
        email: app.partnerId?.email || "",
        phone: app.partnerId?.phone || "",
      },
    }));

    return res.json(formattedLeads);
  } catch (error) {
    console.error("Error fetching RM leads:", error);
    return res.status(500).json({ message: "Failed to fetch leads" });
  }
});

/**
 * POST /api/leads/:id/follow-up
 * RM updates follow-up status, notes, and next follow-up date for a lead.
 */
router.post("/:id/follow-up", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, remarks, nextFollowUpDate } = req.body;

    const app = await Application.findById(id);
    if (!app) {
      return res.status(404).json({ message: "Application/Lead not found" });
    }

    const followUpData = {
      status: status || "CONNECTED",
      remarks: remarks || "",
      lastContactedAt: new Date(),
      nextFollowUpDate: nextFollowUpDate ? new Date(nextFollowUpDate) : null,
      updatedBy: req.user.sub,
    };

    app.leadFollowUp = followUpData;

    app.stageHistory.push({
      from: app.status,
      to: app.status,
      by: req.user.sub,
      at: new Date(),
      note: `Follow-up: [${followUpData.status}] ${followUpData.remarks}`,
    });

    await app.save();

    return res.json({
      success: true,
      message: "Lead follow-up updated successfully",
      leadFollowUp: app.leadFollowUp,
    });
  } catch (error) {
    console.error("Error saving lead follow-up:", error);
    return res.status(500).json({ message: "Failed to update lead follow-up" });
  }
});

/**
 * GET /api/leads/admin
 * Admin/Super Admin view of all leads across all RMs & partners.
 */
router.get("/admin", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const leads = await Application.find(activeApplicationsFilter({ status: "LEAD" }))
      .populate("customerId", "employeeId firstName lastName email phone")
      .populate("partnerId", "firstName lastName email phone partnerCode")
      .populate("rmId", "firstName lastName email phone employeeId")
      .sort({ updatedAt: -1 })
      .lean();

    const formattedLeads = leads.map((app) => ({
      id: app._id,
      appNo: app.appNo,
      customerName: `${app.customer?.firstName || app.customerId?.firstName || ""} ${
        app.customer?.lastName || app.customerId?.lastName || ""
      }`.trim(),
      email: app.customer?.email || app.customerId?.email || "",
      phone: app.customer?.phone || app.customerId?.phone || "",
      loanType: app.loanType,
      requestedAmount: app.customer?.loanAmount || app.requestedAmount || 0,
      hasRunningLoan: app.hasRunningLoan || app.customer?.hasRunningLoan || "NO",
      monthlyEmiPaying: app.monthlyEmiPaying ?? app.customer?.monthlyEmiPaying ?? 0,
      loanPurpose: app.loanPurpose || app.customer?.loanPurpose || "",
      leadSource: app.leadSource || "PARTNER",
      leadFollowUp: app.leadFollowUp || { status: "NEW", remarks: "" },
      status: app.status,
      createdAt: app.createdAt,
      partner: {
        name: `${app.partnerId?.firstName || ""} ${app.partnerId?.lastName || ""}`.trim(),
        code: app.partnerId?.partnerCode || "",
      },
      rm: {
        name: `${app.rmId?.firstName || ""} ${app.rmId?.lastName || ""}`.trim(),
        employeeId: app.rmId?.employeeId || "",
      },
    }));

    return res.json(formattedLeads);
  } catch (error) {
    console.error("Error fetching admin leads:", error);
    return res.status(500).json({ message: "Failed to fetch leads" });
  }
});

export default router;
