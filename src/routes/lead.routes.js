import express from "express";
import mongoose from "mongoose";
import argon2 from "argon2";
import { User } from "../models/User.js";
import { Application, APP_STATUSES, LOAN_TYPES } from "../models/Application.js";
import { ROLES } from "../config/roles.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import {
  hierarchyFromRm,
  loanAmountError,
  RM_HIERARCHY_FIELDS,
  stampLoanHierarchy,
} from "../utils/loanFileRules.js";
import { createNotification } from "../utils/notificationService.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { activeApplicationsFilter } from "../utils/activeApplicationsFilter.js";
import { getAsmScopeIds } from "../utils/asmHierarchy.js";
import {
  blockerResponse,
  findCustomerApplyBlocker,
  resolveCustomerFile,
} from "../utils/loanReapplyPolicy.js";
import { personFinancialFrom } from "../utils/personFinancial.js";
import {
  notifyPartnerToCompleteLeadForm,
  notifyRmToProgressLeads,
  formatHierarchyLead,
  loadUserDisplayName,
  buildPartnerCompleteFormUrl,
} from "../utils/leadWorkflow.js";

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

/** Company partner for public leads when the form has no valid partner code. Never "first partner in the database". */
async function resolveDefaultCompanyPartner() {
  try {
    const { Config } = await import("../models/Config.js");
    const doc = await Config.findOne({ key: "PUBLIC_LOAN_DEFAULT_PARTNER_CODE" }).lean();
    if (doc?.value?.partnerId && mongoose.Types.ObjectId.isValid(String(doc.value.partnerId))) {
      const p = await User.findOne({
        _id: doc.value.partnerId,
        role: ROLES.PARTNER,
        status: "ACTIVE",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      });
      if (p) return p;
    }
    if (doc?.value?.partnerCode) {
      const p = await User.findOne({
        partnerCode: String(doc.value.partnerCode).trim(),
        role: ROLES.PARTNER,
        status: "ACTIVE",
      });
      if (p) return p;
    }
  } catch (err) {
    console.error("resolveDefaultCompanyPartner:", err?.message);
  }

  return User.findOne({
    partnerCode: process.env.DEFAULT_COMPANY_PARTNER_CODE || DEFAULT_COMPANY_PARTNER_CODE,
    role: ROLES.PARTNER,
    status: "ACTIVE",
  });
}

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

    const personFinancial = personFinancialFrom({
      ...customer,
      ...financialDetails,
      salaryInHand: financialDetails.salaryInHand ?? customer.salaryInHand,
      salaryReceiptMode: financialDetails.salaryReceiptMode ?? customer.salaryReceiptMode,
      cibilScoreBand: financialDetails.cibilScoreBand ?? customer.cibilScoreBand,
    });

    const loanAmount = Number(customer.loanAmount) || 0;
    const amountError = loanAmountError(loanAmount);
    if (amountError) {
      return res.status(400).json({ success: false, message: amountError });
    }

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
      const codeMatch = new RegExp(`^${cleanRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      assignedPartner = await User.findOne({
        role: ROLES.PARTNER,
        status: "ACTIVE",
        $and: [
          { $or: [{ partnerCode: codeMatch }, { referralCode: codeMatch }] },
          { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
        ],
      });
    }

    // No code, or the code does not match an active partner: company default (admin setting), not the first partner in the database.
    if (!assignedPartner) {
      assignedPartner = await resolveDefaultCompanyPartner();
    }

    if (!assignedPartner) {
      return res.status(500).json({
        success: false,
        message: "Unable to route lead: No active company partner found.",
      });
    }

    // 3. Partner, RM, specialized ASM, and senior RSM stay on one chain.
    let assignedRmId = assignedPartner.rmId || null;
    let hierarchy = { rmId: assignedRmId, asmId: null, rsmId: null };

    if (assignedRmId) {
      const rmDoc = await User.findById(assignedRmId).select(RM_HIERARCHY_FIELDS).lean();
      if (rmDoc) hierarchy = hierarchyFromRm(rmDoc, normalizedLoanType);
    } else {
      const fallbackRm = await User.findOne({ role: ROLES.RM, status: "ACTIVE" })
        .select(RM_HIERARCHY_FIELDS)
        .lean();
      if (fallbackRm) {
        assignedRmId = fallbackRm._id;
        hierarchy = hierarchyFromRm(fallbackRm, normalizedLoanType);
      }
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
      ...personFinancial,
      partnerId: assignedPartner._id,
      rmId: hierarchy.rmId || assignedRmId,
      asmId: hierarchy.asmId,
    };

    // 6. Find Existing Lead or Create New
    let app = null;

    if (applicationId && mongoose.Types.ObjectId.isValid(applicationId)) {
      app = await Application.findOne({
        _id: applicationId,
        status: "LEAD",
      });
    }

    const blocked = (blocker) =>
      res.status(400).json({ success: false, ...blockerResponse(blocker) });

    if (app) {
      const otherFile = await findCustomerApplyBlocker(customerUser._id, { excludeAppId: app._id });
      if (otherFile) return blocked(otherFile);
    } else {
      // One customer = one file: continue their open lead/draft (any loan type) or refuse
      const resolved = await resolveCustomerFile(customerUser._id, {
        partnerId: assignedPartner._id,
      });
      if (resolved.blocker) return blocked(resolved.blocker);
      if (resolved.app && resolved.app.status !== "LEAD") {
        return res.status(200).json({
          success: true,
          message: "Customer already has a loan file in progress",
          applicationId: resolved.app._id,
          appNo: resolved.app.appNo,
          status: resolved.app.status,
          assignedPartner: {
            id: assignedPartner._id,
            name: `${assignedPartner.firstName || ""} ${assignedPartner.lastName || ""}`.trim(),
            code: assignedPartner.partnerCode,
          },
        });
      }
      app = resolved.app || null;
    }

    if (app) {
      app.loanType = normalizedLoanType;
      // Update existing LEAD
      app.customer = { ...app.customer?.toObject?.(), ...customerPayload };
      app.hasRunningLoan = hasRunningLoan;
      app.monthlyEmiPaying = monthlyEmiPaying;
      app.loanPurpose = loanPurpose;
      app.salaryInHand = personFinancial.salaryInHand;
      app.salaryReceiptMode = personFinancial.salaryReceiptMode;
      app.cibilScoreBand = personFinancial.cibilScoreBand;
      app.hasBounce = personFinancial.hasBounce;
      app.bounceCount = personFinancial.bounceCount;
      app.requestedAmount = loanAmount || app.requestedAmount || 0;
      stampLoanHierarchy(app, hierarchy, assignedPartner._id);
      app.formProgress = {
        ...(app.formProgress || {}),
        stepIndex: Math.max(Number(app.formProgress?.stepIndex) || 0, 0),
        stepLabel: app.formProgress?.stepLabel || "Personal",
        maxStepIndex: Math.max(Number(app.formProgress?.maxStepIndex) || 0, 0),
        reachedDocuments: Boolean(app.formProgress?.reachedDocuments),
        updatedAt: new Date(),
      };
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
            rmId: hierarchy.rmId || assignedRmId,
            rsmId: hierarchy.rsmId,
            asmId: hierarchy.asmId,
            customerId: customerUser._id,
            loanType: normalizedLoanType,
            customer: customerPayload,
            hasRunningLoan,
            monthlyEmiPaying,
            loanPurpose,
            salaryInHand: personFinancial.salaryInHand,
            salaryReceiptMode: personFinancial.salaryReceiptMode,
            cibilScoreBand: personFinancial.cibilScoreBand,
            hasBounce: personFinancial.hasBounce,
            bounceCount: personFinancial.bounceCount,
            leadSource,
            requestedAmount: loanAmount,
            leadFollowUp: {
              status: "NEW",
              remarks: "",
              lastContactedAt: null,
              nextFollowUpDate: null,
            },
            formProgress: {
              stepIndex: 0,
              stepLabel: "Personal",
              maxStepIndex: 0,
              reachedDocuments: false,
              updatedAt: new Date(),
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
            type: "application",
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
 * POST /api/leads/:id/progress
 * Persist partner wizard progress (address / employment / business / property)
 * onto an existing LEAD so RM can see filled data before final submit.
 * Keeps status as LEAD.
 */
router.post("/:id/progress", optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid application id" });
    }

    const app = await Application.findOne({
      _id: id,
      status: { $in: ["LEAD", "DRAFT", "DOC_INCOMPLETE"] },
      isArchived: { $ne: true },
    });

    if (!app) {
      return res.status(404).json({ success: false, message: "Open lead not found" });
    }

    const {
      stepIndex,
      stepLabel,
      maxStepIndex,
      reachedDocuments,
      customer,
      employmentInfo,
      businessInfo,
      propertyInfo,
      references,
      hasRunningLoan,
      monthlyEmiPaying,
      loanPurpose,
      requestedAmount,
    } = req.body || {};

    // Merge customer snapshot (non-file fields only)
    if (customer && typeof customer === "object") {
      const prev =
        typeof app.customer?.toObject === "function"
          ? app.customer.toObject()
          : { ...(app.customer || {}) };
      const next = { ...prev };
      for (const [key, value] of Object.entries(customer)) {
        if (value === undefined || value === null) continue;
        if (typeof value === "string" && value.trim() === "" && next[key]) continue;
        next[key] = value;
      }
      if (customer.loanAmount !== undefined) {
        const amt = Number(customer.loanAmount) || 0;
        if (amt > 0) {
          const amountError = loanAmountError(amt);
          if (amountError) {
            return res.status(400).json({ success: false, message: amountError });
          }
          next.loanAmount = amt;
          app.requestedAmount = amt;
        }
      }
      app.customer = next;
    }

    if (employmentInfo && typeof employmentInfo === "object") {
      app.employmentInfo = {
        ...(app.employmentInfo?.toObject?.() || app.employmentInfo || {}),
        ...employmentInfo,
      };
    }

    if (businessInfo && typeof businessInfo === "object") {
      app.businessInfo = {
        ...(app.businessInfo?.toObject?.() || app.businessInfo || {}),
        ...businessInfo,
      };
    }

    if (propertyInfo && typeof propertyInfo === "object") {
      app.propertyInfo = {
        ...(app.propertyInfo?.toObject?.() || app.propertyInfo || {}),
        ...propertyInfo,
      };
    }

    if (Array.isArray(references) && references.length) {
      const cleaned = references
        .filter((r) => r && (r.name || r.phone))
        .map((r) => ({
          name: String(r.name || "").trim() || "Reference",
          phone: cleanPhone(r.phone),
        }))
        .filter((r) => r.phone);
      if (cleaned.length) app.references = cleaned;
    }

    if (hasRunningLoan !== undefined) {
      const raw = hasRunningLoan;
      app.hasRunningLoan =
        raw === "YES" || raw === "Yes" || raw === true || raw === "true" ? "YES" : "NO";
      if (app.customer) app.customer.hasRunningLoan = app.hasRunningLoan;
    }
    if (monthlyEmiPaying !== undefined) {
      app.monthlyEmiPaying = Number(monthlyEmiPaying) || 0;
      if (app.customer) app.customer.monthlyEmiPaying = app.monthlyEmiPaying;
    }
    if (loanPurpose !== undefined) {
      app.loanPurpose = String(loanPurpose || "").trim();
      if (app.customer) app.customer.loanPurpose = app.loanPurpose;
    }
    if (app.customer) {
      const personFinancial = personFinancialFrom(app.customer);
      app.salaryInHand = personFinancial.salaryInHand;
      app.salaryReceiptMode = personFinancial.salaryReceiptMode;
      app.cibilScoreBand = personFinancial.cibilScoreBand;
      app.hasBounce = personFinancial.hasBounce;
      app.bounceCount = personFinancial.bounceCount;
      app.customer.hasBounce = personFinancial.hasBounce;
      app.customer.bounceCount = personFinancial.bounceCount;
    }
    if (requestedAmount !== undefined) {
      const amt = Number(requestedAmount) || 0;
      if (amt > 0) {
        const amountError = loanAmountError(amt);
        if (amountError) {
          return res.status(400).json({ success: false, message: amountError });
        }
        app.requestedAmount = amt;
        if (app.customer) app.customer.loanAmount = amt;
      }
    }

    if (app.partnerId) {
      const owner = await User.findById(app.partnerId).select("rmId role").lean();
      if (owner?.rmId) {
        const rmDoc = await User.findById(owner.rmId).select(RM_HIERARCHY_FIELDS).lean();
        if (rmDoc) stampLoanHierarchy(app, hierarchyFromRm(rmDoc, app.loanType), owner._id);
      }
    }

    const prevProgress = app.formProgress || {};
    const nextStepIndex =
      stepIndex !== undefined && stepIndex !== null
        ? Number(stepIndex)
        : Number(prevProgress.stepIndex) || 0;
    const nextMax = Math.max(
      Number(prevProgress.maxStepIndex) || 0,
      maxStepIndex !== undefined ? Number(maxStepIndex) : nextStepIndex,
      nextStepIndex
    );
    const docsReached =
      Boolean(reachedDocuments) ||
      Boolean(prevProgress.reachedDocuments) ||
      String(stepLabel || "").toLowerCase().includes("document");

    app.formProgress = {
      stepIndex: nextStepIndex,
      stepLabel: stepLabel || prevProgress.stepLabel || "Personal",
      maxStepIndex: nextMax,
      reachedDocuments: docsReached,
      updatedAt: new Date(),
    };

    if (docsReached && app.status === "LEAD") {
      const follow = app.leadFollowUp || {};
      if (!follow.status || follow.status === "NEW" || follow.status === "INTERESTED") {
        app.leadFollowUp = {
          ...follow,
          status: "DOCUMENTS_PENDING",
          remarks: follow.remarks || "Partner reached documents step",
          lastContactedAt: follow.lastContactedAt || new Date(),
        };
      }
    }

    app.markModified("customer");
    app.markModified("formProgress");
    if (employmentInfo) app.markModified("employmentInfo");
    if (businessInfo) app.markModified("businessInfo");
    if (propertyInfo) app.markModified("propertyInfo");

    await app.save();

    return res.json({
      success: true,
      message: "Lead progress saved",
      applicationId: app._id,
      appNo: app.appNo,
      status: app.status,
      formProgress: app.formProgress,
    });
  } catch (error) {
    console.error("Error saving lead progress:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to save lead progress",
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
      salaryInHand: app.salaryInHand || app.customer?.salaryInHand || "",
      salaryReceiptMode: app.salaryReceiptMode || app.customer?.salaryReceiptMode || "",
      cibilScoreBand: app.cibilScoreBand || app.customer?.cibilScoreBand || "",
      hasBounce: app.hasBounce || app.customer?.hasBounce || "NO",
      bounceCount: app.bounceCount ?? app.customer?.bounceCount ?? 0,
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
 * For partner-sourced leads, can notify partner to complete the loan form.
 */
router.post("/:id/follow-up", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      remarks,
      nextFollowUpDate,
      notifyPartner = false,
    } = req.body || {};

    const app = await Application.findById(id);
    if (!app) {
      return res.status(404).json({ message: "Application/Lead not found" });
    }

    // RM ownership: direct rmId or partner under this RM
    const rmId = req.user.sub;
    const partners = await User.find({ rmId, role: ROLES.PARTNER }).select("_id").lean();
    const partnerIds = partners.map((p) => String(p._id));
    const ownsLead =
      String(app.rmId || "") === String(rmId) ||
      (app.partnerId && partnerIds.includes(String(app.partnerId)));
    if (!ownsLead) {
      return res.status(403).json({ message: "This lead is not assigned to you" });
    }

    const followUpData = {
      status: status || "CONNECTED",
      remarks: remarks || "",
      lastContactedAt: new Date(),
      nextFollowUpDate: nextFollowUpDate ? new Date(nextFollowUpDate) : null,
      updatedBy: rmId,
    };

    app.leadFollowUp = followUpData;

    app.stageHistory.push({
      from: app.status,
      to: app.status,
      by: rmId,
      at: new Date(),
      note: `Follow-up: [${followUpData.status}] ${followUpData.remarks}`,
    });

    await app.save();

    // Industrial rule: when partner lead needs form completion, notify partner
    const shouldNotifyPartner =
      app.status === "LEAD" &&
      app.partnerId &&
      (notifyPartner === true ||
        ["DOCUMENTS_PENDING", "INTERESTED", "FOLLOW_UP_SCHEDULED"].includes(
          String(followUpData.status || "").toUpperCase()
        ));

    let partnerNotify = { notified: false };
    if (shouldNotifyPartner) {
      try {
        partnerNotify = await notifyPartnerToCompleteLeadForm(app, {
          askedByRole: "RM",
          note: followUpData.remarks,
        });
        if (partnerNotify.notified) {
          app.stageHistory.push({
            from: app.status,
            to: app.status,
            by: rmId,
            at: new Date(),
            note: "Partner notified to complete loan form",
          });
          await app.save();
        }
      } catch (notifyErr) {
        console.warn("Partner complete-form notify failed:", notifyErr.message);
      }
    }

    return res.json({
      success: true,
      message: partnerNotify.notified
        ? "Follow-up saved. Partner notified to complete the loan form."
        : "Lead follow-up updated successfully",
      leadFollowUp: app.leadFollowUp,
      partnerNotified: Boolean(partnerNotify.notified),
      formUrl: partnerNotify.formUrl || null,
    });
  } catch (error) {
    console.error("Error saving lead follow-up:", error);
    return res.status(500).json({ message: "Failed to update lead follow-up" });
  }
});

/**
 * POST /api/leads/:id/nudge-partner
 * RM explicitly asks partner to complete the Step-1 lead loan form.
 */
router.post("/:id/nudge-partner", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const { id } = req.params;
    const { remarks = "" } = req.body || {};
    const rmId = req.user.sub;

    const app = await Application.findById(id);
    if (!app || app.status !== "LEAD") {
      return res.status(404).json({ message: "Open LEAD not found" });
    }
    if (!app.partnerId) {
      return res.status(400).json({
        message: "This lead has no partner. Contact the customer directly.",
      });
    }

    const partners = await User.find({ rmId, role: ROLES.PARTNER }).select("_id").lean();
    const partnerIds = partners.map((p) => String(p._id));
    const ownsLead =
      String(app.rmId || "") === String(rmId) ||
      partnerIds.includes(String(app.partnerId));
    if (!ownsLead) {
      return res.status(403).json({ message: "This lead is not assigned to you" });
    }

    const partnerNotify = await notifyPartnerToCompleteLeadForm(app, {
      askedByRole: "RM",
      note: remarks,
    });

    app.leadFollowUp = {
      ...(app.leadFollowUp?.toObject?.() || app.leadFollowUp || {}),
      status: app.leadFollowUp?.status === "NEW" ? "DOCUMENTS_PENDING" : (app.leadFollowUp?.status || "DOCUMENTS_PENDING"),
      remarks: remarks || app.leadFollowUp?.remarks || "Asked partner to complete loan form",
      lastContactedAt: new Date(),
      updatedBy: rmId,
    };
    app.stageHistory.push({
      from: app.status,
      to: app.status,
      by: rmId,
      at: new Date(),
      note: `RM asked partner to complete loan form${remarks ? `: ${remarks}` : ""}`,
    });
    await app.save();

    const partner = await User.findById(app.partnerId).select("firstName lastName phone").lean();

    return res.json({
      success: true,
      message: "Partner notified to complete the loan form",
      formUrl: partnerNotify.formUrl || buildPartnerCompleteFormUrl(app),
      partner: {
        name: `${partner?.firstName || ""} ${partner?.lastName || ""}`.trim(),
        phone: partner?.phone || "",
      },
      leadFollowUp: app.leadFollowUp,
    });
  } catch (error) {
    console.error("Error nudging partner for lead:", error);
    return res.status(500).json({ message: "Failed to notify partner" });
  }
});

/**
 * GET /api/leads/hierarchy
 * ASM / RSM monitor view of pipeline under their RMs (filterable by status on FE).
 */
router.get(
  "/hierarchy",
  auth,
  requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const managerId = req.user.sub;
      let rmIds = [];

      if (req.user.role === ROLES.SUPER_ADMIN || req.user.role === ROLES.ADMIN) {
        const rms = await User.find({ role: ROLES.RM, status: "ACTIVE" }).select("_id").lean();
        rmIds = rms.map((r) => r._id);
      } else {
        const scope = await getAsmScopeIds(managerId);
        rmIds = scope.rmIds || [];
      }

      if (!rmIds.length) {
        return res.json({ summary: { openLeads: 0, partnerLeads: 0, agingOver48h: 0 }, items: [] });
      }

      const PIPELINE_STATUSES = [
        "LEAD",
        "DRAFT",
        "SUBMITTED",
        "DOC_INCOMPLETE",
        "DOC_COMPLETE",
        "DOC_SUBMITTED",
        "LOGIN",
        "KYC_PENDING",
        "KYC_COMPLETE",
        "UNDER_REVIEW",
        "APPROVED",
        "AGREEMENT",
        "DISBURSED",
        "REJECTED",
      ];

      const leads = await Application.find(
        activeApplicationsFilter({
          status: { $in: PIPELINE_STATUSES },
          rmId: { $in: rmIds },
        })
      )
        .populate("partnerId", "firstName lastName phone partnerCode")
        .populate("rmId", "firstName lastName employeeId phone")
        .populate("customerId", "firstName lastName email phone")
        .sort({ updatedAt: -1 })
        .lean();

      const items = leads.map(formatHierarchyLead);
      const now = Date.now();
      const openItems = items.filter((i) => i.status === "LEAD");
      const summary = {
        openLeads: openItems.length,
        partnerLeads: openItems.filter((i) => i.leadSource === "PARTNER").length,
        agingOver48h: openItems.filter(
          (i) => now - new Date(i.createdAt).getTime() > 48 * 60 * 60 * 1000
        ).length,
        totalPipeline: items.length,
      };

      return res.json({ summary, items });
    } catch (error) {
      console.error("Error fetching hierarchy leads:", error);
      return res.status(500).json({ message: "Failed to fetch hierarchy leads" });
    }
  }
);

/**
 * POST /api/leads/:id/nudge-rm
 * ASM/RSM asks the owning RM to progress this lead (partner complete form).
 */
router.post(
  "/:id/nudge-rm",
  auth,
  requireRole(ROLES.ASM, ROLES.RSM, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { remarks = "" } = req.body || {};
      const managerId = req.user.sub;

      const app = await Application.findById(id);
      if (!app || app.status !== "LEAD") {
        return res.status(404).json({ message: "Open LEAD not found" });
      }
      if (!app.rmId) {
        return res.status(400).json({ message: "Lead has no assigned RM" });
      }

      // Scope check (non-admin)
      if (req.user.role !== ROLES.SUPER_ADMIN && req.user.role !== ROLES.ADMIN) {
        const scope = await getAsmScopeIds(managerId);
        const allowed = (scope.rmIds || []).some((rid) => String(rid) === String(app.rmId));
        if (!allowed) {
          return res.status(403).json({ message: "Lead is not under your hierarchy" });
        }
      }

      const askedByName = await loadUserDisplayName(managerId);
      const askedByRole = req.user.role === ROLES.RSM ? "RSM" : "ASM";

      await notifyRmToProgressLeads(app.rmId, {
        askedByName,
        askedByRole,
        openLeadsCount: 1,
        applicationId: app._id,
        appNo: app.appNo,
        remarks:
          remarks ||
          "Please follow up with the partner and get the loan form completed.",
      });

      app.stageHistory.push({
        from: app.status,
        to: app.status,
        by: managerId,
        at: new Date(),
        note: `${askedByRole} asked RM to progress lead${remarks ? `: ${remarks}` : ""}`,
      });
      await app.save();

      return res.json({
        success: true,
        message: "RM notified to progress this lead",
        applicationId: app._id,
        appNo: app.appNo,
      });
    } catch (error) {
      console.error("Error nudging RM for lead:", error);
      return res.status(500).json({ message: "Failed to notify RM" });
    }
  }
);

/**
 * GET /api/leads/admin
 * Admin/Super Admin view of full pipeline across all RMs & partners.
 */
router.get("/admin", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const PIPELINE_STATUSES = [
      "LEAD",
      "DRAFT",
      "SUBMITTED",
      "DOC_INCOMPLETE",
      "DOC_COMPLETE",
      "DOC_SUBMITTED",
      "LOGIN",
      "KYC_PENDING",
      "KYC_COMPLETE",
      "UNDER_REVIEW",
      "APPROVED",
      "AGREEMENT",
      "DISBURSED",
      "REJECTED",
    ];

    const leads = await Application.find(
      activeApplicationsFilter({ status: { $in: PIPELINE_STATUSES } })
    )
      .populate("customerId", "employeeId firstName lastName email phone")
      .populate("partnerId", "firstName lastName email phone partnerCode referralCode")
      .populate("rmId", "firstName lastName email phone employeeId")
      .sort({ updatedAt: -1 })
      .lean();

    const formattedLeads = leads.map((app) => ({
      _id: app._id,
      id: app._id,
      appNo: app.appNo,
      status: app.status,
      createdAt: app.createdAt,
      loanType: app.loanType,
      loanAmount: app.loanAmount || app.customer?.loanAmount || 0,
      approvedAmount: app.approvedLoanAmount || app.approvedAmount,
      hasRunningLoan: app.hasRunningLoan || app.customer?.hasRunningLoan || "NO",
      monthlyEmiPaying: app.monthlyEmiPaying ?? app.customer?.monthlyEmiPaying ?? 0,
      loanPurpose: app.loanPurpose || app.customer?.loanPurpose || "",
      salaryInHand: app.salaryInHand || app.customer?.salaryInHand || "",
      salaryReceiptMode: app.salaryReceiptMode || app.customer?.salaryReceiptMode || "",
      cibilScoreBand: app.cibilScoreBand || app.customer?.cibilScoreBand || "",
      hasBounce: app.hasBounce || app.customer?.hasBounce || "NO",
      bounceCount: app.bounceCount ?? app.customer?.bounceCount ?? 0,
      leadSource: app.leadSource || "PARTNER",
      leadFollowUp: app.leadFollowUp || { status: "NEW", remarks: "" },
      customer: {
        firstName: app.customer?.firstName || app.customerId?.firstName || "",
        lastName: app.customer?.lastName || app.customerId?.lastName || "",
        email: app.customer?.email || app.customerId?.email || "",
        phone: app.customer?.phone || app.customerId?.phone || "",
        loanAmount: app.customer?.loanAmount || app.loanAmount || 0,
        hasRunningLoan: app.customer?.hasRunningLoan || app.hasRunningLoan || "NO",
        monthlyEmiPaying: app.customer?.monthlyEmiPaying ?? app.monthlyEmiPaying ?? 0,
        loanPurpose: app.customer?.loanPurpose || app.loanPurpose || "",
        salaryInHand: app.customer?.salaryInHand || app.salaryInHand || "",
        salaryReceiptMode: app.customer?.salaryReceiptMode || app.salaryReceiptMode || "",
        cibilScoreBand: app.customer?.cibilScoreBand || app.cibilScoreBand || "",
        hasBounce: app.customer?.hasBounce || app.hasBounce || "NO",
        bounceCount: app.customer?.bounceCount ?? app.bounceCount ?? 0,
      },
      partner: {
        firstName: app.partnerId?.firstName || "",
        lastName: app.partnerId?.lastName || "",
        partnerName: `${app.partnerId?.firstName || ""} ${app.partnerId?.lastName || ""}`.trim(),
        partnerCode: app.partnerId?.partnerCode || "",
        referralCode: app.partnerId?.referralCode || "",
        email: app.partnerId?.email || "",
        phone: app.partnerId?.phone || "",
      },
      assignedRM: {
        firstName: app.rmId?.firstName || "",
        lastName: app.rmId?.lastName || "",
        name: `${app.rmId?.firstName || ""} ${app.rmId?.lastName || ""}`.trim(),
        phone: app.rmId?.phone || "",
        employeeId: app.rmId?.employeeId || "",
        rmCode: app.rmId?.employeeId || "",
      },
    }));

    return res.json({ leads: formattedLeads });
  } catch (error) {
    console.error("Error fetching admin leads:", error);
    return res.status(500).json({ message: "Failed to fetch leads" });
  }
});

export default router;
