import { Router } from "express";
import argon2 from "argon2";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES, RSM_TYPES, ASM_TYPES } from "../config/roles.js";
import { assertValidRmRsmAssignments, assertValidRmRsmPair, resolveSpecializedAsmForLoanType } from "../utils/rmRsmHierarchy.js";
import { normalizePhoneToTen } from "../utils/phoneNormalize.js";
import { User } from "../models/User.js";
import { makeRmCode, makeAsmCode } from "../utils/codes.js";
import { Application } from "../models/Application.js";
import { Payout } from "../models/Payout.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { Target } from "../models/Target.js";
import { DeleteAccountRequest } from "../models/DeleteAccountRequest.js";
import {
  sendDeleteAccountConfirmationEmail,
  sendDeleteAccountRejectionEmail,
} from "../utils/emailService.js";
import { createNotification, generateNotificationId } from "../utils/notificationService.js";
import { bannerUpload } from "../middleware/bannerUpload.js";
import { Banner } from "../models/Banner.js";
import { Incentive } from "../models/Incentive.js";
import { Config } from "../models/Config.js";
import { ReferralReward } from "../models/ReferralReward.js";
import { WithdrawalRequest } from "../models/WithdrawalRequest.js";
import { settlePendingEarnings } from "../utils/walletBalance.js";
import { BankMaster } from "../models/BankMaster.js";
import { BankRm } from "../models/BankRm.js";
import { upload } from "../middleware/upload.js";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { sendMail } from "../utils/sendMail.js";
import {
  sendUserAccountEmail,
  sendPartnerRegistrationEmail,
  sendLoanApplicationEmail,
  sendApplicationStatusEmail,
  sendDocumentStatusEmail,
  sendPayoutEmail,
  sendPartnerPayoutInvoiceEmail,
  sendPartnerIncentiveInvoiceEmail,
  sendIncentiveEmail,
} from "../utils/emailService.js";
import {
  calculateTdsAndNet,
  generateInvoiceNumber,
  generateIncentiveInvoiceNumber,
  buildPartnerInvoiceHtml,
  getInvoiceAndTdsPolicy,
  DEFAULT_TDS_SECTION,
  DEFAULT_TDS_PERCENTAGE,
} from "../utils/invoiceService.js";
import { emitPayoutStatusChanged, emitIncentiveStatusChanged } from "../utils/socketEmitter.js";
import { emitTargetUpdatedForDoc, emitTargetUpdatesForDocs } from "../utils/targetSocketEmitter.js";
import { createEmailChangeRequest } from "../utils/emailChangeService.js";
import { getSupportSettings, saveSupportSettings } from "../utils/supportSettings.js";
import {
  buildReassignableApplicationFilter,
  buildReassignmentAudit,
  REASSIGNABLE_PAYOUT_STATUS,
  REASSIGNABLE_INCENTIVE_STATUS,
  LOCKED_PAYOUT_STATUS,
  LOCKED_INCENTIVE_STATUS,
} from "../utils/reassignmentPolicy.js";
import { persistReassignmentAudit } from "../utils/reassignmentAuditService.js";
import { bulkMovePartnersToRm } from "../utils/bulkMovePartnersToRm.js";
import { findCustomersForPartner } from "../utils/partnerCustomerSync.js";
import { activeApplicationsFilter } from "../utils/activeApplicationsFilter.js";
import { getDisbursedAt, isDateInRange } from "../utils/asmHierarchy.js";
import { getActiveIncentiveSlabs, calculatePartnerMilestone, INCENTIVE_PLAN_RULE } from "../utils/incentiveSlabCalculator.js";
import {
  reassignRmWorkload,
  reassignPartnerWorkload,
  reassignAsmWorkload,
  reassignRsmWorkload,
  transferRmToRsm,
} from "../utils/safeTransfer.js";
import {
  softHideTimestamp,
  dataPreservationBlockMessage,
} from "../utils/dataProtection.js";
import {
  deriveCurrentTargetContext,
  rebalanceHierarchyTargetsReplace,
} from "../utils/targetRebalanceService.js";
import { PUBLIC_LOAN_REFERRAL_FALLBACK_PARTNER_CODE as PUBLIC_LOAN_REFERRAL_FALLBACK } from "../constants/publicReferral.js";
import { getReferralRewardAmounts } from "../utils/referralService.js";

const router = Router();

// Create ASM (Admin only). Admin can set password or system can generate one.
// router.post(
//   "/create-asm",
//   auth,
//   requireRole(ROLES.SUPER_ADMIN),
//   async (req, res) => {
//     try {
//       const { firstName, lastName, phone, email, dob, region, password } =
//         req.body || {};

//       if (!firstName || !lastName || !email || !phone) {
//         return res.status(400).json({ message: "name and email required" });
//       }

//       const exists = await User.findOne({ email: email.toLowerCase() });
//       if (exists) {
//         return res.status(409).json({ message: "Email already in use" });
//       }

//       const rawPassword =
//         password || `Asm@${Math.random().toString(36).slice(2, 10)}`;

//       const asm = await User.create({
//         firstName,
//         lastName,
//         phone,
//         email: email.toLowerCase(),
//         passwordHash: await argon2.hash(rawPassword),
//         role: ROLES.ASM,
//         employeeId: await generateEmployeeId("ASM"),
//         asmCode: makeAsmCode(),
//         dob,
//         region,
//       });

//       // 📧 Send mail with credentials
//       try {
//         await sendMail({
//           to: email,
//           subject: "Your ASM Account Has Been Created",
//           html: `
//             <p>Dear ${firstName} ${lastName},</p>
//             <p>Your ASM account has been created successfully.</p>
//             <p><b>Employee ID:</b> ${asm.employeeId}</p>
//             <p><b>ASM Code:</b> ${asm.asmCode}</p>
//             <p><b>Email:</b> ${email}</p>
//             <p><b>Temporary Password:</b> ${rawPassword}</p>
//             <p>Please log in and change your password immediately.</p>
//             <br/>
//             <p>Regards,<br/>DhanSource Capital</p>
//           `,
//         });
//       } catch (mailErr) {
//         console.error("Failed to send email:", mailErr.message);
//         // You might still want to return success even if email fails
//       }

//       return res.status(201).json({
//         message: "ASM created",
//         id: asm._id,
//         asmCode: asm.asmCode,
//         employeeId: asm.employeeId,
//         region: asm.region,
//         dob: asm.dob,
//         tempPassword: password ? undefined : rawPassword,
//       });
//     } catch (err) {
//       console.error("Create ASM Error:", err);
//       return res.status(500).json({ message: "Internal Server Error" });
//     }
//   }
// );

// ==================== BANK MASTER (ADMIN) ====================

// GET /api/admin/banks
// List all banks (admin view)
router.get("/banks", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const banks = await BankMaster.find({})
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ banks });
  } catch (err) {
    console.error("Error fetching banks (admin):", err);
    return res.status(500).json({ message: "Error fetching banks" });
  }
});

// POST /api/admin/banks
// Create a new bank with logo upload to S3
router.post(
  "/banks",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  upload.single("bankLogo"),
  async (req, res) => {
    try {
      const {
        bankName,
        loanType,
        portalLoginId,
        portalPassword,
        portalLink,
        rsmTypes, // can be string or array from frontend
        serviceablePincodes, // stringified array
      } = req.body || {};

      // Normalize incoming loanType to match Application LOAN_TYPES:
      // PERSONAL_LOAN -> PERSONAL, BUSINESS_LOAN -> BUSINESS
      const normalizeLoanType = (lt) => {
        const raw = String(lt || "").trim().toUpperCase();
        if (!raw) return "";
        if (raw === "PERSONAL_LOAN") return "PERSONAL";
        if (raw === "BUSINESS_LOAN") return "BUSINESS";
        return raw;
      };
      const normalizedLoanType = normalizeLoanType(loanType);

      if (!bankName || !loanType || !portalLoginId || !portalPassword || !portalLink) {
        return res.status(400).json({
          message: "bankName, loanType, portalLoginId, portalPassword and portalLink are required",
        });
      }

      if (!req.file || !req.file.location) {
        return res.status(400).json({
          message: "Bank logo is required and must be uploaded",
        });
      }

      // Normalize rsmTypes to array of valid values
      let normalizedRsmTypes = [];
      if (Array.isArray(rsmTypes)) {
        normalizedRsmTypes = rsmTypes;
      } else if (typeof rsmTypes === "string" && rsmTypes.trim() !== "") {
        // support comma separated string or single value
        if (rsmTypes.includes(",")) {
          normalizedRsmTypes = rsmTypes.split(",").map((v) => v.trim());
        } else {
          normalizedRsmTypes = [rsmTypes.trim()];
        }
      }

      const validRsmTypes = Object.values(RSM_TYPES);
      const invalid = normalizedRsmTypes.filter((t) => !validRsmTypes.includes(t));
      if (invalid.length) {
        return res.status(400).json({
          message: `Invalid rsmTypes: ${invalid.join(
            ", "
          )}. Allowed values: ${validRsmTypes.join(", ")}`,
        });
      }

      // Enforce consistency between rsmTypes and loanType (aligned to Application.js LOAN_TYPES):
      // - PERSONAL RSM: PERSONAL only
      // - BUSINESS_HOME RSM: BUSINESS, HOME_LOAN_SALARIED, HOME_LOAN_SELF_EMPLOYED
      const isPersonal = (lt) => normalizeLoanType(lt) === "PERSONAL";
      const isBusiness = (lt) => normalizeLoanType(lt) === "BUSINESS";
      const isHomeLoan = (lt) => normalizeLoanType(lt).startsWith("HOME_LOAN_") || normalizeLoanType(lt).startsWith("LAP_") || normalizeLoanType(lt) === "LAP";

      if (normalizedRsmTypes.length) {
        const hasPersonal = normalizedRsmTypes.includes(RSM_TYPES.PERSONAL);
        const hasBusiness = normalizedRsmTypes.includes(RSM_TYPES.BUSINESS);
        const hasHomeLap = normalizedRsmTypes.includes(RSM_TYPES.HOME_LAP);
        const hasBusinessHome = normalizedRsmTypes.includes(RSM_TYPES.BUSINESS_HOME);

        if (hasPersonal && !hasBusiness && !hasHomeLap && !hasBusinessHome && !isPersonal(normalizedLoanType)) {
          return res.status(400).json({
            message: `Invalid loanType for rsmTypes=PERSONAL. Expected PERSONAL but got "${loanType}".`,
          });
        }

        if (hasBusiness && !hasPersonal && !hasHomeLap && !hasBusinessHome && !isBusiness(normalizedLoanType)) {
          return res.status(400).json({
            message: `Invalid loanType for rsmTypes=BUSINESS. Expected BUSINESS but got "${loanType}".`,
          });
        }

        if (hasHomeLap && !hasPersonal && !hasBusiness && !hasBusinessHome && !isHomeLoan(normalizedLoanType)) {
          return res.status(400).json({
            message: `Invalid loanType for rsmTypes=HOME_LAP. Expected HOME_LOAN_* or LAP_* but got "${loanType}".`,
          });
        }

        if (
          hasBusinessHome &&
          !hasPersonal &&
          !hasBusiness &&
          !hasHomeLap &&
          !(isBusiness(normalizedLoanType) || isHomeLoan(normalizedLoanType))
        ) {
          return res.status(400).json({
            message: `Invalid loanType for rsmTypes=BUSINESS_HOME. Expected BUSINESS or HOME_LOAN_* but got "${loanType}".`,
          });
        }
      }

      let parsedPincodes = [];
      if (serviceablePincodes) {
        try {
          const parsed = JSON.parse(serviceablePincodes);
          if (Array.isArray(parsed)) {
            parsedPincodes = parsed.map((p) => String(p).trim()).filter(Boolean);
          }
        } catch (e) {
          if (typeof serviceablePincodes === "string") {
            const matches = String(serviceablePincodes).match(/\d{6}/g);
            parsedPincodes = matches
              ? Array.from(new Set(matches))
              : serviceablePincodes
                  .split(/[\s,]+/)
                  .map((p) => String(p).trim())
                  .filter(Boolean);
          }
        }
        parsedPincodes = Array.from(
          new Set(parsedPincodes.map((p) => String(p).trim()).filter(Boolean))
        );
      }

      const bank = await BankMaster.create({
        bankName,
        loanType: normalizedLoanType,
        bankLogoUrl: req.file.location,
        portalLoginId,
        portalPassword,
        portalLink,
        rsmTypes: normalizedRsmTypes,
        serviceablePincodes: parsedPincodes,
        createdBy: req.user.sub,
      });

      return res.status(201).json({
        message: "Bank created successfully",
        bank,
      });
    } catch (err) {
      console.error("Error creating bank:", err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  }
);

// PUT /api/admin/banks/:bankId
// Update bank details (logo optional; pincodes replaceable via CSV/text)
router.put(
  "/banks/:bankId",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  upload.single("bankLogo"),
  async (req, res) => {
    try {
      const { bankId } = req.params || {};
      const existing = await BankMaster.findById(bankId);
      if (!existing) {
        return res.status(404).json({ message: "Bank not found" });
      }

      const {
        bankName,
        loanType,
        portalLoginId,
        portalPassword,
        portalLink,
        rsmTypes,
        serviceablePincodes,
        isActive,
      } = req.body || {};

      const normalizeLoanType = (lt) => {
        const raw = String(lt || "").trim().toUpperCase();
        if (!raw) return "";
        if (raw === "PERSONAL_LOAN") return "PERSONAL";
        if (raw === "BUSINESS_LOAN") return "BUSINESS";
        return raw;
      };

      const nextBankName = bankName != null ? String(bankName).trim() : existing.bankName;
      const nextLoanType =
        loanType != null ? normalizeLoanType(loanType) : existing.loanType;
      const nextPortalLoginId =
        portalLoginId != null ? String(portalLoginId).trim() : existing.portalLoginId;
      const nextPortalPassword =
        portalPassword != null ? String(portalPassword).trim() : existing.portalPassword;
      const nextPortalLink =
        portalLink != null ? String(portalLink).trim() : existing.portalLink;

      if (
        !nextBankName ||
        !nextLoanType ||
        !nextPortalLoginId ||
        !nextPortalPassword ||
        !nextPortalLink
      ) {
        return res.status(400).json({
          message:
            "bankName, loanType, portalLoginId, portalPassword and portalLink are required",
        });
      }

      let normalizedRsmTypes = existing.rsmTypes || [];
      if (rsmTypes !== undefined) {
        if (Array.isArray(rsmTypes)) {
          normalizedRsmTypes = rsmTypes;
        } else if (typeof rsmTypes === "string" && rsmTypes.trim() !== "") {
          normalizedRsmTypes = rsmTypes.includes(",")
            ? rsmTypes.split(",").map((v) => v.trim())
            : [rsmTypes.trim()];
        } else {
          normalizedRsmTypes = [];
        }
      }

      const validRsmTypes = Object.values(RSM_TYPES);
      const invalid = normalizedRsmTypes.filter((t) => !validRsmTypes.includes(t));
      if (invalid.length) {
        return res.status(400).json({
          message: `Invalid rsmTypes: ${invalid.join(
            ", "
          )}. Allowed values: ${validRsmTypes.join(", ")}`,
        });
      }

      const isPersonal = (lt) => normalizeLoanType(lt) === "PERSONAL";
      const isBusiness = (lt) => normalizeLoanType(lt) === "BUSINESS";
      const isHomeLoan = (lt) => normalizeLoanType(lt).startsWith("HOME_LOAN_") || normalizeLoanType(lt).startsWith("LAP_") || normalizeLoanType(lt) === "LAP";

      if (normalizedRsmTypes.length) {
        const hasPersonal = normalizedRsmTypes.includes(RSM_TYPES.PERSONAL);
        const hasBusiness = normalizedRsmTypes.includes(RSM_TYPES.BUSINESS);
        const hasHomeLap = normalizedRsmTypes.includes(RSM_TYPES.HOME_LAP);
        const hasBusinessHome = normalizedRsmTypes.includes(RSM_TYPES.BUSINESS_HOME);

        if (hasPersonal && !hasBusiness && !hasHomeLap && !hasBusinessHome && !isPersonal(nextLoanType)) {
          return res.status(400).json({
            message: `Invalid loanType for rsmTypes=PERSONAL. Expected PERSONAL but got "${nextLoanType}".`,
          });
        }

        if (hasBusiness && !hasPersonal && !hasHomeLap && !hasBusinessHome && !isBusiness(nextLoanType)) {
          return res.status(400).json({
            message: `Invalid loanType for rsmTypes=BUSINESS. Expected BUSINESS but got "${nextLoanType}".`,
          });
        }

        if (hasHomeLap && !hasPersonal && !hasBusiness && !hasBusinessHome && !isHomeLoan(nextLoanType)) {
          return res.status(400).json({
            message: `Invalid loanType for rsmTypes=HOME_LAP. Expected HOME_LOAN_* or LAP_* but got "${nextLoanType}".`,
          });
        }

        if (
          hasBusinessHome &&
          !hasPersonal &&
          !hasBusiness &&
          !hasHomeLap &&
          !(isBusiness(nextLoanType) || isHomeLoan(nextLoanType))
        ) {
          return res.status(400).json({
            message: `Invalid loanType for rsmTypes=BUSINESS_HOME. Expected BUSINESS or HOME_LOAN_* but got "${nextLoanType}".`,
          });
        }
      }

      let nextPincodes = existing.serviceablePincodes || [];
      if (serviceablePincodes !== undefined) {
        try {
          const parsed = JSON.parse(serviceablePincodes);
          if (Array.isArray(parsed)) {
            nextPincodes = parsed.map((p) => String(p).trim()).filter(Boolean);
          } else if (typeof serviceablePincodes === "string") {
            nextPincodes = String(serviceablePincodes)
              .split(",")
              .map((p) => String(p).trim())
              .filter(Boolean);
          }
        } catch (e) {
          if (typeof serviceablePincodes === "string") {
            const matches = serviceablePincodes.match(/\d{6}/g);
            nextPincodes = matches
              ? Array.from(new Set(matches))
              : serviceablePincodes
                  .split(/[\s,]+/)
                  .map((p) => String(p).trim())
                  .filter(Boolean);
          } else {
            nextPincodes = [];
          }
        }
        // Deduplicate
        nextPincodes = Array.from(new Set(nextPincodes.map((p) => String(p).trim()).filter(Boolean)));
      }

      existing.bankName = nextBankName;
      existing.loanType = nextLoanType;
      existing.portalLoginId = nextPortalLoginId;
      existing.portalPassword = nextPortalPassword;
      existing.portalLink = nextPortalLink;
      existing.rsmTypes = normalizedRsmTypes;
      existing.serviceablePincodes = nextPincodes;
      existing.updatedBy = req.user.sub;

      if (isActive !== undefined) {
        const activeVal =
          isActive === true ||
          isActive === "true" ||
          isActive === 1 ||
          isActive === "1";
        existing.isActive = Boolean(activeVal);
      }

      if (req.file?.location) {
        existing.bankLogoUrl = req.file.location;
      }

      await existing.save();

      return res.json({
        message: "Bank updated successfully",
        bank: existing,
      });
    } catch (err) {
      console.error("Error updating bank:", err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  }
);

// DELETE /api/admin/banks/:bankId
// Soft delete a bank (set isActive=false)
router.delete("/banks/:bankId", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { bankId } = req.params || {};
    const updated = await BankMaster.findByIdAndUpdate(
      bankId,
      { $set: { isActive: false, updatedBy: req.user.sub } },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ message: "Bank not found" });
    }

    return res.json({ message: "Bank deleted successfully", bank: updated });
  } catch (err) {
    console.error("Error deleting bank (admin):", err);
    return res.status(500).json({ message: "Error deleting bank" });
  }
});

// ==================== BANK RM DIRECTORY (ADMIN) ====================

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
    // keep legacy flat RM fields in sync for older UIs
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

// GET /api/admin/bank-rms
router.get("/bank-rms", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const {
      q,
      bank,
      product,
      marketType,
      state,
      city,
      includeInactive,
    } = req.query || {};

    const filter = {};
    if (includeInactive !== "true" && includeInactive !== "1") {
      filter.isActive = true;
    }
    if (bank) filter.bankNbfcName = String(bank).trim();
    if (product) filter.product = String(product).trim();
    if (marketType) filter.marketType = String(marketType).trim();
    if (state) {
      const stateTrimmed = String(state).trim();
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
    if (city) {
      const cityTrimmed = String(city).trim();
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

    const search = String(q || "").trim();
    if (search) {
      const rx = { $regex: search, $options: "i" };
      const searchOr = [
        { bankNbfcName: rx },
        { loginCode: rx },
        { product: rx },
        { marketType: rx },
        { city: rx },
        { state: rx },
        { company: rx },
        { rmName: rx },
        { rmPhone: rx },
        { rmEmail: rx },
        { "rm.name": rx },
        { "rm.phone": rx },
        { "rm.email": rx },
        { "asm.name": rx },
        { "asm.phone": rx },
        { "asm.email": rx },
        { "rsm.name": rx },
        { "rsm.phone": rx },
        { "rsm.email": rx },
      ];
      if (filter.$and) {
        filter.$and.push({ $or: searchOr });
      } else if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    const bankRms = await BankRm.find(filter)
      .populate("createdBy", "firstName lastName role email")
      .populate("updatedBy", "firstName lastName role email")
      .sort({ updatedAt: -1 })
      .lean();
    return res.json({ bankRms });
  } catch (err) {
    console.error("Error fetching bank RMs (admin):", err);
    return res.status(500).json({ message: "Error fetching bank RMs" });
  }
});

// POST /api/admin/bank-rms
router.post("/bank-rms", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
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
    console.error("Error creating bank RM:", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

// PUT /api/admin/bank-rms/:id
router.put("/bank-rms/:id", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
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
      isPanIndia: req.body?.isPanIndia ?? existingObj.isPanIndia,
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
    existing.markModified("rm");
    existing.markModified("asm");
    existing.markModified("rsm");
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
    console.error("Error updating bank RM:", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

// DELETE /api/admin/bank-rms/:id (soft delete)
router.delete("/bank-rms/:id", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
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

    return res.json({ message: "Bank RM deleted successfully", bankRm: updated });
  } catch (err) {
    console.error("Error deleting bank RM (admin):", err);
    return res.status(500).json({ message: "Error deleting bank RM" });
  }
});

router.post(
  ["/create-asm", "/create-asms"],
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res, next) => {
    try {
      const {
        firstName,
        lastName,
        phone,
        email,
        dob,
        joinDate,
        region,
        password,
        rsmId,
        asmId,
        asmType,
        rsmType,
        rmIds,
      } = req.body || {};

      if (!firstName || !lastName || !email || !phone) {
        return res.status(400).json({ message: "First name, last name, phone, and email are required" });
      }

      const specialtyType = asmType || rsmType;
      const parentRsmId = rsmId || asmId;

      // Area Sales Manager (ASM) must have a specialty type and report to an RSM
      if (!specialtyType) {
        return res.status(400).json({
          message: "ASM specialty type (asmType) is required (e.g. PERSONAL, BUSINESS, HOME_LAP)",
        });
      }
      if (!Object.values(ASM_TYPES).includes(specialtyType)) {
        return res.status(400).json({
          message: `Invalid specialty type. Allowed: ${Object.values(ASM_TYPES).join(", ")}`,
        });
      }
      if (!parentRsmId) {
        return res.status(400).json({ message: "Reporting Regional Sales Manager (rsmId) is required" });
      }

      const normalizedEmail = String(email).toLowerCase();
      const normalizedPhone = String(phone).trim();
      const exists = await User.findOne({
        $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
      })
        .select("email phone")
        .lean();
      if (exists) {
        const emailTaken = String(exists.email || "").toLowerCase() === normalizedEmail;
        const phoneTaken = String(exists.phone || "") === normalizedPhone;
        const field = emailTaken && phoneTaken ? "email,phone" : emailTaken ? "email" : "phone";
        const message =
          emailTaken && phoneTaken
            ? "Email and phone number already in use"
            : emailTaken
              ? "Email already in use"
              : "Phone number already in use";
        return res.status(409).json({ message, field });
      }

      let parentRsm = null;
      if (parentRsmId) {
        parentRsm = await User.findOne({ _id: parentRsmId, role: { $in: [ROLES.RSM, ROLES.ASM] } });
        if (!parentRsm) return res.status(404).json({ message: "Reporting RSM not found" });
      }

      const rawPassword =
        password || `Asm@${Math.random().toString(36).slice(2, 10)}`;

      // Create Area Sales Manager (ASM)
      const targetRole = ROLES.ASM;
      let asm = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const empId = await generateEmployeeId(targetRole);
          asm = await User.create({
            firstName,
            lastName,
            phone: normalizedPhone,
            email: normalizedEmail,
            passwordHash: await argon2.hash(rawPassword),
            role: targetRole,
            employeeId: empId,
            asmCode: makeAsmCode(),
            rsmCode: makeAsmCode(),
            dob,
            joinDate: joinDate ? new Date(joinDate) : new Date(),
            region: (parentRsm && parentRsm.region) || region || "N/A",
            asmType: specialtyType || null,
            rsmType: specialtyType || null,
            rsmId: parentRsm ? parentRsm._id : null,
            asmId: parentRsm ? parentRsm._id : null,
            adminId: req.user.sub,
          });
          break;
        } catch (createErr) {
          if (createErr.code === 11000 && createErr.keyPattern?.employeeId && attempt < 2) {
            continue;
          }
          throw createErr;
        }
      }

      // Transfer selected RMs if provided
      let transferredRmsCount = 0;
      if (Array.isArray(rmIds) && rmIds.length > 0) {
        for (const rmId of rmIds) {
          try {
            await transferRmToRsm({ rmId, toRsmId: asm._id });
            transferredRmsCount++;
          } catch (trErr) {
            console.warn(`Could not transfer RM ${rmId}:`, trErr.message);
          }
        }
      }

      // Auto-assign this new specialized ASM to any RMs under this RSM who currently lack this specialty
      if (parentRsm && parentRsm._id) {
        if (specialtyType === ASM_TYPES.HOME_LAP) {
          await User.updateMany(
            {
              role: ROLES.RM,
              $or: [{ rsmId: parentRsm._id }, { asmId: parentRsm._id }],
              $or: [{ homeLapAsmId: null }, { homeLapAsmId: { $exists: false } }],
            },
            { $set: { homeLapAsmId: asm._id, homeLapRsmId: asm._id } }
          );
        } else if (specialtyType === ASM_TYPES.PERSONAL) {
          await User.updateMany(
            {
              role: ROLES.RM,
              $or: [{ rsmId: parentRsm._id }, { asmId: parentRsm._id }],
              $or: [{ personalAsmId: null }, { personalAsmId: { $exists: false } }],
            },
            { $set: { personalAsmId: asm._id, personalRsmId: asm._id } }
          );
        } else if (specialtyType === ASM_TYPES.BUSINESS) {
          await User.updateMany(
            {
              role: ROLES.RM,
              $or: [{ rsmId: parentRsm._id }, { asmId: parentRsm._id }],
              $or: [{ businessAsmId: null }, { businessAsmId: { $exists: false } }],
            },
            { $set: { businessAsmId: asm._id, businessRsmId: asm._id } }
          );
        }
      }

      // Send credentials mail
      try {
        const emailSent = await sendUserAccountEmail(asm, targetRole, rawPassword, {
          firstName: req.user.firstName || "Admin",
          lastName: req.user.lastName || "",
        });
        if (emailSent) {
          console.log(`✅ ${targetRole} creation email sent to: ${email}`);
        }
      } catch (mailErr) {
        console.error(`❌ Failed to send ${targetRole} creation email:`, mailErr.message);
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
        message: `${targetRole} created successfully`,
        id: asm._id,
        role: asm.role,
        asmCode: asm.asmCode,
        rsmCode: asm.rsmCode,
        employeeId: asm.employeeId,
        asmType: asm.asmType,
        rsmType: asm.rsmType,
        rsmId: asm.rsmId,
        region: asm.region,
        dob: asm.dob,
        transferredRmsCount,
        tempPassword: password ? undefined : rawPassword,
      });
    } catch (err) {
      console.error("Create ASM Error:", err);
      return next(err);
    }
  }
);

router.post(
  "/create-rm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const {
        firstName,
        lastName,
        phone,
        email,
        dob,
        joinDate,
        region,
        password,
        personalAsmId,
        businessAsmId,
        homeLapAsmId,
        personalRsmId,
        businessRsmId,
        homeLapRsmId,
        businessHomeRsmId,
      } = req.body || {};

      if (!firstName || !lastName || !email || !phone) {
        return res.status(400).json({
          message: "First name, last name, email, and phone are required",
        });
      }

      const normalizedPhone = normalizePhoneToTen(phone);
      if (!/^\d{10}$/.test(normalizedPhone)) {
        return res.status(400).json({
          message: "Please enter a valid 10-digit phone number",
        });
      }

      let effPersonalId = personalAsmId || personalRsmId;
      let effBizId = businessAsmId || businessRsmId || businessHomeRsmId;
      let effHomeLapId = homeLapAsmId || homeLapRsmId || businessHomeRsmId;

      // Auto-lookup missing specialized ASMs under the selected RSM if available
      const anchorMgrId = effPersonalId || effBizId || effHomeLapId || req.body?.rsmId;
      if (anchorMgrId) {
        const mgr = await User.findById(anchorMgrId).select("rsmId asmId").lean();
        const parentRsm = req.body?.rsmId || mgr?.rsmId || mgr?.asmId;
        if (parentRsm) {
          if (!effHomeLapId) {
            const defaultHl = await User.findOne({
              role: ROLES.ASM,
              status: "ACTIVE",
              $or: [{ rsmId: parentRsm }, { asmId: parentRsm }],
              asmType: ASM_TYPES.HOME_LAP,
            }).select("_id").lean();
            if (defaultHl) effHomeLapId = defaultHl._id;
          }
          if (!effBizId) {
            const defaultBiz = await User.findOne({
              role: ROLES.ASM,
              status: "ACTIVE",
              $or: [{ rsmId: parentRsm }, { asmId: parentRsm }],
              asmType: ASM_TYPES.BUSINESS,
            }).select("_id").lean();
            if (defaultBiz) effBizId = defaultBiz._id;
          }
          if (!effPersonalId) {
            const defaultPl = await User.findOne({
              role: ROLES.ASM,
              status: "ACTIVE",
              $or: [{ rsmId: parentRsm }, { asmId: parentRsm }],
              asmType: ASM_TYPES.PERSONAL,
            }).select("_id").lean();
            if (defaultPl) effPersonalId = defaultPl._id;
          }
        }
      }

      if (!effPersonalId || (!effBizId && !effHomeLapId)) {
        return res.status(400).json({
          message: "Personal and Business/Home loan manager assignments are required",
        });
      }

      // Check if email or phone already exists
      const normalizedEmail = String(email).toLowerCase();
      const exists = await User.findOne({
        $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
      })
        .select("email phone")
        .lean();
      if (exists) {
        const emailTaken = String(exists.email || "").toLowerCase() === normalizedEmail;
        const phoneTaken = String(exists.phone || "") === normalizedPhone;
        const field = emailTaken && phoneTaken ? "email,phone" : emailTaken ? "email" : "phone";
        const message =
          emailTaken && phoneTaken
            ? "Email and phone number already in use"
            : emailTaken
              ? "Email already in use"
              : "Phone number already in use";
        return res.status(409).json({ message, field });
      }

      // Validate assigned managers
      const validationCheck = await assertValidRmRsmAssignments({
        personalRsmId: effPersonalId,
        businessRsmId: effBizId,
        homeLapRsmId: effHomeLapId,
        businessHomeRsmId: businessHomeRsmId || null,
      });
      if (!validationCheck.ok) {
        return res.status(400).json({ message: validationCheck.message });
      }

      const rawPassword =
        password || `Rm@${Math.random().toString(36).slice(2, 10)}`;

      // Get primary manager to determine parent senior RSM
      const primaryMgr = await User.findById(effPersonalId).select("rsmId asmId").lean();
      const resolvedSeniorRsmId = req.body?.rsmId || primaryMgr?.rsmId || primaryMgr?.asmId || validationCheck.rsmId || validationCheck.asmId;
      const seniorMgr = resolvedSeniorRsmId ? await User.findById(resolvedSeniorRsmId) : null;

      // Create RM
      const rm = await User.create({
        employeeId: await generateEmployeeId("RM"),
        firstName,
        lastName,
        phone: normalizedPhone,
        region: region || seniorMgr?.region || "N/A",
        email: email.toLowerCase(),
        passwordHash: await argon2.hash(rawPassword),
        role: ROLES.RM,
        rmCode: makeRmCode(),
        rsmId: resolvedSeniorRsmId,
        asmId: resolvedSeniorRsmId,
        personalAsmId: effPersonalId,
        personalRsmId: effPersonalId,
        businessAsmId: effBizId || null,
        businessRsmId: effBizId || null,
        homeLapAsmId: effHomeLapId || null,
        homeLapRsmId: effHomeLapId || null,
        businessHomeAsmId: effBizId || null,
        businessHomeRsmId: effBizId || null,
        dob,
        joinDate: joinDate ? new Date(joinDate) : new Date(),
      });

      // Send mail with credentials using professional email service
      try {
        const emailSent = await sendUserAccountEmail(rm, "RM", rawPassword, {
          firstName: req.user.firstName || "Admin",
          lastName: req.user.lastName || "",
        });
        if (emailSent) {
          console.log(`✅ RM creation email sent to: ${email}`);
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
        message: "RM created and targets redistributed",
        id: rm._id,
        rmCode: rm.rmCode,
        employeeId: rm.employeeId,
        personalRsmId: rm.personalRsmId,
        businessRsmId: rm.businessRsmId,
        homeLapRsmId: rm.homeLapRsmId,
        businessHomeRsmId: rm.businessHomeRsmId,
        asmId: rm.asmId,
        assignedAsm: asm ? {
          id: asm._id,
          name: `${asm.firstName} ${asm.lastName}`,
          region: asm.region,
        } : null,
        dob: rm.dob,
        region: rm.region,
        tempPassword: password ? undefined : rawPassword,
      });
    } catch (err) {
      console.error("Error creating RM:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// Create RSM or ASM (Admin only)
router.post(
  ["/create-rsm", "/create-rsms"],
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const {
        firstName,
        lastName,
        phone,
        email,
        dob,
        joinDate,
        region,
        password,
        rsmId,
        asmId,
        rsmType,
        asmType,
        rmIds,
      } = req.body || {};

      if (!firstName || !lastName || !email || !phone) {
        return res.status(400).json({
          message: "First name, last name, phone, and email are required",
        });
      }

      const specialtyType = asmType || rsmType;
      const parentRsmId = rsmId || asmId;

      const normalizedEmail = String(email).toLowerCase();
      const normalizedPhone = String(phone).trim();
      const exists = await User.findOne({
        $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
      })
        .select("email phone")
        .lean();
      if (exists) {
        const emailTaken = String(exists.email || "").toLowerCase() === normalizedEmail;
        const phoneTaken = String(exists.phone || "") === normalizedPhone;
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
        password || `Rsm@${Math.random().toString(36).slice(2, 10)}`;

      let parentRsm = null;
      if (parentRsmId) {
        parentRsm = await User.findOne({ _id: parentRsmId, role: { $in: [ROLES.RSM, ROLES.ASM] } });
      }

      // RSM creation has no type - creates Senior Regional Sales Manager (RSM)
      const targetRole = ROLES.RSM;
      const rsm = await User.create({
        firstName,
        lastName,
        phone: normalizedPhone,
        email: normalizedEmail,
        passwordHash: await argon2.hash(rawPassword),
        role: targetRole,
        employeeId: await generateEmployeeId(targetRole),
        rsmCode: makeAsmCode(),
        asmCode: makeAsmCode(),
        dob,
        joinDate: joinDate ? new Date(joinDate) : new Date(),
        region: (parentRsm && parentRsm.region) || region || "N/A",
        asmType: specialtyType || null,
        rsmType: specialtyType || null,
        rsmId: parentRsm ? parentRsm._id : null,
        asmId: parentRsm ? parentRsm._id : null,
        adminId: req.user.sub,
      });

      // Transfer selected RMs if provided
      let transferredRmsCount = 0;
      if (Array.isArray(rmIds) && rmIds.length > 0) {
        for (const rmId of rmIds) {
          try {
            await transferRmToRsm({ rmId, toRsmId: rsm._id });
            transferredRmsCount++;
          } catch (trErr) {
            console.warn(`Could not transfer RM ${rmId}:`, trErr.message);
          }
        }
      }

      // Send credentials email
      try {
        const emailSent = await sendUserAccountEmail(
          rsm,
          targetRole,
          password ? null : rawPassword,
          {
            firstName: req.user.firstName || "Admin",
            lastName: req.user.lastName || "",
          }
        );
        if (emailSent) {
          console.log(`✅ ${targetRole} creation email sent to: ${email}`);
        }
      } catch (mailErr) {
        console.error(
          `❌ Failed to send ${targetRole} creation email:`,
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

      return res.status(201).json({
        message: `${targetRole} created successfully`,
        id: rsm._id,
        role: rsm.role,
        employeeId: rsm.employeeId,
        rsmCode: rsm.rsmCode,
        asmCode: rsm.asmCode,
        asmType: rsm.asmType,
        rsmType: rsm.rsmType,
        rsmId: rsm.rsmId,
        asmId: rsm.asmId,
        transferredRmsCount,
        tempPassword: password ? undefined : rawPassword,
      });
    } catch (err) {
      console.error("Create RSM/ASM Error:", err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  }
);

router.get(
  ["/get-rm", "/get-rms"],
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const list = await User.find({ role: ROLES.RM, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] })
        .select("-passwordHash -__v") // hide password & __v
        .populate({
          path: "asmId",
          select: "firstName lastName employeeId phone email",
        })
        .populate({
          path: "rsmId",
          select: "firstName lastName employeeId phone email",
        })
        .populate({
          path: "personalAsmId",
          select: "firstName lastName employeeId phone email",
        })
        .populate({
          path: "businessAsmId",
          select: "firstName lastName employeeId phone email",
        })
        .populate({
          path: "homeLapAsmId",
          select: "firstName lastName employeeId phone email",
        })
        .populate({
          path: "personalRsmId",
          select: "firstName lastName employeeId phone email",
        })
        .populate({
          path: "businessRsmId",
          select: "firstName lastName employeeId phone email",
        })
        .populate({
          path: "homeLapRsmId",
          select: "firstName lastName employeeId phone email",
        })
        .populate({
          path: "businessHomeRsmId",
          select: "firstName lastName employeeId phone email",
        })
        .lean();

      // Cache active HL/LAP ASMs by RSM for self-healing missing assignments
      const activeHlAsms = await User.find({
        role: ROLES.ASM,
        status: "ACTIVE",
        asmType: ASM_TYPES.HOME_LAP,
      })
        .select("_id firstName lastName employeeId phone email rsmId asmId")
        .lean();

      const hlAsmByRsm = new Map();
      for (const a of activeHlAsms) {
        const parentId = String(a.rsmId || a.asmId || "");
        if (parentId && !hlAsmByRsm.has(parentId)) {
          hlAsmByRsm.set(parentId, a);
        }
      }

      // Flatten ASM and RSM details into same object
      const formatted = list.map((rm) => {
        const personalAsm = rm.personalAsmId || rm.personalRsmId;
        const businessAsm = rm.businessAsmId || rm.businessRsmId;
        let homeLapAsm = rm.homeLapAsmId || rm.homeLapRsmId || null;
        if (!homeLapAsm) {
          const parentRsmId = String(rm.rsmId?._id || rm.rsmId || rm.asmId?._id || rm.asmId || "");
          if (parentRsmId && hlAsmByRsm.has(parentRsmId)) {
            homeLapAsm = hlAsmByRsm.get(parentRsmId);
            // Self-heal persistence in background
            User.updateOne(
              { _id: rm._id },
              { $set: { homeLapAsmId: homeLapAsm._id, homeLapRsmId: homeLapAsm._id } }
            ).exec().catch(() => {});
          }
        }
        const rsm = rm.rsmId;
        const asm = rm.asmId;

        // Store original IDs before destructuring
        const originalPersonalAsmId = rm.personalAsmId?._id || rm.personalAsmId || rm.personalRsmId?._id || rm.personalRsmId || null;
        const originalBusinessAsmId = rm.businessAsmId?._id || rm.businessAsmId || rm.businessRsmId?._id || rm.businessRsmId || null;
        const originalHomeLapAsmId = rm.homeLapAsmId?._id || rm.homeLapAsmId || rm.homeLapRsmId?._id || rm.homeLapRsmId || null;

        // Extract base RM data without populated objects
        const {
          asmId: _asmId,
          rsmId: _rsmId,
          personalAsmId: _personalAsmId,
          businessAsmId: _businessAsmId,
          homeLapAsmId: _homeLapAsmId,
          personalRsmId: _personalRsmId,
          businessRsmId: _businessRsmId,
          homeLapRsmId: _homeLapRsmId,
          businessHomeRsmId: _businessHomeRsmId,
          ...rmBase
        } = rm;

        const personalAsmObj = personalAsm && personalAsm._id ? {
          _id: personalAsm._id,
          firstName: personalAsm.firstName || "",
          lastName: personalAsm.lastName || "",
          employeeId: personalAsm.employeeId || "",
          phone: personalAsm.phone || "",
          email: personalAsm.email || "",
        } : null;

        const businessAsmObj = businessAsm && businessAsm._id ? {
          _id: businessAsm._id,
          firstName: businessAsm.firstName || "",
          lastName: businessAsm.lastName || "",
          employeeId: businessAsm.employeeId || "",
          phone: businessAsm.phone || "",
          email: businessAsm.email || "",
        } : null;

        const homeLapAsmObj = homeLapAsm && homeLapAsm._id ? {
          _id: homeLapAsm._id,
          firstName: homeLapAsm.firstName || "",
          lastName: homeLapAsm.lastName || "",
          employeeId: homeLapAsm.employeeId || "",
          phone: homeLapAsm.phone || "",
          email: homeLapAsm.email || "",
        } : null;

        return {
          ...rmBase,
          // Manager objects for frontend display
          personalAsm: personalAsmObj,
          businessAsm: businessAsmObj,
          homeLapAsm: homeLapAsmObj,
          personalRsm: personalAsmObj,
          businessRsm: businessAsmObj,
          homeLapRsm: homeLapAsmObj,

          // ASM Details
          personalAsmId: personalAsmObj ? personalAsmObj._id : originalPersonalAsmId || null,
          personalAsmName: personalAsmObj ? `${personalAsmObj.firstName} ${personalAsmObj.lastName}`.trim() : null,
          personalAsmEmployeeId: personalAsmObj ? personalAsmObj.employeeId : null,
          personalAsmPhone: personalAsmObj ? personalAsmObj.phone : null,
          personalAsmEmail: personalAsmObj ? personalAsmObj.email : null,

          businessAsmId: businessAsmObj ? businessAsmObj._id : originalBusinessAsmId || null,
          businessAsmName: businessAsmObj ? `${businessAsmObj.firstName} ${businessAsmObj.lastName}`.trim() : null,
          businessAsmEmployeeId: businessAsmObj ? businessAsmObj.employeeId : null,
          businessAsmPhone: businessAsmObj ? businessAsmObj.phone : null,
          businessAsmEmail: businessAsmObj ? businessAsmObj.email : null,

          homeLapAsmId: homeLapAsmObj ? homeLapAsmObj._id : originalHomeLapAsmId || null,
          homeLapAsmName: homeLapAsmObj ? `${homeLapAsmObj.firstName} ${homeLapAsmObj.lastName}`.trim() : null,
          homeLapAsmEmployeeId: homeLapAsmObj ? homeLapAsmObj.employeeId : null,
          homeLapAsmPhone: homeLapAsmObj ? homeLapAsmObj.phone : null,
          homeLapAsmEmail: homeLapAsmObj ? homeLapAsmObj.email : null,

          // Legacy RSM field names for backward compatibility
          personalRsmId: personalAsmObj ? personalAsmObj._id : originalPersonalAsmId || null,
          personalRsmName: personalAsmObj ? `${personalAsmObj.firstName} ${personalAsmObj.lastName}`.trim() : null,
          personalRsmEmployeeId: personalAsmObj ? personalAsmObj.employeeId : null,
          personalRsmPhone: personalAsmObj ? personalAsmObj.phone : null,
          personalRsmEmail: personalAsmObj ? personalAsmObj.email : null,

          businessRsmId: businessAsmObj ? businessAsmObj._id : originalBusinessAsmId || null,
          businessRsmName: businessAsmObj ? `${businessAsmObj.firstName} ${businessAsmObj.lastName}`.trim() : null,
          businessRsmEmployeeId: businessAsmObj ? businessAsmObj.employeeId : null,
          businessRsmPhone: businessAsmObj ? businessAsmObj.phone : null,
          businessRsmEmail: businessAsmObj ? businessAsmObj.email : null,

          homeLapRsmId: homeLapAsmObj ? homeLapAsmObj._id : originalHomeLapAsmId || null,
          homeLapRsmName: homeLapAsmObj ? `${homeLapAsmObj.firstName} ${homeLapAsmObj.lastName}`.trim() : null,
          homeLapRsmEmployeeId: homeLapAsmObj ? homeLapAsmObj.employeeId : null,
          homeLapRsmPhone: homeLapAsmObj ? homeLapAsmObj.phone : null,
          homeLapRsmEmail: homeLapAsmObj ? homeLapAsmObj.email : null,

          // Senior RSM details
          rsmName: rsm ? `${rsm.firstName} ${rsm.lastName}`.trim() : (asm ? `${asm.firstName} ${asm.lastName}`.trim() : null),
          rsmEmployeeId: rsm ? rsm.employeeId : (asm ? asm.employeeId : null),
          rsmId: rsm ? rsm._id : (rm.rsmId || null),
          asmName: asm ? `${asm.firstName} ${asm.lastName}`.trim() : (rsm ? `${rsm.firstName} ${rsm.lastName}`.trim() : null),
          asmEmployeeId: asm ? asm.employeeId : (rsm ? rsm.employeeId : null),
          asmId: asm ? asm._id : (rm.asmId || null),
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Error fetching RMs" });
    }
  }
);

// List all Regional Sales Managers (Senior RSMs)
router.get(
  ["/get-rsm", "/get-rsms"],
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const list = await User.find({ role: ROLES.RSM, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] })
        .select("-passwordHash -__v")
        .lean();

      const formatted = list.map((rsm) => ({
        _id: rsm._id,
        firstName: rsm.firstName,
        lastName: rsm.lastName,
        email: rsm.email,
        phone: rsm.phone,
        employeeId: rsm.employeeId,
        rsmCode: rsm.rsmCode || rsm.asmCode || rsm.employeeId,
        asmCode: rsm.rsmCode || rsm.asmCode || rsm.employeeId,
        region: rsm.region,
        rsmType: rsm.rsmType || rsm.asmType || null,
        asmType: rsm.asmType || rsm.rsmType || null,
        asmId: rsm.asmId || rsm.rsmId || null,
        rsmId: rsm.rsmId || rsm.asmId || null,
        status: rsm.status,
        createdAt: rsm.createdAt,
        updatedAt: rsm.updatedAt,
      }));

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching RSMs:", err);
      res.status(500).json({ message: "Error fetching RSMs" });
    }
  }
);

// List all Area Sales Managers (Specialized ASMs)
router.get(
  ["/get-asm", "/get-asms"],
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const list = await User.find({ role: ROLES.ASM, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] })
        .select("-passwordHash -__v")
        .populate({
          path: "rsmId",
          select: "firstName lastName employeeId",
        })
        .populate({
          path: "asmId",
          select: "firstName lastName employeeId",
        })
        .lean();

      const formatted = list.map((asm) => {
        const parentRsm = asm.rsmId || asm.asmId;
        const currentType = asm.asmType || asm.rsmType || null;
        return {
          _id: asm._id,
          firstName: asm.firstName,
          lastName: asm.lastName,
          email: asm.email,
          phone: asm.phone,
          employeeId: asm.employeeId,
          asmType: currentType,
          rsmType: currentType, // backward compatibility
          region: asm.region,
          status: asm.status,
          createdAt: asm.createdAt,
          updatedAt: asm.updatedAt,
          rsmName: parentRsm ? `${parentRsm.firstName} ${parentRsm.lastName}` : null,
          rsmEmployeeId: parentRsm ? parentRsm.employeeId : null,
          rsmId: parentRsm ? parentRsm._id : null,
          asmName: parentRsm ? `${parentRsm.firstName} ${parentRsm.lastName}` : null,
          asmEmployeeId: parentRsm ? parentRsm.employeeId : null,
          asmId: parentRsm ? parentRsm._id : null,
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching ASMs:", err);
      res.status(500).json({ message: "Error fetching ASMs" });
    }
  }
);

router.get(
  "/get-partners",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { status } = req.query || {};
      const query = {
        role: ROLES.PARTNER,
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      };
      if (status && status !== "ALL") {
        if (status.toUpperCase() === "SUSPENDED" || status.toUpperCase() === "INACTIVE") {
          query.status = { $in: ["SUSPENDED", "INACTIVE"] };
        } else {
          query.status = status.toUpperCase();
        }
      } else if (!status) {
        // By default, regular partner list only returns verified partners (excludes unverified PENDING registrations)
        query.status = { $ne: "PENDING" };
      }
      const list = await User.find(query)
        .select("-passwordHash -__v")
        .populate({
          path: "rmId",
          select: "firstName lastName employeeId asmId personalRsmId businessRsmId homeLapRsmId businessHomeRsmId",
          populate: [
            { path: "asmId", select: "firstName lastName employeeId" },
            {
              path: "personalRsmId",
              select: "asmId firstName lastName employeeId",
              populate: { path: "asmId", select: "firstName lastName employeeId" },
            },
            {
              path: "businessRsmId",
              select: "asmId firstName lastName employeeId",
              populate: { path: "asmId", select: "firstName lastName employeeId" },
            },
            {
              path: "homeLapRsmId",
              select: "asmId firstName lastName employeeId",
              populate: { path: "asmId", select: "firstName lastName employeeId" },
            },
            {
              path: "businessHomeRsmId",
              select: "asmId firstName lastName employeeId",
              populate: { path: "asmId", select: "firstName lastName employeeId" },
            },
          ],
        })
        .lean();

      const formatted = list.map((partner) => {
        const rm = partner.rmId;
        const asm =
          rm?.asmId ||
          rm?.personalRsmId?.asmId ||
          rm?.businessRsmId?.asmId ||
          rm?.homeLapRsmId?.asmId ||
          rm?.businessHomeRsmId?.asmId ||
          null;

        delete partner.rmId;

        return {
          ...partner,
          rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,
          rmEmployeeId: rm ? rm.employeeId : null,
          rmId: rm ? rm._id : null,
          asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
          asmEmployeeId: asm ? asm.employeeId : null,
          asmId: asm ? asm._id : null,
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/get-unassigned-partners",
  auth,
  requireRole(ROLES.SUPER_ADMIN), // or SUPER_ADMIN depending on your flow
  async (req, res) => {
    try {
      // Find Admin user
      const admin = await User.findOne({ role: ROLES.SUPER_ADMIN });

      if (!admin) {
        return res.status(404).json({ message: "Admin not found" });
      }

      // Partners awaiting approval or RM assignment
      const partners = await User.find({
        role: ROLES.PARTNER,
        status: "PENDING",
      })
        .select("-passwordHash -__v")
        .populate({
          path: "rmId",
          select: "firstName lastName employeeId"
        })
        .lean();

      // Map partners and keep stored doc URLs (S3 URLs already absolute)
      const formatted = partners.map((p) => {
        const rm = p.rmId || admin;
        return {
          ...p,
          rmId: rm._id,
          rmName: `${rm.firstName} ${rm.lastName}`,
          rmEmployeeId: rm.employeeId,
          docs: p.docs || [],
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching unassigned partners:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// Bulk move partners From RM → To RM (open workload only)
router.post(
  "/partners/bulk-move-rm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { partnerIds, fromRmId, toRmId, dryRun } = req.body || {};
      const result = await bulkMovePartnersToRm({
        partnerIds,
        fromRmId,
        toRmId,
        actorId: req.user.sub,
        actorRole: ROLES.SUPER_ADMIN,
        dryRun: Boolean(dryRun),
        req,
      });
      return res.json(result);
    } catch (err) {
      console.error("Error in /partners/bulk-move-rm:", err);
      return res
        .status(err.status || 500)
        .json({ message: err.message || "Failed to move partners" });
    }
  }
);

router.post(
  "/assign-admin-partner-to-rm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { partnerId, rmId } = req.body;

      if (!partnerId || !rmId) {
        return res
          .status(400)
          .json({ message: "Both partnerId and rmId are required" });
      }

      const admin = await User.findOne({ role: ROLES.SUPER_ADMIN });
      if (!admin) return res.status(404).json({ message: "Admin not found" });

      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
        status: "PENDING",
      });
      if (!partner)
        return res
          .status(404)
          .json({ message: "Partner not found or not in PENDING status" });

      const rm = await User.findOne({
        _id: rmId,
        role: ROLES.RM,
        status: "ACTIVE",
      });
      if (!rm)
        return res.status(404).json({ message: "RM not found or inactive" });

      // Assign partner to RM
      partner.rmId = rm._id;
      partner.status = "ACTIVE";
      await partner.save();

      try {
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
      } catch (rebalanceErr) {
        console.error(
          "assign-admin-partner-to-rm: target rebalance failed:",
          rebalanceErr.message
        );
      }

      // Send email to Partner using professional email service
      let partnerEmailSent = false;
      let rmEmailSent = false;
      try {
        // Send to Partner
        partnerEmailSent = await sendPartnerRegistrationEmail(partner, null);
        if (partnerEmailSent) {
          console.log(`✅ Partner approval email sent to: ${partner.email}`);
        }

        // Send notification to RM
        try {
          await sendMail({
            to: rm.email,
            subject: "New Partner Assigned",
            html: `
              <h2>Dear ${rm.firstName},</h2>
              <p>A new partner has been assigned to you:</p>
              <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p><b>Partner Name:</b> ${partner.firstName} ${partner.lastName}</p>
                <p><b>Email:</b> ${partner.email}</p>
                <p><b>Phone:</b> ${partner.phone}</p>
                <p><b>Partner Code:</b> ${partner.partnerCode}</p>
              </div>
              <p>Please review and manage this partner in your dashboard.</p>
              <br/>
              <p>Thanks,<br/>DhanSource Capital Team</p>
            `,
          });
          rmEmailSent = true;
          console.log(`✅ Partner assignment notification sent to RM: ${rm.email}`);
        } catch (rmMailErr) {
          console.error("❌ Failed to send RM notification:", rmMailErr.message);
        }
      } catch (mailErr) {
        console.error("❌ Error sending partner approval email:", mailErr.message);
      }

      res.json({
        message: "Partner assigned to RM successfully and emails sent",
        partnerId: partner._id,
        rmId: rm._id,
      });
    } catch (err) {
      console.error("Error assigning partner to RM:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// POST /api/admin/partners/:id/request-doc-reupload
// Allows Admin to reject specific documents with remarks and grant re-upload permission
router.post(
  "/partners/:id/request-doc-reupload",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { remarks, rejectedDocTypes } = req.body || {};

      const partner = await User.findOne({ _id: id, role: ROLES.PARTNER });
      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      partner.canReuploadDocs = true;
      partner.docRejectionRemarks = remarks || "Please re-upload required documents.";
      partner.inactiveReason = remarks || "KYC documents rejected - please re-upload.";
      partner.rejectedDocTypes =
        Array.isArray(rejectedDocTypes) && rejectedDocTypes.length > 0
          ? rejectedDocTypes
          : [];

      // Update matching docs status to REJECTED
      if (Array.isArray(partner.docs)) {
        partner.docs.forEach((doc) => {
          if (
            (partner.rejectedDocTypes || []).some(
              (t) =>
                t.toUpperCase() === doc.docType?.toUpperCase() ||
                doc.docType?.toUpperCase().includes(t.toUpperCase()) ||
                t.toUpperCase().includes(doc.docType?.toUpperCase())
            )
          ) {
            doc.status = "REJECTED";
            doc.remarks = remarks || "Rejected by Admin - please re-upload.";
          }
        });
      }

      await partner.save();

      // Send email to partner
      try {
        await sendMail({
          to: partner.email,
          subject: "Action Required: Re-upload KYC Documents - DhanSource",
          html: `
            <p>Dear ${partner.firstName} ${partner.lastName},</p>
            <p>During verification of your Partner account, our team noted the following issues with your KYC documents:</p>
            <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 16px; margin: 16px 0; border-radius: 4px;">
              <p style="margin: 0; font-weight: bold; color: #991b1b;">Admin Remarks / Reason:</p>
              <p style="margin: 8px 0 0 0; color: #7f1d1d;">${remarks || "Please re-upload clear copies of the requested documents."}</p>
              ${
                partner.rejectedDocTypes?.length > 0
                  ? `<p style="margin: 8px 0 0 0; color: #7f1d1d;"><b>Documents to re-upload:</b> ${partner.rejectedDocTypes.join(", ")}</p>`
                  : ""
              }
            </div>
            <p>Please log in to your partner portal or app, where you will see the <b>Upload Documents</b> option to submit your replacement documents.</p>
            <br/>
            <p>Regards,<br/>DhanSource Capital Team</p>
          `,
        });
      } catch (mailErr) {
        console.error("Failed to send doc re-upload email to partner:", mailErr.message);
      }

      return res.json({
        message: "Re-upload request sent to partner successfully.",
        partner: {
          _id: partner._id,
          status: partner.status,
          canReuploadDocs: partner.canReuploadDocs,
          rejectedDocTypes: partner.rejectedDocTypes,
          docRejectionRemarks: partner.docRejectionRemarks,
          inactiveReason: partner.inactiveReason,
        },
      });
    } catch (err) {
      console.error("Error in request-doc-reupload:", err);
      return res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// POST /api/admin/partners/:id/suspend
router.post(
  "/partners/:id/suspend",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body || {};

      const partner = await User.findOne({ _id: id, role: ROLES.PARTNER });
      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      partner.status = "SUSPENDED";
      partner.inactiveReason = reason || "Account suspended by Admin.";
      await partner.save();

      return res.json({
        message: "Partner suspended successfully.",
        partner: {
          _id: partner._id,
          status: partner.status,
          inactiveReason: partner.inactiveReason,
        },
      });
    } catch (err) {
      console.error("Error in suspend partner:", err);
      return res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// POST /api/admin/partners/:id/activate
router.post(
  "/partners/:id/activate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params;

      const partner = await User.findOne({ _id: id, role: ROLES.PARTNER });
      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      partner.status = "ACTIVE";
      partner.inactiveReason = null;
      partner.canReuploadDocs = false;
      partner.rejectedDocTypes = [];
      await partner.save();

      return res.json({
        message: "Partner activated successfully.",
        partner: {
          _id: partner._id,
          status: partner.status,
        },
      });
    } catch (err) {
      console.error("Error in activate partner:", err);
      return res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// GET /get-customers?customerId=xxxx — Customer Applications list
// Include rejected apps still in cleanup grace period (deletedAt in the future).
router.get(
  "/get-customers",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { customerId } = req.query;

      const query = activeApplicationsFilter(
        customerId ? { customerId } : {}
      );

      const applications = await Application.find(query)
        .populate({
          path: "customerId",
          select: "employeeId _id firstName lastName email phone loanAmount",
        })
        .populate({
          path: "asmId",
          select: "firstName lastName employeeId role asmType",
        })
        .populate({
          path: "rsmId",
          select: "firstName lastName employeeId role",
        })
        .populate({
          path: "partnerId",
          select: "firstName lastName employeeId rmId",
          populate: {
            path: "rmId",
            select: "firstName lastName employeeId personalAsmId businessAsmId homeLapAsmId businessHomeAsmId rsmId",
            populate: [
              { path: "personalAsmId", select: "firstName lastName employeeId asmType role" },
              { path: "businessAsmId", select: "firstName lastName employeeId asmType role" },
              { path: "homeLapAsmId", select: "firstName lastName employeeId asmType role" },
              { path: "rsmId", select: "firstName lastName employeeId role" },
            ],
          },
        })
        .populate({
          path: "rmId",
          select: "firstName lastName employeeId personalAsmId businessAsmId homeLapAsmId businessHomeAsmId rsmId",
          populate: [
            { path: "personalAsmId", select: "firstName lastName employeeId asmType role" },
            { path: "businessAsmId", select: "firstName lastName employeeId asmType role" },
            { path: "homeLapAsmId", select: "firstName lastName employeeId asmType role" },
            { path: "rsmId", select: "firstName lastName employeeId role" },
          ],
        })
        .select("appNo loanType approvedLoanAmount status createdAt customer customerId asmId rsmId rmId partnerId")
        .lean();

      const formatted = applications.map((app) => {
        const c = app.customer || {};
        const customerUser = app.customerId || {};
        const p = app.partnerId || {};
        // Prefer app RM; if missing, use partner's RM
        const r = app.rmId || p.rmId || {};

        // 1. Resolve Specialized ASM:
        // Must be an actual ASM with matching loanType. NEVER an RSM.
        let resolvedAsm = null;
        if (app.asmId && app.asmId.role === ROLES.ASM) {
          resolvedAsm = app.asmId;
        } else if (r) {
          const matched = resolveSpecializedAsmForLoanType(r, app.loanType);
          if (matched && typeof matched === "object" && matched.role === ROLES.ASM) {
            resolvedAsm = matched;
          }
        }

        // 2. Resolve Senior RSM:
        let resolvedRsm = null;
        if (app.rsmId && app.rsmId.role === ROLES.RSM) {
          resolvedRsm = app.rsmId;
        } else if (r?.rsmId && r.rsmId.role === ROLES.RSM) {
          resolvedRsm = r.rsmId;
        } else if (resolvedAsm?.rsmId && resolvedAsm.rsmId.role === ROLES.RSM) {
          resolvedRsm = resolvedAsm.rsmId;
        }

        const userMongoId =
          customerUser._id ||
          (typeof app.customerId === "object" ? app.customerId?._id : app.customerId) ||
          null;
        const displayName = [c.firstName || customerUser.firstName, c.lastName || customerUser.lastName]
          .filter(Boolean)
          .join(" ");

        const empId = customerUser.employeeId || c.employeeId || app.appNo || null;

        return {
          _id: app._id,
          applicationId: app._id,
          appNo: app.appNo,
          firstName: c.firstName || customerUser.firstName || null,
          lastName: c.lastName || customerUser.lastName || null,
          userName: displayName || null,
          userId: userMongoId || app._id,
          isUserAccount: !!userMongoId,
          employeeId: empId,
          email: c.email || customerUser.email || null,
          phone: c.phone || customerUser.phone || null,
          loanType: app.loanType,
          loanAmount: c.loanAmount || 0,
          disburseAmount: app.approvedLoanAmount || 0,
          status: app.status,
          applicationDate: app.createdAt,
          partnerName: p.firstName ? `${p.firstName} ${p.lastName}` : null,
          partnerEmployeeId: p.employeeId || null,
          rmName: r.firstName ? `${r.firstName} ${r.lastName}` : null,
          rmEmployeeId: r.employeeId || null,
          asmName: resolvedAsm ? `${resolvedAsm.firstName} ${resolvedAsm.lastName}`.trim() : null,
          asmEmployeeId: resolvedAsm ? resolvedAsm.employeeId : null,
          rsmName: resolvedRsm ? `${resolvedRsm.firstName} ${resolvedRsm.lastName}`.trim() : null,
          rsmEmployeeId: resolvedRsm ? resolvedRsm.employeeId : null,
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching customer applications:", err);
      res.status(500).json({ message: "Error fetching customer applications" });
    }
  }
);

// Get partners under a specific RM (Admin)
router.get(
  "/rm/:rmId/get-partners",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const list = await User.find({
        role: ROLES.PARTNER,
        rmId: req.params.rmId,
      })
        .select("-passwordHash -__v")
        .populate({
          path: "rmId", // populate RM details
          select: "firstName lastName employeeId asmId",
          populate: {
            path: "asmId", // nested populate to get ASM details
            select: "firstName lastName employeeId",
          },
        })
        .lean();

      // Flatten rm + asm details into same object
      const formatted = list.map((partner) => {
        const rm = partner.rmId;
        const asm = rm?.asmId;

        return {
          ...partner,
          rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,
          rmEmployeeId: rm ? rm.employeeId : null,
          asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
          asmEmployeeId: asm ? asm.employeeId : null,
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Error fetching partners" });
    }
  }
);

router.get(
  "/asm/:asmId/get-rms",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const list = await User.find({
        role: ROLES.RM,
        asmId: req.params.asmId,
      })
        .select("-passwordHash -__v")
        .populate({
          path: "asmId", // populate RM details
          select: "firstName lastName employeeId",
        })
        .lean();

      // Flatten rm details into same object
      const formatted = list.map((rm) => {
        const asm = rm.asmId;
        return {
          ...rm,
          asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
          asmEmployeeId: asm ? asm.employeeId : null,
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Error fetching partners" });
    }
  }
);

// Get customers under a specific Partner (Admin)

router.get(
  "/partner/:partnerId/get-customers",

  auth,

  requireRole(ROLES.SUPER_ADMIN),

  async (req, res) => {
    try {
      const partner = await User.findOne({
        _id: req.params.partnerId,
        role: ROLES.PARTNER,
      })
        .select("firstName lastName employeeId rmId")
        .populate({
          path: "rmId",
          select: "firstName lastName employeeId",
        })
        .lean();

      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      const list = await findCustomersForPartner(req.params.partnerId);
      const rm = partner.rmId;

      const formatted = list.map((customer) => ({
        ...customer,
        partnerName: `${partner.firstName} ${partner.lastName}`,
        partnerEmployeeId: partner.employeeId,
        rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,
        rmEmployeeId: rm ? rm.employeeId : null,
      }));

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching customers under partner:", err);

      res.status(500).json({ message: "Error fetching customers" });
    }
  }
);

// Soft-hide customer + applications or individual loan application by ID
router.delete(
  "/customer/:customerId",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { customerId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(customerId)) {
        return res.status(400).json({ message: "Invalid customer ID" });
      }

      const now = softHideTimestamp();

      // First try to find User with role CUSTOMER
      const customer = await User.findOne({
        _id: customerId,
        role: ROLES.CUSTOMER,
      });

      if (customer) {
        const appUpdate = await Application.updateMany(
          { customerId },
          {
            $set: {
              deletedAt: now,
              updatedAt: now,
            },
          }
        );

        customer.status = "SUSPENDED";
        customer.deletedAt = now;
        await customer.save();

        return res.json({
          message:
            "Customer and applications soft-deleted (hidden). Data is retained and can be recovered from the database.",
          customerId,
          customerName: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || "Customer",
          softDeletedApplications: appUpdate.modifiedCount || 0,
          hardDeleted: false,
        });
      }

      // If user not found, check if customerId is an Application ID
      const app = await Application.findById(customerId);
      if (app) {
        app.deletedAt = now;
        app.updatedAt = now;
        await app.save();

        if (app.customerId) {
          const remaining = await Application.countDocuments({
            customerId: app.customerId,
            $or: [{ deletedAt: null }, { deletedAt: { $gt: new Date() } }],
          });
          if (remaining === 0) {
            await User.updateOne(
              { _id: app.customerId },
              { $set: { status: "SUSPENDED", deletedAt: now } }
            );
          }
        }

        const appCustName = app.customer
          ? `${app.customer.firstName || ""} ${app.customer.lastName || ""}`.trim()
          : "Application";

        return res.json({
          message: "Loan application soft-deleted (hidden) successfully.",
          applicationId: app._id,
          customerName: appCustName || "Customer",
          softDeletedApplications: 1,
          hardDeleted: false,
        });
      }

      return res.status(404).json({ message: "Customer or application record not found" });
    } catch (error) {
      console.error("Error soft-deleting customer:", error);
      res.status(500).json({
        message: "Failed to delete customer",
        error: error.message,
      });
    }
  }
);

// Soft-hide an individual loan application by applicationId
router.delete(
  "/application/:applicationId",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { applicationId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(applicationId)) {
        return res.status(400).json({ message: "Invalid application ID" });
      }

      const now = softHideTimestamp();
      const app = await Application.findById(applicationId);

      if (!app) {
        return res.status(404).json({ message: "Application not found" });
      }

      app.deletedAt = now;
      app.updatedAt = now;
      await app.save();

      return res.json({
        message: "Loan application soft-deleted successfully.",
        applicationId: app._id,
        hardDeleted: false,
      });
    } catch (error) {
      console.error("Error soft-deleting application:", error);
      res.status(500).json({
        message: "Failed to delete application",
        error: error.message,
      });
    }
  }
);

// router.get(
//   "/dashboard",
//   auth,
//   requireRole(ROLES.SUPER_ADMIN),
//   async (req, res) => {
//     try {
//       // Applications stats
//       const totalFiles = await Application.countDocuments();
//       const rejectedFiles = await Application.countDocuments({
//         status: "REJECTED",
//       });
//       const approvedFiles = await Application.countDocuments({
//         status: "APPROVED",
//       });
//       const inProcessFiles = await Application.countDocuments({
//         status: {
//           $in: ["SUBMITTED", "KYC_PENDING", "KYC_COMPLETE", "UNDER_REVIEW"],
//         },
//       });

//       // total disburse amount
//       const disbursedAgg = await Application.aggregate([
//         { $match: { status: "DISBURSED" } },
//         { $group: { _id: null, total: { $sum: "$product.amount" } } },
//       ]);
//       const totalDisbursed =
//         disbursedAgg.length > 0 ? disbursedAgg[0].total : 0;

//       // manual payouts
//       const payoutAgg = await Payout.aggregate([
//         { $group: { _id: null, total: { $sum: "$amount" } } },
//       ]);
//       const totalPayout = payoutAgg.length > 0 ? payoutAgg[0].total : 0;

//       // Users count (ASM, RM, Partner, Customer)
//       const totalASM = await User.countDocuments({ role: ROLES.ASM });
//       const totalRM = await User.countDocuments({ role: ROLES.RM });
//       const totalPartners = await User.countDocuments({ role: ROLES.PARTNER });
//       const totalCustomers = await User.countDocuments({
//         role: ROLES.CUSTOMER,
//       });

//       res.json({
//         totalFiles,
//         rejectedFiles,
//         approvedFiles,
//         inProcessFiles,
//         totalDisbursed,
//         totalPayout,
//         totalASM,
//         totalRM,
//         totalPartners,
//         totalCustomers,
//       });
//     } catch (err) {
//       console.error("Dashboard error:", err);
//       res.status(500).json({ message: "Failed to fetch dashboard stats" });
//     }
//   }
// );

router.get(
  "/dashboard",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { year, month } = req.query;

      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      // Check if user specified year / month
      const hasYear =
        year !== undefined && year !== null && year !== "" && year !== "all";
      const hasMonth =
        month !== undefined && month !== null && month !== "" && month !== "all";

      const selectedYear = hasYear ? Number(year) : (hasMonth ? currentYear : null);
      const selectedMonth = hasMonth ? Number(month) : null;

      let startDate = null;
      let endDate = null;

      if (selectedYear && selectedMonth) {
        startDate = new Date(selectedYear, selectedMonth - 1, 1, 0, 0, 0, 0);
        endDate = new Date(selectedYear, selectedMonth, 1, 0, 0, 0, 0);
      } else if (selectedYear) {
        startDate = new Date(selectedYear, 0, 1, 0, 0, 0, 0);
        endDate = new Date(selectedYear + 1, 0, 1, 0, 0, 0, 0);
      }

      const isDateFiltered = Boolean(startDate && endDate);

      // Determine reference year for the 12-month summary breakdown
      const yearForBreakdown = selectedYear || currentYear;

      // Applications stats — retrieve all active applications with required fields
      const inProcessStatuses = [
        "SUBMITTED",
        "DOC_INCOMPLETE",
        "DOC_COMPLETE",
        "LOGIN",
        "DOC_SUBMITTED",
        "KYC_PENDING",
        "KYC_COMPLETE",
        "UNDER_REVIEW",
      ];
      const approvedStatuses = ["APPROVED", "AGREEMENT"];

      const allApps = await Application.find(activeApplicationsFilter())
        .select(
          "_id status approvedLoanAmount requestedAmount customerId partnerId disbursedAt disbursedDate stageHistory createdAt updatedAt"
        )
        .lean();

      let allTimeRevenue = 0;
      let allTimeDisbursedFiles = 0;
      let allTimeApprovedFiles = 0;
      let allTimeRejectedFiles = 0;
      let allTimeInProcessFiles = 0;
      const allTimeTotalFiles = allApps.length;

      let periodRevenue = 0;
      let periodDisbursedFiles = 0;
      let periodApprovedFiles = 0;
      let periodRejectedFiles = 0;
      let periodInProcessFiles = 0;
      let periodTotalFiles = 0;

      const volumeByPartnerInPeriod = new Map();
      const partnerIdsInPeriod = new Set();
      const customerIdsInPeriod = new Set();

      // Setup 12-month breakdown data structures for yearForBreakdown
      const monthNames = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
      ];
      const monthlyBreakdown = Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        monthName: monthNames[i],
        year: yearForBreakdown,
        revenue: 0,
        disbursedFiles: 0,
        payoutAmount: 0,
        payoutCount: 0,
        bonusUnlocked: 0,
        partnersWithBonus: 0,
        activePartners: 0,
        totalFiles: 0,
      }));
      const monthlyPartnerVolumes = Array.from({ length: 12 }, () => new Map());

      allApps.forEach((app) => {
        const amt = parseFloat(app.approvedLoanAmount) || 0;
        const st = String(app.status || "").toUpperCase();
        const dDate = getDisbursedAt(app);
        const cDate = app.createdAt ? new Date(app.createdAt) : null;

        // All-time counters
        if (st === "DISBURSED") {
          allTimeRevenue += amt;
          allTimeDisbursedFiles += 1;
        } else if (approvedStatuses.includes(st)) {
          allTimeApprovedFiles += 1;
        } else if (st === "REJECTED") {
          allTimeRejectedFiles += 1;
        } else if (inProcessStatuses.includes(st)) {
          allTimeInProcessFiles += 1;
        }

        // Monthly breakdown calculation for yearForBreakdown
        if (st === "DISBURSED" && dDate && dDate.getFullYear() === yearForBreakdown) {
          const mIdx = dDate.getMonth();
          if (mIdx >= 0 && mIdx < 12) {
            monthlyBreakdown[mIdx].revenue += amt;
            monthlyBreakdown[mIdx].disbursedFiles += 1;
            const pId = app.partnerId?.toString();
            if (pId) {
              monthlyPartnerVolumes[mIdx].set(
                pId,
                (monthlyPartnerVolumes[mIdx].get(pId) || 0) + amt
              );
            }
          }
        }
        if (cDate && cDate.getFullYear() === yearForBreakdown) {
          const mIdx = cDate.getMonth();
          if (mIdx >= 0 && mIdx < 12) {
            monthlyBreakdown[mIdx].totalFiles += 1;
          }
        }

        // Period calculations
        if (isDateFiltered) {
          // Disbursed in period: check disbursedAt date
          if (st === "DISBURSED" && isDateInRange(dDate, startDate, endDate)) {
            periodRevenue += amt;
            periodDisbursedFiles += 1;
            const pId = app.partnerId?.toString();
            if (pId) {
              volumeByPartnerInPeriod.set(
                pId,
                (volumeByPartnerInPeriod.get(pId) || 0) + amt
              );
              partnerIdsInPeriod.add(pId);
            }
          }

          // Application created in period
          if (isDateInRange(cDate, startDate, endDate)) {
            periodTotalFiles += 1;
            if (app.customerId) {
              customerIdsInPeriod.add(app.customerId.toString());
            }
            if (app.partnerId) {
              partnerIdsInPeriod.add(app.partnerId.toString());
            }

            if (st === "REJECTED") {
              periodRejectedFiles += 1;
            } else if (approvedStatuses.includes(st)) {
              periodApprovedFiles += 1;
            } else if (inProcessStatuses.includes(st)) {
              periodInProcessFiles += 1;
            }
          }
        }
      });

      // If not filtered (All Time view)
      if (!isDateFiltered) {
        periodRevenue = allTimeRevenue;
        periodDisbursedFiles = allTimeDisbursedFiles;
        periodApprovedFiles = allTimeApprovedFiles;
        periodRejectedFiles = allTimeRejectedFiles;
        periodInProcessFiles = allTimeInProcessFiles;
        periodTotalFiles = allTimeTotalFiles;

        // Populate volumeByPartner for all-time bonuses
        allApps.forEach((app) => {
          if (String(app.status || "").toUpperCase() === "DISBURSED") {
            const amt = parseFloat(app.approvedLoanAmount) || 0;
            const pId = app.partnerId?.toString();
            if (pId) {
              volumeByPartnerInPeriod.set(
                pId,
                (volumeByPartnerInPeriod.get(pId) || 0) + amt
              );
              partnerIdsInPeriod.add(pId);
            }
          }
        });
      }

      // Calculate milestone cash bonus liability unlocked under active slabs
      const activeSlabs = await getActiveIncentiveSlabs();
      let monthlyBonusUnlocked = 0;
      let partnersWithBonus = 0;

      volumeByPartnerInPeriod.forEach((vol) => {
        const milestone = calculatePartnerMilestone(vol, activeSlabs);
        if (milestone.isEligible && milestone.incentiveAmount > 0) {
          monthlyBonusUnlocked += milestone.incentiveAmount;
          partnersWithBonus += 1;
        }
      });

      // Complete monthly breakdown bonus calculations
      for (let i = 0; i < 12; i++) {
        let bSum = 0;
        let pCount = 0;
        monthlyPartnerVolumes[i].forEach((vol) => {
          const m = calculatePartnerMilestone(vol, activeSlabs);
          if (m.isEligible && m.incentiveAmount > 0) {
            bSum += m.incentiveAmount;
            pCount += 1;
          }
        });
        monthlyBreakdown[i].bonusUnlocked = bSum;
        monthlyBreakdown[i].partnersWithBonus = pCount;
        monthlyBreakdown[i].activePartners = monthlyPartnerVolumes[i].size;
      }

      // Payouts for breakdown
      const yearStart = new Date(yearForBreakdown, 0, 1, 0, 0, 0, 0);
      const yearEnd = new Date(yearForBreakdown + 1, 0, 1, 0, 0, 0, 0);
      const yearPayouts = await Payout.find({
        createdAt: { $gte: yearStart, $lt: yearEnd },
      })
        .select("amount payOutStatus createdAt")
        .lean();

      yearPayouts.forEach((p) => {
        const pDate = new Date(p.createdAt);
        const mIdx = pDate.getMonth();
        const amt = Number(p.amount) || 0;
        if (mIdx >= 0 && mIdx < 12) {
          monthlyBreakdown[mIdx].payoutAmount += amt;
          monthlyBreakdown[mIdx].payoutCount += 1;
        }
      });

      // Total Payout (All-Time)
      const payoutAgg = await Payout.aggregate([
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      const totalPayout = payoutAgg.length > 0 ? payoutAgg[0].total : 0;

      // Period Payout
      let periodPayout = 0;
      let periodPayoutCount = 0;
      let periodDonePayout = 0;
      let periodPendingPayout = 0;

      if (isDateFiltered) {
        const periodPayouts = await Payout.find({
          createdAt: { $gte: startDate, $lt: endDate },
        })
          .select("amount payOutStatus")
          .lean();

        periodPayouts.forEach((p) => {
          const amt = Number(p.amount) || 0;
          periodPayout += amt;
          periodPayoutCount += 1;
          if (p.payOutStatus === "DONE") periodDonePayout += amt;
          if (p.payOutStatus === "PENDING") periodPendingPayout += amt;
        });
      } else {
        periodPayout = totalPayout;
        const allPayouts = await Payout.find({})
          .select("amount payOutStatus")
          .lean();
        allPayouts.forEach((p) => {
          const amt = Number(p.amount) || 0;
          periodPayoutCount += 1;
          if (p.payOutStatus === "DONE") periodDonePayout += amt;
          if (p.payOutStatus === "PENDING") periodPendingPayout += amt;
        });
      }

      // Targets are retired; kept as 0 for backward compatibility
      const totalDisbursementTarget = 0;

      // Users count (excluding soft-deleted)
      const userBase = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
      const totalASM = await User.countDocuments({ role: ROLES.ASM, ...userBase });
      const totalRM = await User.countDocuments({ role: ROLES.RM, ...userBase });
      const totalRSM = await User.countDocuments({ role: ROLES.RSM, ...userBase });
      const totalPartners = await User.countDocuments({
        role: ROLES.PARTNER,
        status: { $ne: "PENDING" },
        ...userBase,
      });
      const activePartners = await User.countDocuments({
        role: ROLES.PARTNER,
        status: "ACTIVE",
        ...userBase,
      });
      const inactivePartners = await User.countDocuments({
        role: ROLES.PARTNER,
        status: "INACTIVE",
        ...userBase,
      });
      const pendingPartners = await User.countDocuments({
        role: ROLES.PARTNER,
        status: "PENDING",
        ...userBase,
      });

      // Customers = unique people with a still-visible loan application
      const customerIds = await Application.distinct(
        "customerId",
        activeApplicationsFilter({ customerId: { $ne: null } })
      );
      const totalCustomers = customerIds.length;

      // Keep raw user-account count available for ops if needed
      const totalCustomerAccounts = await User.countDocuments({
        role: ROLES.CUSTOMER,
        ...userBase,
      });

      // Period user registrations
      let newPartnersInPeriod = 0;
      let newCustomersInPeriod = 0;
      if (isDateFiltered) {
        newPartnersInPeriod = await User.countDocuments({
          role: ROLES.PARTNER,
          createdAt: { $gte: startDate, $lt: endDate },
          ...userBase,
        });
        newCustomersInPeriod = await User.countDocuments({
          role: ROLES.CUSTOMER,
          createdAt: { $gte: startDate, $lt: endDate },
          ...userBase,
        });
      } else {
        newPartnersInPeriod = totalPartners;
        newCustomersInPeriod = totalCustomers;
      }

      res.json({
        // Filter context
        filter: {
          year: hasYear ? Number(year) : "all",
          month: hasMonth ? Number(month) : "all",
          isFiltered: isDateFiltered,
          yearForBreakdown,
        },

        // Applications funnel (in period if filtered, else all-time)
        totalFiles: isDateFiltered ? periodTotalFiles : allTimeTotalFiles,
        rejectedFiles: isDateFiltered ? periodRejectedFiles : allTimeRejectedFiles,
        approvedFiles: isDateFiltered ? periodApprovedFiles : allTimeApprovedFiles,
        disbursedFiles: isDateFiltered ? periodDisbursedFiles : allTimeDisbursedFiles,
        inProcessFiles: isDateFiltered ? periodInProcessFiles : allTimeInProcessFiles,

        // Disbursed volume
        totalRevenue: isDateFiltered ? periodRevenue : allTimeRevenue,
        periodRevenue,
        allTimeRevenue,
        monthlyRevenue: periodRevenue,

        // Bonus unlocked
        monthlyBonusUnlocked,
        partnersWithBonus,

        // Payouts
        totalPayout: isDateFiltered ? periodPayout : totalPayout,
        periodPayout,
        allTimePayout: totalPayout,
        periodPayoutCount,
        periodDonePayout,
        periodPendingPayout,

        // User metrics
        totalDisbursementTarget,
        totalASM,
        totalRM,
        totalRSM,
        totalPartners,
        activePartners,
        inactivePartners,
        pendingPartners,
        totalCustomers,
        totalCustomerAccounts,

        // Period user activity
        newPartnersInPeriod,
        newCustomersInPeriod,
        activePartnersInPeriod: partnerIdsInPeriod.size,

        // All-Time metrics for reference
        allTimeFiles: allTimeTotalFiles,
        allTimeDisbursedFiles,
        allTimeApprovedFiles,
        allTimeRejectedFiles,
        allTimeInProcessFiles,

        // 12-Month Performance Breakdown for the selected / current year
        monthlyBreakdown,
      });
    } catch (err) {
      console.error("Dashboard error:", err);
      res.status(500).json({ message: "Failed to fetch dashboard stats" });
    }
  }
);

// Get recent activities for admin dashboard
router.get(
  "/recent-activities",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;

      const activities = [];

      // 1. Recent customers registered
      const recentCustomers = await User.find({ role: ROLES.CUSTOMER })
        .select("firstName lastName email createdAt")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      recentCustomers.forEach((customer) => {
        activities.push({
          type: "customer_registered",
          title: "New customer registered",
          description: `${customer.firstName} ${customer.lastName}`,
          timestamp: customer.createdAt,
          icon: "users",
          iconColor: "blue",
        });
      });

      // 2. Recent payouts completed
      const recentPayouts = await Payout.find({ status: "PAID" })
        .populate("partnerId", "firstName lastName")
        .select("amount status updatedAt partnerId")
        .sort({ updatedAt: -1 })
        .limit(5)
        .lean();

      recentPayouts.forEach((payout) => {
        const partnerName = payout.partnerId
          ? `${payout.partnerId.firstName} ${payout.partnerId.lastName}`
          : "Unknown Partner";
        activities.push({
          type: "payout_completed",
          title: "Payout completed",
          description: `₹${payout.amount.toLocaleString()} to ${partnerName}`,
          timestamp: payout.updatedAt,
          icon: "banknote",
          iconColor: "green",
        });
      });

      // 3. Recent partners onboarded
      const recentPartners = await User.find({ role: ROLES.PARTNER })
        .select("firstName lastName email employeeId partnerCode createdAt")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      recentPartners.forEach((partner) => {
        activities.push({
          type: "partner_onboarded",
          title: "New partner onboarded",
          description: `${partner.firstName} ${partner.lastName} (${partner.partnerCode || partner.employeeId})`,
          timestamp: partner.createdAt,
          icon: "userCheck",
          iconColor: "purple",
        });
      });

      // 4. Recent application status changes (important ones)
      const recentApplications = await Application.find({
        status: { $in: ["APPROVED", "DISBURSED", "REJECTED"] },
      })
        .populate("customerId", "firstName lastName")
        .populate("partnerId", "firstName lastName")
        .select("appNo status loanType approvedLoanAmount updatedAt customerId partnerId")
        .sort({ updatedAt: -1 })
        .limit(5)
        .lean();

      recentApplications.forEach((app) => {
        const customerName = app.customerId
          ? `${app.customerId.firstName} ${app.customerId.lastName}`
          : "Unknown Customer";
        let title = "";
        let iconColor = "";

        if (app.status === "APPROVED") {
          title = "Application approved";
          iconColor = "green";
        } else if (app.status === "DISBURSED") {
          title = "Loan disbursed";
          iconColor = "blue";
        } else if (app.status === "REJECTED") {
          title = "Application rejected";
          iconColor = "red";
        }

        if (title) {
          activities.push({
            type: "application_status",
            title,
            description: `${customerName} - ${app.appNo}`,
            timestamp: app.updatedAt,
            icon: "fileText",
            iconColor,
          });
        }
      });

      // Sort all activities by timestamp (most recent first) and limit
      activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const limitedActivities = activities.slice(0, limit);

      // Format timestamps to relative time
      const formatTimeAgo = (date) => {
        const now = new Date();
        const diff = now - new Date(date);
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return "Just now";
        if (minutes < 60) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
        if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
        return `${days} day${days > 1 ? "s" : ""} ago`;
      };

      const formattedActivities = limitedActivities.map((activity) => ({
        ...activity,
        timeAgo: formatTimeAgo(activity.timestamp),
      }));

      res.json({
        success: true,
        activities: formattedActivities,
        count: formattedActivities.length,
      });
    } catch (err) {
      console.error("Recent activities error:", err);
      res.status(500).json({
        success: false,
        message: "Failed to fetch recent activities",
        error: err.message,
      });
    }
  }
);

router.post(
  "/asm-deactivate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { oldAsmId, newAsmId } = req.body;

      console.log(oldAsmId);

      if (!oldAsmId || !newAsmId) {
        return res.status(400).json({ message: "Both ASM IDs are required" });
      }

      let oldAsm;
      let newAsm;
      let reassignmentAudit;
      let transferStats;
      await session.withTransaction(async () => {
        transferStats = await reassignAsmWorkload({
          oldAsmId,
          newAsmId,
          session,
        });

        oldAsm = await User.findOneAndUpdate(
          { _id: oldAsmId, role: { $in: [ROLES.ASM, ROLES.RSM] } },
          { $set: { status: "SUSPENDED" } },
          { new: true, session }
        );
        newAsm = await User.findOne({ _id: newAsmId, role: { $in: [ROLES.ASM, ROLES.RSM] } }).session(session);
        if (!newAsm) {
          throw new Error("New manager not found or invalid");
        }

        reassignmentAudit = buildReassignmentAudit({
          changedBy: req.user.sub,
          oldUserId: oldAsmId,
          newUserId: newAsmId,
          action: "admin_asm_deactivate",
        });
        await persistReassignmentAudit(reassignmentAudit, req, session);
      });

      if (oldAsm) {
        // 📧 Send deactivation mail
        try {
          await sendMail({
            to: oldAsm.email,
            subject: "Your ASM Account Has Been Deactivated",
            html: `
              <p>Dear ${oldAsm.firstName} ${oldAsm.lastName},</p>
              <p>Your ASM account has been <b>deactivated</b> and all your RMs, Partners, and Customers have been reassigned to another ASM.</p>
              <p><b>Employee ID:</b> ${oldAsm.employeeId}</p>
              <p><b>ASM Code:</b> ${oldAsm.asmCode}</p>
              <p>If you believe this action was incorrect, please contact support immediately.</p>
              <br/>
              <p>Regards,<br/>DhanSource Capital</p>
            `,
          });
        } catch (mailErr) {
          console.error("Failed to send deactivation email:", mailErr.message);
        }
      }

      if (newAsm) {
        // 📧 Send assignment mail
        try {
          await sendMail({
            to: newAsm.email,
            subject: "You Have Been Assigned New ASM Responsibilities",
            html: `
              <p>Dear ${newAsm.firstName} ${newAsm.lastName},</p>
              <p>You have been assigned new RMs, Partners, and Customers from another ASM who has been deactivated.</p>
              <p><b>Employee ID:</b> ${newAsm.employeeId}</p>
              <p><b>ASM Code:</b> ${newAsm.asmCode}</p>
              <p>Please review your dashboard to manage your newly assigned team and customers.</p>
              <br/>
              <p>Regards,<br/>DhanSource Capital</p>
            `,
          });
          console.log("📧 Assignment mail sent to:", newAsm.email);
        } catch (mailErr) {
          console.error("Failed to send assignment email:", mailErr.message);
        }
      }

      res.json({
        message:
          "All RMs, Partners, Customers and open applications reassigned to new ASM. Settled history preserved. Old ASM deactivated.",
        reassignmentAudit,
        transferStats,
      });
    } catch (error) {
      if (error.message === "New ASM not found or invalid") {
        return res.status(404).json({ message: error.message });
      }
      console.error("Error in assign-rms-to-asm:", error);
      res.status(500).json({ message: error.message });
    } finally {
      await session.endSession();
    }
  }
);

// Activate ASM (Admin only)
router.post(
  "/asm-activate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { asmId } = req.body;

      if (!asmId) {
        return res.status(400).json({ message: "asmId is required" });
      }

      const asm = await User.findOneAndUpdate(
        { _id: asmId, role: ROLES.ASM },
        { status: "ACTIVE" },
        { new: true }
      );

      if (!asm) {
        return res.status(404).json({ message: "ASM not found" });
      }

      // 📧 Send activation email
      try {
        await sendMail({
          to: asm.email,
          subject: "Your ASM Account Has Been Activated",
          html: `
            <p>Dear ${asm.firstName} ${asm.lastName},</p>
            <p>We are pleased to inform you that your ASM account has been <b>activated</b> successfully.</p>
            <p><b>Employee ID:</b> ${asm.employeeId || "-"}<br/>
            <b>ASM Code:</b> ${asm.asmCode || "-"}</p>
            <p>You can now log in and start managing your RSMs and their RMs as usual.</p>
            <br/>
            <p>Regards,<br/>DhanSource Capital</p>
          `,
        });
        console.log("📧 ASM activation mail sent to:", asm.email);
      } catch (mailErr) {
        console.error("❌ Failed to send ASM activation email:", mailErr.message);
      }

      res.json({
        message: "ASM activated successfully and notified via email",
      });
    } catch (error) {
      console.error("Error in /asm/activate:", error);
      res.status(500).json({ message: error.message });
    }
  }
);

// Deactivate RSM and Reassign
router.post(
  "/rsm-deactivate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { rsmId, newRsmId } = req.body;

      if (!rsmId || !newRsmId) {
        return res.status(400).json({ message: "Both RSM IDs are required" });
      }

      let oldRsm;
      let newRsm;
      let reassignmentAudit;
      let transferResult;
      await session.withTransaction(async () => {
        oldRsm = await User.findOne({ _id: rsmId, role: { $in: [ROLES.RSM, ROLES.ASM] } }).session(session);
        if (!oldRsm) {
          throw new Error("Old manager not found");
        }

        newRsm = await User.findOne({ _id: newRsmId, role: { $in: [ROLES.RSM, ROLES.ASM] }, status: "ACTIVE" }).session(session);
        if (!newRsm) {
          throw new Error("Active replacement manager not found");
        }

        transferResult = await reassignRsmWorkload({
          oldRsmId: rsmId,
          newRsmId,
          session,
        });

        await User.findOneAndUpdate(
          { _id: rsmId, role: { $in: [ROLES.RSM, ROLES.ASM] } },
          { $set: { status: "SUSPENDED" } },
          { new: true, session }
        );

        reassignmentAudit = buildReassignmentAudit({
          changedBy: req.user.sub,
          oldUserId: rsmId,
          newUserId: newRsmId,
          action: "admin_rsm_deactivate",
        });
        await persistReassignmentAudit(reassignmentAudit, req, session);
      });

      // Send Mails
      if (oldRsm && oldRsm.email) {
        sendMail({
          to: oldRsm.email,
          subject: "Your RSM Account Has Been Deactivated",
          html: `<p>Dear ${oldRsm.firstName}, your RSM account has been deactivated and your RMs and open applications have been reassigned.</p>`,
        }).catch(err => console.error(err));
      }
      if (newRsm && newRsm.email) {
        sendMail({
          to: newRsm.email,
          subject: "You Have Been Assigned New RMs",
          html: `<p>Dear ${newRsm.firstName}, you have been assigned RMs and application files from a deactivated RSM.</p>`,
        }).catch(err => console.error(err));
      }

      res.json({
        message: "RSM deactivated and workload reassigned successfully.",
        transferResult,
        reassignmentAudit,
      });
    } catch (error) {
      if (error.message === "Old RSM not found" || error.message === "Active replacement RSM not found") {
        return res.status(404).json({ message: error.message });
      }
      console.error("Error in /rsm-deactivate:", error);
      res.status(500).json({ message: error.message });
    } finally {
      await session.endSession();
    }
  }
);

// Admin transfer entire RSM workload (all RMs & files) to another RSM
router.post(
  "/transfer-rsm-workload",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { fromRsmId, toRsmId } = req.body || {};
      if (!fromRsmId || !toRsmId) {
        return res.status(400).json({ message: "Both fromRsmId and toRsmId are required" });
      }

      if (String(fromRsmId) === String(toRsmId)) {
        return res.status(400).json({ message: "Source RSM and Target RSM must be different" });
      }

      let fromRsm;
      let toRsm;
      let transferResult;
      let reassignmentAudit;

      await session.withTransaction(async () => {
        fromRsm = await User.findById(fromRsmId).session(session);
        if (!fromRsm || fromRsm.role !== ROLES.RSM) {
          throw new Error("Source RSM not found");
        }

        toRsm = await User.findOne({ _id: toRsmId, role: ROLES.RSM, status: "ACTIVE" }).session(session);
        if (!toRsm) {
          throw new Error("Active Target RSM not found");
        }

        transferResult = await reassignRsmWorkload({
          oldRsmId: fromRsmId,
          newRsmId: toRsmId,
          session,
        });

        reassignmentAudit = buildReassignmentAudit({
          changedBy: req.user.sub,
          oldUserId: fromRsmId,
          newUserId: toRsmId,
          action: "admin_rsm_workload_transfer",
        });
        await persistReassignmentAudit(reassignmentAudit, req, session);
      });

      // Send notifications / emails
      if (fromRsm?.email) {
        sendMail({
          to: fromRsm.email,
          subject: "Your Workload Has Been Transferred",
          html: `<p>Dear ${fromRsm.firstName}, your assigned RMs and workload have been transferred to ${toRsm.firstName} ${toRsm.lastName}.</p>`,
        }).catch((e) => console.error(e));
      }

      if (toRsm?.email) {
        sendMail({
          to: toRsm.email,
          subject: "New Workload Assigned",
          html: `<p>Dear ${toRsm.firstName}, you have received RMs and active loan files from ${fromRsm.firstName} ${fromRsm.lastName}.</p>`,
        }).catch((e) => console.error(e));
      }

      return res.json({
        message: `Successfully transferred workload from ${fromRsm.firstName} ${fromRsm.lastName} to ${toRsm.firstName} ${toRsm.lastName}`,
        transferResult,
        reassignmentAudit,
      });
    } catch (err) {
      console.error("Error in transfer-rsm-workload:", err);
      return res.status(500).json({ message: err.message || "Failed to transfer RSM workload" });
    } finally {
      await session.endSession();
    }
  }
);

// Admin transfer single or multiple RMs to an RSM
router.post(
  "/transfer-rm-to-rsm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { rmId, rmIds, toRsmId } = req.body || {};
      if (!toRsmId) {
        return res.status(400).json({ message: "Target RSM ID (toRsmId) is required" });
      }

      const targetRsm = await User.findOne({ _id: toRsmId, role: ROLES.RSM, status: "ACTIVE" });
      if (!targetRsm) {
        return res.status(404).json({ message: "Active Target RSM not found" });
      }

      const idsToTransfer = Array.isArray(rmIds) && rmIds.length > 0 ? rmIds : (rmId ? [rmId] : []);
      if (!idsToTransfer.length) {
        return res.status(400).json({ message: "At least one rmId is required" });
      }

      let transfers = [];
      await session.withTransaction(async () => {
        for (const id of idsToTransfer) {
          const resTransfer = await transferRmToRsm({ rmId: id, toRsmId, session });
          transfers.push(resTransfer);
        }
      });

      return res.json({
        message: `Successfully transferred ${transfers.length} RM(s) to ${targetRsm.firstName} ${targetRsm.lastName}`,
        transfers,
      });
    } catch (err) {
      console.error("Error transferring RM to RSM:", err);
      return res.status(500).json({ message: err.message || "Failed to transfer RM to RSM" });
    } finally {
      await session.endSession();
    }
  }
);

// Get all RMs for allocation/transfer UI with their hierarchy details
router.get(
  "/get-rms-for-transfer",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const rms = await User.find({ role: ROLES.RM })
        .populate("asmId", "firstName lastName employeeId")
        .populate("personalRsmId", "firstName lastName employeeId status")
        .populate("businessRsmId", "firstName lastName employeeId status")
        .populate("homeLapRsmId", "firstName lastName employeeId status")
        .populate("businessHomeRsmId", "firstName lastName employeeId status")
        .select("-passwordHash -__v")
        .lean();

      const result = await Promise.all(
        rms.map(async (rm) => {
          const partnerCount = await User.countDocuments({ role: ROLES.PARTNER, rmId: rm._id });
          const appCount = await Application.countDocuments({ rmId: rm._id, status: { $ne: "DRAFT" } });
          return {
            ...rm,
            partnerCount,
            appCount,
          };
        })
      );

      res.json(result);
    } catch (err) {
      console.error("Error fetching RMs for transfer:", err);
      res.status(500).json({ message: "Failed to fetch RMs for transfer" });
    }
  }
);


// Deactivate RM and Reassign
router.post(
  "/rm-deactivate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { oldRmId, newRmId } = req.body;

      if (!oldRmId || !newRmId) {
        return res.status(400).json({ message: "Both old and new RM IDs are required" });
      }

      let oldRm;
      let newRm;
      let reassignmentAudit;
      let transferStats;
      await session.withTransaction(async () => {
        transferStats = await reassignRmWorkload({
          oldRmId,
          newRmId,
          session,
        });

        oldRm = await User.findOneAndUpdate(
          { _id: oldRmId, role: ROLES.RM },
          { $set: { status: "SUSPENDED" } },
          { new: true, session }
        );
        newRm = await User.findById(newRmId).session(session);
        if (!newRm || newRm.role !== ROLES.RM) {
          throw new Error("New RM not found or invalid");
        }
        reassignmentAudit = buildReassignmentAudit({
          changedBy: req.user.sub,
          oldUserId: oldRmId,
          newUserId: newRmId,
          action: "admin_rm_deactivate",
        });
        await persistReassignmentAudit(reassignmentAudit, req, session);
      });

      // Send Mails
      if (oldRm && oldRm.email) {
        sendMail({
          to: oldRm.email,
          subject: "Your RM Account Has Been Deactivated",
          html: `<p>Dear ${oldRm.firstName}, your RM account has been deactivated and your Partners have been reassigned.</p>`,
        }).catch(err => console.error(err));
      }
      if (newRm && newRm.email) {
        sendMail({
          to: newRm.email,
          subject: "You Have Been Assigned New Partners",
          html: `<p>Dear ${newRm.firstName}, you have been assigned Partners from a deactivated RM.</p>`,
        }).catch(err => console.error(err));
      }

      res.json({
        message:
          "RM deactivated. Partners, customers and open applications reassigned with hierarchy intact. Settled loans preserved.",
        reassignmentAudit,
        transferStats,
      });
    } catch (error) {
      console.error("Error in /rm-deactivate:", error);
      res.status(500).json({ message: error.message });
    } finally {
      await session.endSession();
    }
  }
);

// Deactivate Partner
router.post(
  "/partner-deactivate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { oldPartnerId, newPartnerId } = req.body;

      if (!oldPartnerId || !newPartnerId) {
        return res.status(400).json({ message: "Both oldPartnerId and newPartnerId are required" });
      }

      let transferStats;
      let oldPartner;
      let reassignmentAudit;

      await session.withTransaction(async () => {
        transferStats = await reassignPartnerWorkload({
          oldPartnerId,
          newPartnerId,
          session,
        });

        oldPartner = await User.findOneAndUpdate(
          { _id: oldPartnerId, role: ROLES.PARTNER },
          { $set: { status: "SUSPENDED" } },
          { new: true, session }
        );
        if (!oldPartner) {
          throw new Error("Old Partner not found");
        }

        reassignmentAudit = buildReassignmentAudit({
          changedBy: req.user.sub,
          oldUserId: oldPartnerId,
          newUserId: newPartnerId,
          action: "admin_partner_deactivate",
        });
        await persistReassignmentAudit(reassignmentAudit, req, session);
      });

      if (!oldPartner) {
        return res.status(404).json({ message: "Old Partner not found" });
      }

      const newPartner = await User.findById(newPartnerId);

      // Mails
      if (oldPartner && oldPartner.email) {
        sendMail({
          to: oldPartner.email,
          subject: "Your Partner Account Has Been Deactivated",
          html: `<p>Dear ${oldPartner.firstName}, your Partner account has been suspended and your customers have been reassigned.</p>`,
        }).catch(err => console.error(err));
      }
      if (newPartner && newPartner.email) {
        sendMail({
          to: newPartner.email,
          subject: "You Have Been Assigned New Customers",
          html: `<p>Dear ${newPartner.firstName}, you have been assigned Customers from a deactivated Partner.</p>`,
        }).catch(err => console.error(err));
      }

      res.json({
        message:
          "Partner deactivated and active workload reassigned with RM/ASM hierarchy. Settled finance/history is preserved.",
        reassignmentAudit,
        transferStats,
      });
    } catch (error) {
      if (error.message === "Old Partner not found") {
        return res.status(404).json({ message: error.message });
      }
      console.error("Error in /partner-deactivate:", error);
      res.status(500).json({ message: error.message });
    } finally {
      await session.endSession();
    }
  }
);


// Soft-retain ASM account (never hard-delete — keeps historical Application.asmId refs)
router.delete(
  "/asm/:asmId",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { asmId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(asmId)) {
        return res.status(400).json({ message: "Invalid ASM id" });
      }

      const asm = await User.findOne({ _id: asmId, role: ROLES.ASM });
      if (!asm) {
        return res.status(404).json({ message: "ASM not found" });
      }

      if (asm.status === "ACTIVE") {
        return res
          .status(400)
          .json({ message: "Deactivate ASM before removing the account" });
      }

      const [rsmCount, rmCount] = await Promise.all([
        User.countDocuments({ role: ROLES.RSM, asmId }),
        User.countDocuments({ role: ROLES.RM, asmId }),
      ]);
      if (rsmCount > 0 || rmCount > 0) {
        return res.status(400).json({
          message:
            "Cannot remove ASM while RSMs/RMs remain linked. Reassign hierarchy first so loan data is not orphaned.",
          rsms: rsmCount,
          rms: rmCount,
        });
      }

      asm.status = "SUSPENDED";
      asm.deletedAt = softHideTimestamp();
      await asm.save();
      await Target.deleteMany({ assignedTo: asm._id });

      res.json({
        message:
          "ASM soft-removed. Account retained for audit; no applications or customers were deleted.",
        id: asm._id,
        email: asm.email,
        hardDeleted: false,
      });
    } catch (error) {
      console.error("Error deleting ASM:", error);
      res.status(500).json({ message: "Failed to delete ASM" });
    }
  }
);


// Activate RM (Admin only)
router.post(
  "/rm-activate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { rmId } = req.body;

      if (!rmId) {
        return res.status(400).json({ message: "rmId is required" });
      }

      const rm = await User.findOneAndUpdate(
        { _id: rmId, role: ROLES.RM },
        { status: "ACTIVE" },
        { new: true }
      );

      if (!rm) {
        return res.status(404).json({ message: "RM not found" });
      }

      // 📧 Send activation email
      try {
        await sendMail({
          to: rm.email,
          subject: "Your RM Account Has Been Activated",
          html: `
            <p>Dear ${rm.firstName} ${rm.lastName},</p>
            <p>We are pleased to inform you that your RM account has been <b>activated</b> successfully.</p>
            <p><b>Employee ID:</b> ${rm.employeeId || "-"}<br/>
            <b>RM Code:</b> ${rm.rmCode || "-"}</p>
            <p>You can now log in and start managing your Partners and Customers as usual.</p>
            <br/>
            <p>Regards,<br/>DhanSource Capital</p>
          `,
        });
        console.log("📧 RM activation mail sent to:", rm.email);
      } catch (mailErr) {
        console.error("❌ Failed to send RM activation email:", mailErr.message);
      }

      res.json({
        message: "RM activated successfully and notified via email",
      });
    } catch (error) {
      console.error("Error in /rm/activate:", error);
      res.status(500).json({ message: error.message });
    }
  }
);


// Activate RSM (Admin only)
router.post(
  "/rsm-activate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { rsmId } = req.body;

      if (!rsmId) {
        return res.status(400).json({ message: "rsmId is required" });
      }

      const rsm = await User.findOneAndUpdate(
        { _id: rsmId, role: ROLES.RSM },
        { status: "ACTIVE" },
        { new: true }
      );

      if (!rsm) {
        return res.status(404).json({ message: "RSM not found" });
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
            <p>Regards,<br/>DhanSource Capital</p>
          `,
        });
        console.log("📧 RSM activation mail sent to:", rsm.email);
      } catch (mailErr) {
        console.error("❌ Failed to send RSM activation email:", mailErr.message);
      }

      res.json({
        message: "RSM activated successfully and notified via email",
      });
    } catch (error) {
      console.error("Error in /rsm/activate:", error);
      res.status(500).json({ message: error.message });
    }
  }
);

// Soft-retain RSM account (never hard-delete)
router.delete(
  "/rsm/:rsmId",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { rsmId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(rsmId)) {
        return res.status(400).json({ message: "Invalid RSM id" });
      }

      const rsm = await User.findOne({ _id: rsmId, role: ROLES.RSM });
      if (!rsm) {
        return res.status(404).json({ message: "RSM not found" });
      }

      if (rsm.status === "ACTIVE") {
        return res
          .status(400)
          .json({ message: "Deactivate RSM before removing the account" });
      }

      const rmStillLinked = await User.countDocuments({
        role: ROLES.RM,
        $or: [
          { personalRsmId: rsmId },
          { businessRsmId: rsmId },
          { homeLapRsmId: rsmId },
          { businessHomeRsmId: rsmId },
        ],
      });
      if (rmStillLinked > 0) {
        return res.status(400).json({
          message:
            "Cannot remove RSM while RMs are still assigned. Reassign them first so loan data is not orphaned.",
          rms: rmStillLinked,
        });
      }

      rsm.status = "SUSPENDED";
      rsm.deletedAt = softHideTimestamp();
      await rsm.save();
      await Target.deleteMany({ assignedTo: rsm._id });

      res.json({
        message:
          "RSM soft-removed. Account retained for audit; no applications or customers were deleted.",
        id: rsm._id,
        email: rsm.email,
        hardDeleted: false,
      });
    } catch (error) {
      console.error("Error deleting RSM:", error);
      res.status(500).json({ message: "Failed to delete RSM" });
    }
  }
);

// Update RSM or ASM details and/or role specialty type (Admin)
router.patch(
  ["/rsm/:rsmId", "/asm/:asmId"],
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  async (req, res) => {
    try {
      const targetId = req.params.rsmId || req.params.asmId;
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ message: "Invalid manager id" });
      }

      const rsm = await User.findOne({ _id: targetId, role: { $in: [ROLES.ASM, ROLES.RSM] } });
      if (!rsm) {
        return res.status(404).json({ message: "Manager not found" });
      }

      const { firstName, lastName, phone, email, rsmType, asmType, asmId, rsmId, region } = req.body || {};
      const newType = asmType || rsmType;

      if (newType && !Object.values(ASM_TYPES).includes(newType)) {
        return res.status(400).json({
          message: `Invalid specialty type. Allowed: ${Object.values(ASM_TYPES).join(", ")}`,
        });
      }

      // Check email/phone uniqueness if changed
      if (email && email.trim().toLowerCase() !== (rsm.email || "").toLowerCase()) {
        const existingEmail = await User.findOne({
          _id: { $ne: rsm._id },
          email: email.trim().toLowerCase(),
        }).lean();
        if (existingEmail) {
          return res.status(409).json({ message: "Email already in use", field: "email" });
        }
        rsm.email = email.trim().toLowerCase();
      }

      if (phone && phone.trim() !== (rsm.phone || "")) {
        const existingPhone = await User.findOne({
          _id: { $ne: rsm._id },
          phone: phone.trim(),
        }).lean();
        if (existingPhone) {
          return res.status(409).json({ message: "Phone number already in use", field: "phone" });
        }
        rsm.phone = phone.trim();
      }

      if (firstName !== undefined && firstName.trim() !== "") {
        rsm.firstName = firstName.trim();
      }
      if (lastName !== undefined && lastName.trim() !== "") {
        rsm.lastName = lastName.trim();
      }
      if (region !== undefined) {
        rsm.region = region;
      }

      const rawParentId = rsmId || asmId;
      const parentManagerId =
        rawParentId && typeof rawParentId === "object"
          ? rawParentId._id || rawParentId.id
          : rawParentId;
      if (parentManagerId && mongoose.Types.ObjectId.isValid(String(parentManagerId))) {
        const parent = await User.findOne({
          _id: parentManagerId,
          role: { $in: [ROLES.RSM, ROLES.ASM] },
        });
        if (!parent) return res.status(404).json({ message: "Parent manager not found" });
        rsm.rsmId = parent._id;
        rsm.asmId = parent._id;
      }

      const oldType = rsm.asmType || rsm.rsmType;
      if (newType && newType !== oldType) {
        rsm.asmType = newType;
        rsm.rsmType = newType;

        // Sync RMs linked to this manager
        if (newType === ASM_TYPES.BUSINESS) {
          await User.updateMany(
            { role: ROLES.RM, $or: [{ businessHomeRsmId: rsm._id }, { businessRsmId: rsm._id }, { businessAsmId: rsm._id }] },
            { $set: { businessAsmId: rsm._id, businessRsmId: rsm._id, businessHomeRsmId: rsm._id, businessHomeAsmId: rsm._id } }
          );
        } else if (newType === ASM_TYPES.HOME_LAP) {
          await User.updateMany(
            { role: ROLES.RM, $or: [{ businessHomeRsmId: rsm._id }, { homeLapRsmId: rsm._id }, { homeLapAsmId: rsm._id }] },
            { $set: { homeLapAsmId: rsm._id, homeLapRsmId: rsm._id } }
          );
        } else if (newType === ASM_TYPES.PERSONAL) {
          await User.updateMany(
            { role: ROLES.RM, $or: [{ personalRsmId: rsm._id }, { personalAsmId: rsm._id }] },
            { $set: { personalAsmId: rsm._id, personalRsmId: rsm._id } }
          );
        }
      }

      await rsm.save();

      return res.json({
        message: "Manager updated successfully",
        rsm: {
          _id: rsm._id,
          firstName: rsm.firstName,
          lastName: rsm.lastName,
          email: rsm.email,
          phone: rsm.phone,
          employeeId: rsm.employeeId,
          asmType: rsm.asmType || rsm.rsmType,
          rsmType: rsm.asmType || rsm.rsmType,
          rsmId: rsm.rsmId || rsm.asmId,
          asmId: rsm.rsmId || rsm.asmId,
          region: rsm.region,
          status: rsm.status,
        },
      });
    } catch (error) {
      console.error("Error updating RSM:", error);
      res.status(500).json({ message: error.message || "Failed to update RSM" });
    }
  }
);

// Soft-retain RM account (never hard-delete — keeps Application.rmId history)
router.delete(
  "/rm/:rmId",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { rmId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(rmId)) {
        return res.status(400).json({ message: "Invalid RM id" });
      }

      const rm = await User.findOne({ _id: rmId, role: ROLES.RM });
      if (!rm) {
        return res.status(404).json({ message: "RM not found" });
      }

      if (rm.status === "ACTIVE") {
        return res
          .status(400)
          .json({ message: "Deactivate RM before removing the account" });
      }

      const partnerCount = await User.countDocuments({
        role: ROLES.PARTNER,
        rmId,
      });
      if (partnerCount > 0) {
        return res.status(400).json({
          message:
            "Cannot remove RM while partners remain linked. Use RM deactivate + reassign first.",
          partners: partnerCount,
        });
      }

      rm.status = "SUSPENDED";
      rm.deletedAt = softHideTimestamp();
      await rm.save();
      await Target.deleteMany({ assignedTo: rm._id });

      res.json({
        message:
          "RM soft-removed. Account retained for audit; no applications or customers were deleted.",
        id: rm._id,
        email: rm.email,
        hardDeleted: false,
      });
    } catch (error) {
      console.error("Error deleting RM:", error);
      res.status(500).json({ message: "Failed to delete RM" });
    }
  }
);


router.post(
  "/partner-activate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { partnerId } = req.body;

      if (!partnerId) {
        return res.status(400).json({ message: "partnerId is required" });
      }

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
  }
);

// Reject PENDING partner registration only.
// Active partners with loan book cannot be hard-deleted (prevents data loss).
router.delete(
  "/partner/:partnerId",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { partnerId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(partnerId)) {
        return res.status(400).json({ message: "Invalid Partner id" });
      }

      const partner = await User.findOne({ _id: partnerId, role: ROLES.PARTNER });
      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      const [appCount, payoutCount, customerCount] = await Promise.all([
        Application.countDocuments(activeApplicationsFilter({ partnerId: partner._id })),
        Payout.countDocuments({ partnerId: partner._id }),
        User.countDocuments({ role: ROLES.CUSTOMER, partnerId: partner._id, deletedAt: null }),
      ]);

      if (
        String(partner.status || "").toUpperCase() !== "PENDING" ||
        appCount > 0 ||
        payoutCount > 0 ||
        customerCount > 0
      ) {
        return res.status(400).json({
          message: dataPreservationBlockMessage("partner"),
          hint: "Use partner deactivate + reassign to another partner. Hard delete is only allowed for PENDING registrations with no applications.",
          status: partner.status,
          applications: appCount,
          payouts: payoutCount,
          customers: customerCount,
        });
      }

      // PENDING registration with no loan data — remove registration only
      await Target.deleteMany({ assignedTo: partner._id });
      await User.deleteOne({ _id: partner._id });

      try {
        await sendMail({
          to: partner.email,
          subject: "Partner Registration Request Rejected",
          html: `
            <p>Dear ${partner.firstName} ${partner.lastName},</p>
            <p>We regret to inform you that your Partner registration request has been <b>rejected</b>.</p>
            <p><b>Partner ID:</b> ${partner.partnerCode || partner.employeeId || "-"}</p>
            <p>If you believe this action was incorrect, please contact support.</p>
            <br/>
            <p>Regards,<br/>DhanSource Capital</p>
          `,
        });
      } catch (mailErr) {
        console.error("❌ Failed to send rejection email:", mailErr.message);
      }

      res.json({
        message: "Pending partner registration rejected. No loan applications were deleted.",
        id: partner._id,
        email: partner.email,
        hardDeletedApplications: 0,
      });
    } catch (error) {
      console.error("Error rejecting partner:", error);
      res.status(500).json({
        message: "Failed to reject partner",
        error: error.message,
      });
    }
  }
);

// GET /asm/list-with-rm-count           -   non in use in frontend
router.get(
  "/asm/list-with-rm-count",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      // ✅ Find all ASMs

      const asms = await User.find({
        role: ROLES.ASM,
        status: "ACTIVE",
      }).select("firstName lastName region email status");

      // ✅ For each ASM, count how many RMs are under them

      const result = await Promise.all(
        asms.map(async (asm) => {
          const rmCount = await User.countDocuments({
            role: ROLES.RM,
            asmId: asm._id,
          });

          return {
            id: asm._id,

            name: `${asm.firstName} ${asm.lastName}`,

            email: asm.email,

            region: asm.region,

            status: asm.status,

            rmCount,
          };
        })
      );

      res.json({
        message: "ASM list with RM count fetched successfully",

        asms: result,
      });
    } catch (error) {
      console.error("ASM list fetch error:", error);

      res.status(500).json({ message: error.message });
    }
  }
);

// assign partner to rm  if partner signup self
router.patch("/assign-partner", async (req, res) => {
  try {
    const { partnerId, rmCode } = req.body;

    if (!partnerId || !rmCode) {
      return res
        .status(400)
        .json({ message: "partnerId and rmCode are required" });
    }

    // Find RM
    const rm = await User.findOne({ rmCode, role: ROLES.RM });
    if (!rm) return res.status(404).json({ message: "RM not found" });

    // Find Partner
    const partner = await User.findById(partnerId);
    if (!partner) return res.status(404).json({ message: "Partner not found" });

    // Update partner assignment
    partner.rmId = rm._id;
    partner.status = "ACTIVE"; // Activate partner once assigned to RM
    await partner.save();

    res.status(200).json({
      message: "Partner successfully assigned to RM",
      partnerId: partner._id,
      rmId: rm._id,
      status: partner.status,
    });
  } catch (err) {
    console.error("Error assigning partner:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
// GET /asm/top-performer-rm-list
router.get(
  "/top-performer",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const adminId = req.user.sub;

      const topASM = await Payout.aggregate([
        { $match: { adminId } },
        { $group: { _id: "$asmId", totalRevenue: { $sum: "$amount" } } },
        { $sort: { totalRevenue: -1 } },
        { $limit: 10 },
      ]);

      if (!topASM.length) {
        return res.json({ message: "No top performer yet" });
      }

      const asm = await User.findById(topASM[0]._id).select(
        "firstName lastName email rating"
      );
      res.json({
        id: asm._id,
        name: `${asm.firstName} ${asm.lastName}`,
        rating: asm.rating,
        revenue: topASM[0].totalRevenue,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Error fetching top performer" });
    }
  }
);

router.get(
  "/profile",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const adminId = req.user.sub; // use sub instead of id

      if (!mongoose.Types.ObjectId.isValid(adminId)) {
        return res.status(400).json({ message: "Invalid admin id" });
      }

      const admin = await User.findById(adminId).select("-passwordHash").lean();

      if (!admin) {
        return res.status(404).json({ message: "Admin not found" });
      }

      res.json({ profile: admin });
    } catch (err) {
      console.error("Error fetching admin profile:", err);
      res.status(500).json({ message: "Server error: " + err.message });
    }
  }
);

// PATCH /admin/profile/update
router.patch(
  "/profile/update",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  async (req, res) => {
    try {
      const adminId = req.user.sub;

      // Pick only editable fields
      const {
        firstName,
        lastName,
        currentEmail,
        currentPassword,
        email,
        phone,
        dob,
        address,
        department,
        experience,
      } = req.body;

      const updateData = {
        firstName,
        lastName,
        phone,
        dob,
        address,
        department,
        experience,
      };

      if (phone) {
        const normalizedPhone = String(phone).replace(/\D/g, "").slice(-10);
        const existingPhoneUser = await User.findOne({
          phone: normalizedPhone,
          _id: { $ne: adminId },
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
          _id: { $ne: adminId },
        }).select("_id");
        if (existingEmailUser) {
          return res.status(409).json({
            message: `The email address ${email} is already registered to another user.`,
          });
        }
        updateData.email = normalizedEmail;
      }

      // Remove undefined values
      Object.keys(updateData).forEach(
        (key) => updateData[key] === undefined && delete updateData[key]
      );

      const updatedAdmin = await User.findOneAndUpdate(
        { _id: adminId, role: { $in: [ROLES.SUPER_ADMIN, ROLES.ADMIN] } },
        { $set: updateData },
        { new: true, runValidators: true, projection: "-passwordHash" }
      );

      if (!updatedAdmin)
        return res.status(404).json({ message: "Admin not found" });

      const profileObj = updatedAdmin?.toObject ? updatedAdmin.toObject() : updatedAdmin;

      res.json({
        message: "Profile updated successfully",
        profile: profileObj,
      });
    } catch (err) {
      console.error(err);
      if (err.code === 11000) {
        const isPhone = err.message?.includes("phone") || err.keyPattern?.phone;
        const isEmail = err.message?.includes("email") || err.keyPattern?.email;
        const msg = isPhone
          ? "This mobile number is already in use by another user."
          : isEmail
          ? "This email address is already in use by another user."
          : "A record with this information already exists.";
        return res.status(409).json({ message: msg });
      }
      res.status(500).json({ message: err.message || "Failed to update admin profile" });
    }
  }
);

// GET /admin/asm/:asmId (Admin views specific ASM)
router.get(
  "/asm/:asmId/profile",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { asmId } = req.params;
      const asm = await User.findOne({ _id: asmId, role: ROLES.ASM })
        .select("-passwordHash")
        .lean();

      if (!asm) return res.status(404).json({ message: "ASM not found" });

      res.json({ profile: buildProfile(asm) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  }
);

// helper function to avoid code repetition
function buildProfile(asm) {
  return {
    fullName: `${asm.firstName} ${asm.lastName}`,
    employeeId: asm.employeeId,
    email: asm.email,
    phone: asm.phone,
    dob: asm.dob,
    address: asm.address,
    partnershipDate: asm.createdAt,
    partnerType: asm.role,
    verification: asm.status,
    referralCode: asm.asmCode,
    experience: asm.experience,
    region: asm.region,
  };
}

// ================== REMOVED: ASM/RSM/RM TARGET ASSIGNMENT ==================
// Targets are now only for Partners. ASM/RSM/RM targets have been removed.

// router.post(
//   "/target/assign-bulk",
//   auth,
//   requireRole(ROLES.SUPER_ADMIN),
//   async (req, res) => {
//     try {
//       let { month, year, totalTarget } = req.body;
//       if (!month || !year || !totalTarget)
//         return res
//           .status(400)
//           .json({ message: "Month, year, totalTarget required" });

//       totalTarget = Number(totalTarget);
//       year = Number(year);

//       const monthMap = {
//         January: 1,
//         February: 2,
//         March: 3,
//         April: 4,
//         May: 5,
//         June: 6,
//         July: 7,
//         August: 8,
//         September: 9,
//         October: 10,
//         November: 11,
//         December: 12,
//       };
//       if (typeof month === "string") month = monthMap[month];
//       if (!month || month < 1 || month > 12)
//         return res.status(400).json({ message: "Invalid month" });

//       const assignerId = req.user.sub;

//       const asms = await User.find({
//         role: ROLES.ASM,
//         adminId: assignerId,
//       }).lean();
//       if (!asms.length)
//         return res.status(404).json({ message: "No ASMs found" });

//       const assignments = [];
//       const asmTarget = Number((totalTarget / asms.length).toFixed(2));

//       for (let asm of asms) {
//         let target = await Target.findOne({
//           assignedTo: asm._id,
//           role: ROLES.ASM,
//           month,
//           year,
//         });
//         if (target) {
//           target.targetValue += asmTarget; // <-- Increment existing
//           target.assignedBy = assignerId;
//           await target.save();
//         } else {
//           target = await Target.create({
//             assignedBy: assignerId,
//             assignedTo: asm._id,
//             role: ROLES.ASM,
//             month,
//             year,
//             targetValue: asmTarget,
//           });
//         }
//         assignments.push(target);

//         const rms = await User.find({ role: ROLES.RM, asmId: asm._id }).lean();
//         if (rms.length) {
//           const perRmTarget = Number((asmTarget / rms.length).toFixed(2));

//           for (let rm of rms) {
//             let rmT = await Target.findOne({
//               assignedTo: rm._id,
//               role: ROLES.RM,
//               month,
//               year,
//             });
//             if (rmT) {
//               rmT.targetValue += perRmTarget; // <-- Increment existing
//               rmT.assignedBy = assignerId;
//               await rmT.save();
//             } else {
//               rmT = await Target.create({
//                 assignedBy: assignerId,
//                 assignedTo: rm._id,
//                 role: ROLES.RM,
//                 month,
//                 year,
//                 targetValue: perRmTarget,
//               });
//             }
//             assignments.push(rmT);

//             const partners = await User.find({
//               role: ROLES.PARTNER,
//               rmId: rm._id,
//             }).lean();
//             if (partners.length) {
//               const perPartnerTarget = Number(
//                 (perRmTarget / partners.length).toFixed(2)
//               );

//               for (let p of partners) {
//                 let pT = await Target.findOne({
//                   assignedTo: p._id,
//                   role: ROLES.PARTNER,
//                   month,
//                   year,
//                 });
//                 if (pT) {
//                   pT.targetValue += perPartnerTarget; // <-- Increment existing
//                   pT.assignedBy = assignerId;
//                   await pT.save();
//                 } else {
//                   pT = await Target.create({
//                     assignedBy: assignerId,
//                     assignedTo: p._id,
//                     role: ROLES.PARTNER,
//                     month,
//                     year,
//                     targetValue: perPartnerTarget,
//                   });
//                 }
//                 assignments.push(pT);
//               }
//             }
//           }
//         }
//       }

//       res.status(201).json({
//         message: "Bulk hierarchical target incremented successfully",
//         totalTarget,
//         month,
//         year,
//         assignments,
//       });
//     } catch (err) {
//       console.error("Bulk hierarchical target error:", err);
//       res.status(500).json({ message: "Server error" });
//     }
//   }
// );

// ================== REMOVED: ASM/RSM/RM TARGET ASSIGNMENT ==================
// Targets are now only for Partners. ASM/RSM/RM targets have been removed.

router.get(
  "/target/asm/:asmId/:year",
  auth,
  requireRole(ROLES.SUPER_ADMIN), // or ASM if they should see their own yearly targets
  async (req, res) => {
    try {
      const { asmId, year } = req.params;
      const numericYear = Number(year);
      const prevYear = numericYear - 1;

      // fetch all targets of current year
      const currentTargets = await Target.find({
        assignedTo: asmId,
        year: numericYear,
        role: ROLES.ASM,
      });

      // fetch all targets of previous year
      const previousTargets = await Target.find({
        assignedTo: asmId,
        year: prevYear,
        role: ROLES.ASM,
      });

      // build map for quick access
      const currentMap = {};
      currentTargets.forEach((t) => {
        currentMap[t.month] = t;
      });

      const previousMap = {};
      previousTargets.forEach((t) => {
        previousMap[t.month] = t;
      });

      // create result for 12 months
      const result = [];
      for (let month = 1; month <= 12; month++) {
        result.push({
          month,
          currentYear: numericYear,
          currentTarget: currentMap[month] || null,
          previousYear: prevYear,
          previousTarget: previousMap[month] || null,
        });
      }

      res.json({ asmId, year: numericYear, targets: result });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.get(
  "/:id/analytics",
  auth,
  requireRole(ROLES.SUPER_ADMIN), // Only SUPER_ADMIN can access
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid user ID" });
      }

      const user = await User.findById(id).lean();
      if (!user) return res.status(404).json({ message: "User not found" });

      // ⚠️ CRITICAL: If user is SUSPENDED, return zero targets and achievements
      if (user.status === "SUSPENDED") {
        return res.json({
          profile: {
            userId: user._id,
            name: `${user.firstName} ${user.lastName}`,
            role: user.role,
            email: user.email,
            phone: user.phone,
            employeeId: user.employeeId || null,
            status: user.status,
          },
          analytics: {
            totals: {},
            totalDisbursed: 0,
            assignedTarget: { targetValue: 0, achievedValue: 0 },
            performance: "0.00%",
          },
        });
      }

      // Helper: Sum disbursed amounts (only for ACTIVE users)
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

      //   const now = new Date();
      //   const currentMonth = now.getMonth() + 1;
      //   const currentYear = now.getFullYear();
      //   const t = await Target.findOne({
      //     assignedTo: userId,
      //     role,
      //     month: currentMonth,
      //     year: currentYear,
      //   });
      //   return t ? Number(t.targetValue) : 0;
      // };

      // Helper: Get assigned + achieved target
      const getAssignedTarget = async (userId, role, filter) => {
        const monthNames = [
          "January",
          "February",
          "March",
          "April",
          "May",
          "June",
          "July",
          "August",
          "September",
          "October",
          "November",
          "December",
        ];

        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();

        // 🎯 Find target
        const t = await Target.findOne({
          assignedTo: userId,
          role,
          month: currentMonth,
          year: currentYear,
        }).lean();

        // 💰 Calculate achievedValue
        const agg = await Application.aggregate([
          {
            $match: {
              ...filter,
              status: "DISBURSED",
              $expr: {
                $and: [
                  {
                    $eq: [
                      { $month: { $ifNull: ["$disbursedDate", "$createdAt"] } },
                      currentMonth,
                    ],
                  },
                  {
                    $eq: [
                      { $year: { $ifNull: ["$disbursedDate", "$createdAt"] } },
                      currentYear,
                    ],
                  },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: "$approvedLoanAmount" } },
            },
          },
        ]);

        const achievedValue = agg.length > 0 ? Number(agg[0].total) : 0;

        return {
          month: monthNames[currentMonth - 1],
          year: currentYear,
          targetValue: t ? Number(t.disbursementTarget || t.targetValue || 0) : 0,
          achievedValue,
        };
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

      // Role-wise calculations
      if (user.role === ROLES.ASM) {
        // Only include ACTIVE RMs and their ACTIVE partners
        const rms = await User.find({
          asmId: id,
          role: ROLES.RM,
          status: "ACTIVE" // Only ACTIVE RMs
        })
          .select("_id")
          .lean();
        const rmIds = rms.map((x) => x._id);

        const partners = await User.find({
          rmId: { $in: rmIds },
          role: ROLES.PARTNER,
          status: "ACTIVE" // Only ACTIVE partners
        })
          .select("_id")
          .lean();
        const partnerIds = partners.map((x) => x._id);

        const customers = await Application.distinct(
          "customerId",
          activeApplicationsFilter({
            partnerId: { $in: partnerIds },
          })
        );

        totalDisbursed = await sumDisbursedBy({
          partnerId: { $in: partnerIds },
        });
        // assignedTargetValue = await getAssignedTarget(user._id, ROLES.ASM);
        assignedTargetValue = await getAssignedTarget(user._id, ROLES.ASM, {
          partnerId: { $in: partnerIds },
        });

        performance =
          assignedTargetValue.targetValue > 0
            ? (
              (assignedTargetValue.achievedValue /
                assignedTargetValue.targetValue) *
              100
            ).toFixed(2)
            : "0.00";

        totals = {
          rms: rmIds.length,
          partners: partnerIds.length,
          customers: customers.length,
        };
      }

      if (user.role === ROLES.RM) {
        // Get all ACTIVE partners under this RM
        const partners = await User.find({
          rmId: id,
          role: ROLES.PARTNER,
          status: "ACTIVE" // Only ACTIVE partners
        })
          .select("_id")
          .lean();
        let partnerIds = partners.map((x) => x._id);

        // ⚠️ CRITICAL: For SUSPENDED RM, only count ACTIVE partners who have done disbursement
        if (user.status === "SUSPENDED") {
          // Find which ACTIVE partners have actually disbursed
          const partnersWithDisbursement = await Application.distinct(
            "partnerId",
            activeApplicationsFilter({
              partnerId: { $in: partnerIds },
              status: "DISBURSED"
            })
          );

          // Only count partners who have disbursed
          partnerIds = partnersWithDisbursement;
        }

        const customers = await Application.distinct(
          "customerId",
          activeApplicationsFilter({
            partnerId: { $in: partnerIds },
          })
        );

        // For both ACTIVE and SUSPENDED RM, count disbursements from ACTIVE partners
        // For SUSPENDED RM, partnerIds already filtered to only those who have disbursed
        const disbursementFilter = { partnerId: { $in: partnerIds }, status: "DISBURSED" };

        totalDisbursed = await sumDisbursedBy(disbursementFilter);

        // Target calculation - uses the same filter to ensure consistency
        // For SUSPENDED RM, this will only count targets from active partners who have disbursed
        assignedTargetValue = await getAssignedTarget(user._id, ROLES.RM, disbursementFilter);

        performance =
          assignedTargetValue.targetValue > 0
            ? (
              (assignedTargetValue.achievedValue /
                assignedTargetValue.targetValue) *
              100
            ).toFixed(2)
            : "0.00";

        totals = { partners: partnerIds.length, customers: customers.length };
      }

      if (user.role === ROLES.PARTNER) {
        const customers = await Application.distinct(
          "customerId",
          activeApplicationsFilter({
            partnerId: user._id,
          })
        );

        totalDisbursed = await sumDisbursedBy({ partnerId: user._id });
        assignedTargetValue = await getAssignedTarget(user._id, ROLES.PARTNER, {
          partnerId: user._id,
        });

        // performance =
        //   assignedTargetValue > 0
        //     ? ((totalDisbursed / assignedTargetValue) * 100).toFixed(2)
        //     : "0.00";
        performance =
          assignedTargetValue.targetValue > 0
            ? (
              (assignedTargetValue.achievedValue /
                assignedTargetValue.targetValue) *
              100
            ).toFixed(2)
            : "0.00";

        totals = { customers: customers.length };
      }

      if (user.role === ROLES.RSM) {
        // Get all RMs under this RSM
        const rms = await User.find({
          role: ROLES.RM,
          $or: [
            { personalRsmId: id },
            { businessRsmId: id },
            { homeLapRsmId: id },
            { businessHomeRsmId: id }
          ],
          status: "ACTIVE" // Only ACTIVE RMs
        })
          .select("_id")
          .lean();
        const rmIds = rms.map((x) => x._id);

        // Get all ACTIVE partners under these RMs
        const partners = await User.find({
          rmId: { $in: rmIds },
          role: ROLES.PARTNER,
          status: "ACTIVE" // Only ACTIVE partners
        })
          .select("_id")
          .lean();
        const partnerIds = partners.map((x) => x._id);

        const customers = await Application.distinct(
          "customerId",
          activeApplicationsFilter({
            $or: [
              { rsmId: id },
              { rmId: { $in: rmIds } },
              { partnerId: { $in: partnerIds } }
            ]
          })
        );

        totalDisbursed = await sumDisbursedBy({ rsmId: id });
        assignedTargetValue = await getAssignedTarget(user._id, ROLES.RSM, { rsmId: id });

        performance =
          assignedTargetValue.targetValue > 0
            ? (
              (assignedTargetValue.achievedValue /
                assignedTargetValue.targetValue) *
              100
            ).toFixed(2)
            : "0.00";

        totals = {
          rms: rmIds.length,
          partners: partnerIds.length,
          customers: customers.length,
        };
      }

      if (user.role === ROLES.CUSTOMER) {
        totalDisbursed = await sumDisbursedBy({ customerId: user._id });
        assignedTargetValue = 0;
        performance = undefined;
        totals = {};
      }

      // Response - wrap in data object to match frontend expectations
      return res.json({
        profile: base,
        analytics: {
          scope,
          totals,
          assignedTarget: assignedTargetValue,
          totalDisbursed,
          performance:
            scope === ROLES.ASM || scope === ROLES.RSM || scope === ROLES.RM || scope === ROLES.PARTNER
              ? `${performance}%`
              : undefined,
        },
      });
    } catch (err) {
      console.error("Universal analytics error:", err);
      res.status(500).json({ message: "Failed to fetch analytics" });
    }
  }
);

// Get all delete-account requests
router.get(
  "/delete-account-requests",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (_req, res) => {
    try {
      const requests = await DeleteAccountRequest.find()
        .sort({ createdAt: -1 })
        .populate("user", "firstName lastName email phone employeeId role status");

      res.json(requests);
    } catch (err) {
      console.error("Error fetching delete account requests:", err);
      res.status(500).json({ message: "Server error while fetching requests" });
    }
  }
);

const ACTIVE_APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "DOC_INCOMPLETE",
  "DOC_COMPLETE",
  "LOGIN",
  "DOC_SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "AGREEMENT",
];

const DELETE_RETENTION_DAYS = Number(process.env.DELETE_RETENTION_DAYS || 90);

const buildSoftDeletedPhone = () => {
  const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return seed.slice(-10);
};

const evaluatePartnerHardDeleteEligibility = async (partnerId) => {
  const [
    activeApplications,
    pendingPayouts,
    pendingIncentives,
    latestApplication,
    latestPayout,
    latestIncentive,
  ] =
    await Promise.all([
      Application.countDocuments(
        activeApplicationsFilter({
          partnerId,
          status: { $in: ACTIVE_APPLICATION_STATUSES },
        })
      ),
      Payout.countDocuments({
        partnerId,
        payOutStatus: "PENDING",
      }),
      Incentive.countDocuments({
        partnerId,
        status: "PENDING",
      }),
      Application.findOne({
        partnerId,
      })
        .sort({ updatedAt: -1 })
        .select("updatedAt")
        .lean(),
      Payout.findOne({
        partnerId,
      })
        .sort({ updatedAt: -1 })
        .select("updatedAt")
        .lean(),
      Incentive.findOne({
        partnerId,
      })
        .sort({ updatedAt: -1 })
        .select("updatedAt")
        .lean(),
    ]);

  const latestActivityAt = [
    latestApplication?.updatedAt,
    latestPayout?.updatedAt,
    latestIncentive?.updatedAt,
  ]
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
  const retentionEligible = latestActivityAt
    ? Date.now() - new Date(latestActivityAt).getTime() >=
    DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000
    : true;

  const blockers = [];
  if (activeApplications > 0) blockers.push("ACTIVE_APPLICATIONS");
  if (pendingPayouts > 0) blockers.push("PENDING_PAYOUTS");
  if (pendingIncentives > 0) blockers.push("PENDING_INCENTIVES");
  if (!retentionEligible) blockers.push("RETENTION_PERIOD_NOT_COMPLETE");

  return {
    eligible: blockers.length === 0,
    blockers,
    activeApplications,
    pendingPayouts,
    pendingIncentives,
    latestActivityAt,
    retentionDays: DELETE_RETENTION_DAYS,
  };
};

// Update delete-account request status (e.g., mark as COMPLETED or REJECTED)
router.patch(
  "/delete-account-requests/:id",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body || {};

      if (!["PENDING", "COMPLETED", "REJECTED"].includes(status)) {
        return res
          .status(400)
          .json({ message: "Invalid status. Allowed: PENDING, COMPLETED, REJECTED" });
      }

      const requestDoc = await DeleteAccountRequest.findById(id);
      if (!requestDoc) {
        return res.status(404).json({ message: "Request not found" });
      }

      const previousStatus = requestDoc.status;
      let deletionOutcome = null;

      if (status === "COMPLETED") {
        const user = await User.findById(requestDoc.user);
        if (!user) {
          return res.status(404).json({ message: "User not found for this request" });
        }

        // Always do soft-delete first (deactivate account access).
        user.status = "SUSPENDED";

        if (user.role === ROLES.PARTNER) {
          const hardDeleteCheck = await evaluatePartnerHardDeleteEligibility(user._id);
          if (hardDeleteCheck.eligible) {
            const deletedTag = `deleted_${user._id}_${Date.now()}`;
            user.firstName = "Deleted";
            user.lastName = "Partner";
            user.middleName = "";
            user.email = `${deletedTag}@deleted.local`;
            user.phone = buildSoftDeletedPhone();
            user.address = "";
            user.region = "";
            user.pincode = "";
            user.landmark = "";
            user.docs = [];
            user.deletedAt = new Date();

            deletionOutcome = {
              mode: "HARD_DELETE_SCHEDULED",
              ...hardDeleteCheck,
            };
          } else {
            deletionOutcome = {
              mode: "SOFT_DELETE_ONLY",
              ...hardDeleteCheck,
            };
          }
        } else {
          // For Customers / other roles: anonymize credentials while retaining financial audit records
          const deletedTag = `deleted_cust_${user._id}_${Date.now()}`;
          user.firstName = "Deleted";
          user.lastName = "Customer";
          user.middleName = "";
          user.email = `${deletedTag}@deleted.local`;
          user.phone = buildSoftDeletedPhone();
          user.deletedAt = new Date();
          deletionOutcome = {
            mode: "SOFT_DELETE_ONLY",
            eligible: true,
            role: user.role,
          };
        }

        await user.save();
      }

      requestDoc.status = status;

      if (status !== "PENDING") {
        requestDoc.processedAt = requestDoc.processedAt || new Date();
        requestDoc.processedBy = requestDoc.processedBy || req.user.sub;
      } else {
        requestDoc.processedAt = undefined;
        requestDoc.processedBy = undefined;
      }

      if (deletionOutcome) {
        requestDoc.meta = {
          ...(requestDoc.meta || {}),
          deletionOutcome,
          updatedByAdminAt: new Date(),
        };
      }

      await requestDoc.save();

      // On first transition to COMPLETED, send confirmation email to user
      if (previousStatus !== "COMPLETED" && status === "COMPLETED") {
        setImmediate(async () => {
          try {
            const user = await User.findById(requestDoc.user).lean();
            if (user && user.email) {
              await sendDeleteAccountConfirmationEmail(user);
            }
          } catch (err) {
            console.error(
              "Failed to send delete account confirmation email:",
              err.message
            );
          }
        });
      }

      // On first transition to REJECTED, email + in-app notification to partner
      if (previousStatus !== "REJECTED" && status === "REJECTED") {
        const rejectUserId = requestDoc.user?.toString?.() || String(requestDoc.user);
        setImmediate(async () => {
          try {
            const user = await User.findById(requestDoc.user).lean();
            if (user?.email && !String(user.email).endsWith("@deleted.local")) {
              await sendDeleteAccountRejectionEmail(user);
            }
          } catch (err) {
            console.error(
              "Failed to send delete account rejection email:",
              err.message
            );
          }
        });
        setImmediate(async () => {
          try {
            await createNotification(rejectUserId, {
              type: "warning",
              title: "Delete account request not approved",
              message:
                "Your request to delete your partner account was reviewed and not approved. Your account stays active. Contact support if you need help.",
              data: {
                deleteAccountRequestId: requestDoc._id.toString(),
                status: "REJECTED",
              },
              notificationId: generateNotificationId({
                type: "delete_account_rejected",
                userId: rejectUserId,
                timestamp: Date.now(),
              }),
            });
          } catch (err) {
            console.error(
              "Failed to create delete account rejection notification:",
              err.message
            );
          }
        });
      }

      const populated = await requestDoc.populate(
        "user",
        "firstName lastName email phone employeeId role status"
      );

      res.json({
        message: "Delete account request updated successfully",
        request: populated,
        deletionOutcome,
      });
    } catch (err) {
      console.error("Error updating delete account request:", err);
      res.status(500).json({
        message: "Server error while updating delete account request",
        error: err.message,
      });
    }
  }
);

// Helper to broadcast banner updates across mobile and web apps immediately
const broadcastBannersUpdated = async (req) => {
  try {
    if (!global.io) return;
    const banners = await Banner.find().sort({ createdAt: -1 }).lean();
    const host = req ? `${req.protocol}://${req.get("host")}` : (process.env.BACKEND_URL || "http://localhost:5000");

    const bannersWithUrl = banners.map((b) => {
      let imgUrl = (b.imageUrl || "").replace(/\\/g, "/");
      if (/^https?:\/\//i.test(imgUrl)) {
        return {
          _id: b._id,
          title: b.title,
          description: b.description,
          imageUrl: imgUrl,
        };
      }
      if (!imgUrl.startsWith("/uploads")) {
        imgUrl = "/" + imgUrl;
      }
      return {
        _id: b._id,
        title: b.title,
        description: b.description,
        imageUrl: `${host}${imgUrl}`,
      };
    });

    global.io.emit("bannersUpdated", { banners: bannersWithUrl, timestamp: Date.now() });
    global.io.emit("dashboardUpdate", { type: "banners" });
  } catch (err) {
    console.warn("Notice: Failed to broadcast bannersUpdated:", err?.message);
  }
};

// Upload banners (single or multiple up to 10)
router.post(
  "/banners",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  bannerUpload.array("banners", 20),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0)
        return res.status(400).json({ message: "No files uploaded" });

      const banners = await Promise.all(
        req.files.map((file) => {
          if (!file.location) {
            throw new Error("S3 upload failed: missing file location");
          }
          return Banner.create({
            imageUrl: file.location,
            title: req.body.title,
            description: req.body.description,
            uploadedBy: req.user.sub,
          });
        })
      );

      // Instantly sync mobile and web apps
      await broadcastBannersUpdated(req);

      res
        .status(201)
        .json({ message: "Banners uploaded successfully", banners });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// router.get("/banners", auth, async (req, res) => {
//   try {
//     const banners = await Banner.find().sort({ createdAt: -1 });

//     // Build base host (http://localhost:5000 or https://yourdomain.com)
//     const host = `${req.protocol}://${req.get("host")}`;

//     const bannersWithUrl = banners.map((b) => {
//       // Ensure stored path always starts with /uploads
//       let imgPath = b.imageUrl.replace(/\\/g, "/");
//       if (!imgPath.startsWith("/uploads")) {
//         imgPath = "/" + imgPath;
//       }

//       return {
//         _id: b._id,
//         title: b.title,
//         description: b.description,
//         imageUrl: `${host}${imgPath}`, // absolute URL
//       };
//     });

//     res.json({ banners: bannersWithUrl });
//   } catch (err) {
//     console.error("Banner fetch error:", err);
//     res.status(500).json({ message: "Internal server error" });
//   }
// });

router.get("/banners", auth, async (req, res) => {
  try {
    const banners = await Banner.find().sort({ createdAt: -1 });

    // Build base host (http://localhost:5000 or https://yourdomain.com)
    const host = `${req.protocol}://${req.get("host")}`;

    const bannersWithUrl = banners.map((b) => {
      let imgUrl = b.imageUrl.replace(/\\/g, "/");

      // ✅ If it's already a full URL, keep it
      if (/^https?:\/\//i.test(imgUrl)) {
        return {
          _id: b._id,
          title: b.title,
          description: b.description,
          imageUrl: imgUrl,
        };
      }

      // ✅ Otherwise prepend backend host
      if (!imgUrl.startsWith("/uploads")) {
        imgUrl = "/" + imgUrl;
      }

      return {
        _id: b._id,
        title: b.title,
        description: b.description,
        imageUrl: `${host}${imgUrl}`,
      };
    });

    res.json({ banners: bannersWithUrl });
  } catch (err) {
    console.error("Banner fetch error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


router.delete(
  "/banners/:id",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const bannerId = new mongoose.Types.ObjectId(req.params.id); // ✅ Cast to ObjectId
      const banner = await Banner.findById(bannerId);
      if (!banner) {
        return res.status(404).json({ message: "Banner not found" });
      } // Delete image from disk if exists
      if (banner.imageUrl && fs.existsSync(banner.imageUrl)) {
        fs.unlinkSync(banner.imageUrl);
      }
      await banner.deleteOne();
      // Instantly sync mobile and web apps
      await broadcastBannersUpdated(req);
      res.json({ message: "Banner deleted successfully" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// UPDATE banner title/description
router.patch(
  "/banners/:id",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { title, description } = req.body;
      const banner = await Banner.findById(req.params.id);
      if (!banner) return res.status(404).json({ message: "Banner not found" });

      if (title !== undefined) banner.title = title;
      if (description !== undefined) banner.description = description;

      await banner.save();
      // Instantly sync mobile and web apps
      await broadcastBannersUpdated(req);
      res.json({ message: "Banner updated successfully", banner });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

/**
 * Test Email Endpoint - Get endpoint info
 * GET /admin/test-email
 */
router.get("/test-email", (req, res) => {
  res.json({
    message: "Email Test Endpoint",
    description: "Use POST method to test email functionality",
    endpoint: "POST /api/admin/test-email",
    requiredAuth: true,
    requiredRole: ["SUPER_ADMIN", "ADMIN"],
    requestBody: {
      email: "your-test-email@example.com",
      type: "basic|user|loan|status|document|all (default: all)",
    },
    availableTypes: {
      basic: "Test basic sendMail function",
      user: "Test user account creation email",
      loan: "Test loan application email",
      status: "Test application status update email",
      document: "Test document status email",
      all: "Test all email types (default)",
    },
    example: {
      method: "POST",
      url: "/api/admin/test-email",
      headers: {
        Authorization: "Bearer YOUR_ADMIN_TOKEN",
        "Content-Type": "application/json",
      },
      body: {
        email: "test@example.com",
        type: "all",
      },
    },
  });
});

/**
 * Test Email Endpoint - Test all email types
 * POST /admin/test-email
 * Body: { email: "test@example.com", type: "basic|user|loan|status|document" }
 */
router.post(
  "/test-email",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  async (req, res) => {
    try {
      const { email, type = "basic" } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: "Email address is required"
        });
      }

      // Validate email format
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({
          success: false,
          message: "Invalid email format"
        });
      }

      let result = {};

      switch (type) {
        case "basic":
          // Test basic sendMail function
          try {
            await sendMail({
              to: email,
              subject: "🧪 Test Email - Basic SendMail",
              html: `
                <h2>Email Test - Basic SendMail</h2>
                <p>This is a test email to verify basic email sending functionality.</p>
                <p><b>Test Time:</b> ${new Date().toLocaleString()}</p>
                <p><b>Status:</b> ✅ Email service is working!</p>
                <br/>
                <p>If you received this email, your email configuration is correct.</p>
              `,
            });
            result.basic = { success: true, message: "Basic email sent successfully" };
          } catch (error) {
            result.basic = { success: false, message: error.message };
          }
          break;

        case "user":
          // Test user account email
          try {
            const testUser = {
              firstName: "Test",
              lastName: "User",
              email: email,
              employeeId: "TEST001",
              rmCode: "RM-TEST",
            };
            const emailSent = await sendUserAccountEmail(testUser, "RM", "Test@123", {
              firstName: "Admin",
              lastName: "User",
            });
            result.user = {
              success: emailSent,
              message: emailSent
                ? "User account email sent successfully"
                : "Failed to send user account email"
            };
          } catch (error) {
            result.user = { success: false, message: error.message };
          }
          break;

        case "loan":
          // Test loan application email
          try {
            const testCustomer = {
              firstName: "Test",
              email: email,
            };
            const testApplication = {
              appNo: "APP-TEST-001",
              loanType: "HOME_LOAN_SALARIED",
              status: "DRAFT",
              appliedLoanAmount: 500000,
              loanAmount: 500000,
            };
            const emailSent = await sendLoanApplicationEmail(
              testCustomer,
              testApplication,
              "Test@123"
            );
            result.loan = {
              success: emailSent,
              message: emailSent
                ? "Loan application email sent successfully"
                : "Failed to send loan application email"
            };
          } catch (error) {
            result.loan = { success: false, message: error.message };
          }
          break;

        case "status":
          // Test application status email
          try {
            const testCustomer = {
              firstName: "Test",
              email: email,
            };
            const testApplication = {
              appNo: "APP-TEST-001",
              loanType: "HOME_LOAN_SALARIED",
              status: "APPROVED",
              approvedLoanAmount: 500000,
            };
            const emailSent = await sendApplicationStatusEmail(
              testCustomer,
              testApplication,
              "DRAFT",
              "APPROVED"
            );
            result.status = {
              success: emailSent,
              message: emailSent
                ? "Application status email sent successfully"
                : "Failed to send application status email"
            };
          } catch (error) {
            result.status = { success: false, message: error.message };
          }
          break;

        case "document":
          // Test document status email
          try {
            const testCustomer = {
              firstName: "Test",
              email: email,
            };
            const testApplication = {
              appNo: "APP-TEST-001",
              loanType: "HOME_LOAN_SALARIED",
            };
            const emailSent = await sendDocumentStatusEmail(
              testCustomer,
              testApplication,
              "AADHAR_FRONT",
              "VERIFIED"
            );
            result.document = {
              success: emailSent,
              message: emailSent
                ? "Document status email sent successfully"
                : "Failed to send document status email"
            };
          } catch (error) {
            result.document = { success: false, message: error.message };
          }
          break;

        case "all":
          // Test all email types
          const tests = ["basic", "user", "loan", "status", "document"];
          for (const testType of tests) {
            req.body.type = testType;
            // Recursively call for each type (simplified approach)
            try {
              if (testType === "basic") {
                await sendMail({
                  to: email,
                  subject: `🧪 Test Email - ${testType}`,
                  html: `<h2>Test: ${testType}</h2><p>This is a test email.</p>`,
                });
                result[testType] = { success: true, message: `${testType} email sent` };
              } else if (testType === "user") {
                const emailSent = await sendUserAccountEmail(
                  { firstName: "Test", lastName: "User", email, employeeId: "TEST001" },
                  "RM",
                  "Test@123"
                );
                result[testType] = { success: emailSent, message: `${testType} email ${emailSent ? 'sent' : 'failed'}` };
              } else if (testType === "loan") {
                const emailSent = await sendLoanApplicationEmail(
                  { firstName: "Test", email },
                  { appNo: "TEST-001", loanType: "HOME_LOAN_SALARIED", status: "DRAFT", appliedLoanAmount: 500000 },
                  "Test@123"
                );
                result[testType] = { success: emailSent, message: `${testType} email ${emailSent ? 'sent' : 'failed'}` };
              } else if (testType === "status") {
                const emailSent = await sendApplicationStatusEmail(
                  { firstName: "Test", email },
                  { appNo: "TEST-001", loanType: "HOME_LOAN_SALARIED", status: "APPROVED" },
                  "DRAFT",
                  "APPROVED"
                );
                result[testType] = { success: emailSent, message: `${testType} email ${emailSent ? 'sent' : 'failed'}` };
              } else if (testType === "document") {
                const emailSent = await sendDocumentStatusEmail(
                  { firstName: "Test", email },
                  { appNo: "TEST-001", loanType: "HOME_LOAN_SALARIED" },
                  "AADHAR_FRONT",
                  "VERIFIED"
                );
                result[testType] = { success: emailSent, message: `${testType} email ${emailSent ? 'sent' : 'failed'}` };
              }
            } catch (error) {
              result[testType] = { success: false, message: error.message };
            }
          }
          break;

        default:
          return res.status(400).json({
            success: false,
            message: `Invalid email type. Use: basic, user, loan, status, document, or all`,
          });
      }

      const allSuccess = Object.values(result).every((r) => r.success);

      res.json({
        success: allSuccess,
        message: allSuccess
          ? `Email test completed successfully`
          : `Some email tests failed`,
        results: result,
        testedEmail: email,
        testType: type,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Email test error:", error);
      res.status(500).json({
        success: false,
        message: "Email test failed",
        error: error.message,
      });
    }
  }
);

// ==================== PAYOUT MANAGEMENT - PENDING/DONE (ADMIN) ====================

// Helper to format payout application record for admin/ASM tables
function formatPayoutApplicationRow(app, payout, isDoneEndpoint = false) {
  const custFirst = (app.customerId?.firstName || app.customer?.firstName || "").trim();
  const custLast = (app.customerId?.lastName || app.customer?.lastName || "").trim();
  const customerName = `${custFirst} ${custLast}`.trim() || app.customer?.name || "Customer";
  const contact = app.customerId?.phone || app.customer?.phone || null;
  const email = app.customerId?.email || app.customer?.email || null;
  const customerEmployeeId = app.customerId?.employeeId || null;

  const partnerFirst = (app.partnerId?.firstName || "").trim();
  const partnerLast = (app.partnerId?.lastName || "").trim();
  const partnerName = `${partnerFirst} ${partnerLast}`.trim() || "Partner";
  const partnerEmployeeId = app.partnerId?.employeeId || app.partnerId?.partnerCode || null;
  const partnerPhone = app.partnerId?.phone || null;
  const partnerEmail = app.partnerId?.email || null;
  const partnerPan = app.partnerId?.panNumber || app.partnerId?.panCard || "";
  const partnerCode = app.partnerId?.partnerCode || partnerEmployeeId || "";
  const partnerBankName = app.partnerId?.bankName || "";
  const partnerAccountNumber = app.partnerId?.accountNumber || "";
  const partnerIfscCode = app.partnerId?.ifscCode || "";
  const partnerAccountHolderName =
    app.partnerId?.accountHolderName || partnerName;

  const disbursedAt = getDisbursedAt(app);
  const payoutAmount = payout?.amount != null ? Number(payout.amount) : 0;
  const approvedAmount = app.approvedLoanAmount != null ? Number(app.approvedLoanAmount) : null;

  // Financial & TDS Section 194T breakdown
  // Treat schema default 0 on gross/net/tds as "missing" when amount was actually paid
  const rawGross = payout?.grossAmount != null ? Number(payout.grossAmount) : null;
  const grossAmount = rawGross != null && rawGross > 0 ? rawGross : payoutAmount;
  const tdsApplicable = payout?.tdsApplicable !== undefined ? Boolean(payout.tdsApplicable) : true;
  const tdsSection = payout?.tdsSection || "194T";
  const tdsPercentage = payout?.tdsPercentage != null ? Number(payout.tdsPercentage) : 10;
  const rawTds = payout?.tdsAmount != null ? Number(payout.tdsAmount) : null;
  const tdsAmount =
    rawTds != null && rawTds > 0
      ? rawTds
      : tdsApplicable && grossAmount > 0
      ? Number(((grossAmount * tdsPercentage) / 100).toFixed(2))
      : 0;
  const rawNet = payout?.netAmount != null ? Number(payout.netAmount) : null;
  const netAmount =
    rawNet != null && rawNet > 0
      ? rawNet
      : payoutAmount > 0
      ? payoutAmount
      : Number(Math.max(0, grossAmount - tdsAmount).toFixed(2));

  const payoutPercentage =
    payout?.payoutPercentage != null
      ? Number(payout.payoutPercentage)
      : grossAmount > 0 && approvedAmount && approvedAmount > 0
      ? Number(((grossAmount / approvedAmount) * 100).toFixed(2))
      : null;

  return {
    applicationId: app._id,
    appNo: app.appNo || (app._id ? `TLF${app._id.toString().slice(-4).toUpperCase()}` : ""),
    customerId: app.customerId?._id || app.customer?._id || app._id,
    customerEmployeeId,
    customerName,
    contact,
    email,
    loanType: app.loanType,
    requestedAmount: app.customer?.loanAmount || app.requestedAmount || null,
    approvedAmount,
    status: app.status,
    payOutStatus: payout?.payOutStatus || (isDoneEndpoint ? "DONE" : "PENDING"),
    payoutAmount: netAmount || payoutAmount,
    payoutPercentage,
    grossAmount,
    tdsApplicable,
    tdsSection,
    tdsPercentage,
    tdsAmount,
    netAmount,
    invoiceNumber: payout?.invoiceNumber || "",
    invoiceDate: payout?.invoiceDate || null,
    invoiceSentAt: payout?.invoiceSentAt || null,
    invoiceSentTo: payout?.invoiceSentTo || partnerEmail || "",
    invoiceNotes: payout?.invoiceNotes || "",
    payoutNote: payout?.note || "",
    payoutId: payout?._id || null,
    partnerId: app.partnerId?._id || null,
    partnerName,
    partnerPhone,
    partnerEmail,
    partnerPan,
    partnerCode,
    partnerEmployeeId,
    partnerBankName,
    partnerAccountNumber,
    partnerIfscCode,
    partnerAccountHolderName,
    partner: {
      partnerId: app.partnerId?._id,
      employeeId: partnerEmployeeId,
      partnerCode,
      panNumber: partnerPan,
      name: partnerName,
      firstName: partnerFirst,
      lastName: partnerLast,
      email: partnerEmail,
      phone: partnerPhone,
      bankName: partnerBankName,
      accountNumber: partnerAccountNumber,
      ifscCode: partnerIfscCode,
      accountHolderName: partnerAccountHolderName,
    },
    createdAt: app.createdAt,
    disbursedAt,
    updatedAt: disbursedAt || app.updatedAt,
  };
}

// GET /api/admin/customers/pending-payouts
// Admin gets pending payout customers (disbursed loans without DONE payout)
router.get("/customers/pending-payouts", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const applications = await Application.find(
      activeApplicationsFilter({ status: "DISBURSED" })
    )
      .populate("customerId", "employeeId firstName lastName email phone")
      .populate(
        "partnerId",
        "employeeId firstName lastName email phone bankName accountNumber ifscCode accountHolderName panNumber partnerCode panCard"
      )
      .lean();

    const appIds = applications.map((app) => app._id);
    const payouts = await Payout.find({ application: { $in: appIds } })
      .select("application amount grossAmount payoutPercentage tdsApplicable tdsSection tdsPercentage tdsAmount netAmount invoiceNumber invoiceDate invoiceSentAt invoiceSentTo invoiceNotes payOutStatus note")
      .lean();

    const doneAppIds = new Set(
      payouts
        .filter((p) => p.payOutStatus === "DONE")
        .map((p) => p.application.toString())
    );

    const disbursedApps = applications.filter(
      (app) => !doneAppIds.has(app._id.toString())
    );

    const customers = disbursedApps.map((app) => {
      const payout = payouts.find(
        (p) => p.application?.toString() === app._id.toString()
      );
      return formatPayoutApplicationRow(app, payout, false);
    });

    return res.json(customers);
  } catch (err) {
    console.error("Error fetching pending payout customers:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

// GET /api/admin/customers/done-payouts
// Admin gets done payout customers
router.get("/customers/done-payouts", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const applications = await Application.find(activeApplicationsFilter())
      .populate("customerId", "employeeId firstName lastName email phone")
      .populate(
        "partnerId",
        "employeeId firstName lastName email phone bankName accountNumber ifscCode accountHolderName panNumber partnerCode panCard"
      )
      .lean();

    const appIds = applications.map((app) => app._id);

    const donePayouts = await Payout.find({
      application: { $in: appIds },
      payOutStatus: "DONE",
    })
      .select("application amount grossAmount payoutPercentage tdsApplicable tdsSection tdsPercentage tdsAmount netAmount invoiceNumber invoiceDate invoiceSentAt invoiceSentTo invoiceNotes payOutStatus note")
      .lean();

    const doneMap = {};
    donePayouts.forEach((p) => {
      doneMap[p.application?.toString()] = p;
    });

    const customers = applications
      .filter((app) => doneMap[app._id.toString()])
      .map((app) => {
        const payout = doneMap[app._id.toString()];
        return formatPayoutApplicationRow(app, payout, true);
      });

    return res.json(customers);
  } catch (err) {
    console.error("Error fetching done payout customers:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

// GET /api/admin/application/:applicationId/payout-detail
// Admin gets comprehensive application, customer, partner, bank and payout details by applicationId
router.get("/application/:applicationId/payout-detail", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { applicationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(applicationId)) {
      return res.status(400).json({ message: "Invalid application ID" });
    }

    const app = await Application.findById(applicationId)
      .populate("customerId", "employeeId firstName lastName email phone")
      .populate(
        "partnerId",
        "employeeId firstName lastName email phone bankName accountNumber ifscCode accountHolderName panNumber partnerCode panCard"
      )
      .lean();

    if (!app) {
      return res.status(404).json({ message: "Application not found" });
    }

    const payout = await Payout.findOne({ application: applicationId }).lean();
    const formatted = formatPayoutApplicationRow(app, payout);

    return res.json({
      success: true,
      application: formatted,
      partner: formatted.partner,
      payout: payout || null,
    });
  } catch (err) {
    console.error("Error fetching application payout details:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

// GET /api/admin/customer/:customerId/partners-payout
// Admin gets partner details for a customer's applications with payout info
router.get("/customer/:customerId/partners-payout", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { customerId } = req.params;

    // Find all applications for this customer (or match by applicationId if passed)
    let applications = [];
    if (mongoose.Types.ObjectId.isValid(customerId)) {
      applications = await Application.find({
        $or: [{ customerId }, { _id: customerId }],
      })
        .select("_id partnerId customerId appNo approvedLoanAmount loanType status")
        .populate(
          "partnerId",
          "employeeId firstName lastName email phone bankName accountNumber ifscCode accountHolderName"
        )
        .lean();
    }

    if (!applications.length) {
      return res
        .status(404)
        .json({ message: "No applications found for this customer" });
    }

    // Fetch payouts for these applications
    const appIds = applications.map((app) => app._id);
    const payouts = await Payout.find({ application: { $in: appIds } })
      .select("application partnerId amount payOutStatus note")
      .lean();

    const partnerDetails = applications
      .filter((app) => app.partnerId)
      .map((app) => {
        const partner = app.partnerId;
        const payout = payouts.find(
          (p) => p.application?.toString() === app._id.toString()
        );

        return {
          _id: partner._id,
          partnerId: partner._id,
          employeeId: partner.employeeId || null,
          firstName: partner.firstName || "",
          lastName: partner.lastName || "",
          email: partner.email || "",
          phone: partner.phone || "",
          bankName: partner.bankName || "",
          ifscCode: partner.ifscCode || "",
          accountNumber: partner.accountNumber || "",
          accountHolderName:
            partner.accountHolderName ||
            `${partner.firstName || ""} ${partner.lastName || ""}`.trim(),
          applicationId: app._id,
          approvedLoanAmount: app.approvedLoanAmount || 0,
          payoutAmount: payout?.amount || 0,
          payoutStatus: payout?.payOutStatus || "PENDING",
          payoutNote: payout?.note || "",
        };
      });

    res.json({ partners: partnerDetails });
  } catch (err) {
    console.error("Error fetching partners for customer with payout:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

// POST /api/admin/set-payouts
// Admin creates/updates payout for disbursed application
router.post("/set-payouts", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const {
      applicationId,
      partnerId: inputPartnerId,
      payoutPercentage,
      payoutAmount: directPayoutAmount,
      grossAmount: inputGrossAmount,
      tdsApplicable: inputTdsApplicable,
      tdsSection: inputTdsSection,
      tdsPercentage: inputTdsPercentage,
      tdsAmount: inputTdsAmount,
      netAmount: inputNetAmount,
      invoiceNumber: inputInvoiceNumber,
      invoiceDate: inputInvoiceDate,
      invoiceNotes: inputInvoiceNotes,
      sendInvoiceEmail: inputSendInvoiceEmail,
      note,
      payOutStatus,
    } = req.body;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(applicationId)) {
      return res.status(400).json({ message: "Invalid application ID" });
    }

    // Fetch application (Admin can access all)
    const application = await Application.findOne({
      _id: applicationId,
    }).select("approvedLoanAmount partnerId status appNo loanType customer");

    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const partnerId = inputPartnerId || application.partnerId?.toString();

    if (!partnerId) {
      return res
        .status(400)
        .json({ message: "No partner associated with this application" });
    }

    // Ensure partner matches if passed
    if (application.partnerId && application.partnerId.toString() !== partnerId) {
      return res
        .status(400)
        .json({ message: "Application does not belong to this partner" });
    }

    // Load TDS & invoice system defaults
    const policy = await getInvoiceAndTdsPolicy();
    const approved = Number(application.approvedLoanAmount || 0);

    // Compute TDS under Section 194T and Net Amount
    const isTds = inputTdsApplicable !== undefined ? Boolean(inputTdsApplicable) : (policy.tdsApplicable ?? true);
    const selectedTdsSection = inputTdsSection || policy.tdsSection || DEFAULT_TDS_SECTION;
    const selectedTdsRate = inputTdsPercentage != null ? Number(inputTdsPercentage) : (policy.tdsPercentage ?? DEFAULT_TDS_PERCENTAGE);

    const calc = calculateTdsAndNet({
      approvedAmount: approved,
      payoutPercentage,
      grossAmount: inputGrossAmount ?? directPayoutAmount,
      directAmount: directPayoutAmount,
      tdsApplicable: isTds,
      tdsSection: selectedTdsSection,
      tdsPercentage: selectedTdsRate,
    });

    const finalGross = inputGrossAmount != null ? Number(inputGrossAmount) : calc.grossAmount;
    const finalTdsAmt = inputTdsAmount != null ? Number(inputTdsAmount) : calc.tdsAmount;
    const finalNetAmt = inputNetAmount != null ? Number(inputNetAmount) : (calc.netAmount || finalGross);
    const finalPct = payoutPercentage != null ? Number(payoutPercentage) : calc.payoutPercentage;

    const appNo = application.appNo || (application._id ? `TLF${application._id.toString().slice(-4).toUpperCase()}` : "APP");

    // Check if payout already exists
    let payout = await Payout.findOne({
      application: applicationId,
      partnerId,
    });

    const previousStatus = payout ? payout.payOutStatus : null;
    const invoiceNum = inputInvoiceNumber || payout?.invoiceNumber || generateInvoiceNumber(appNo, payout?._id || application._id);
    const invoiceDt = inputInvoiceDate ? new Date(inputInvoiceDate) : (payout?.invoiceDate || new Date());
    const invoiceNt = inputInvoiceNotes !== undefined ? inputInvoiceNotes : (payout?.invoiceNotes || policy.invoiceNotes || "");

    if (payout) {
      // Update existing payout
      payout.amount = finalNetAmt;
      payout.grossAmount = finalGross;
      payout.payoutPercentage = finalPct;
      payout.tdsApplicable = isTds;
      payout.tdsSection = selectedTdsSection;
      payout.tdsPercentage = selectedTdsRate;
      payout.tdsAmount = finalTdsAmt;
      payout.netAmount = finalNetAmt;
      payout.invoiceNumber = invoiceNum;
      payout.invoiceDate = invoiceDt;
      payout.invoiceNotes = invoiceNt;
      if (note !== undefined) {
        payout.note = note;
      }
      if (payOutStatus && ["PENDING", "DONE", "REJECTED"].includes(payOutStatus)) {
        payout.payOutStatus = payOutStatus;
      }
      await payout.save();
    } else {
      // Create new payout
      payout = await Payout.create({
        application: applicationId,
        partnerId,
        amount: finalNetAmt,
        grossAmount: finalGross,
        payoutPercentage: finalPct,
        tdsApplicable: isTds,
        tdsSection: selectedTdsSection,
        tdsPercentage: selectedTdsRate,
        tdsAmount: finalTdsAmt,
        netAmount: finalNetAmt,
        invoiceNumber: invoiceNum,
        invoiceDate: invoiceDt,
        invoiceNotes: invoiceNt,
        note: note || "",
        payOutStatus:
          payOutStatus && ["PENDING", "DONE", "REJECTED"].includes(payOutStatus)
            ? payOutStatus
            : "PENDING",
        addedBy: req.user.sub, // Admin user
      });
    }

    // 🔔 If status changed to DONE → emit socket + send formal invoice email to partner with Section 194T details
    try {
      const isMarkedDone = payout && payout.payOutStatus === "DONE" && (previousStatus !== "DONE" || inputSendInvoiceEmail === true);
      if (isMarkedDone) {
        const io = global.io;
        if (io) {
          await emitPayoutStatusChanged(io, payout._id, "DONE", payout.partnerId, payout.amount);
        }

        // Fetch application and partner bank details for the invoice email
        const [fullApp, partner] = await Promise.all([
          Application.findById(payout.application)
            .populate("customerId", "firstName lastName name phone email")
            .lean(),
          User.findById(payout.partnerId)
            .select("firstName lastName email phone bankName accountNumber ifscCode accountHolderName employeeId partnerCode panNumber panCard")
            .lean(),
        ]);

        if (partner && partner.email && inputSendInvoiceEmail !== false) {
          const custFirst = (fullApp?.customerId?.firstName || fullApp?.customer?.firstName || "").trim();
          const custLast = (fullApp?.customerId?.lastName || fullApp?.customer?.lastName || "").trim();
          const customerName = `${custFirst} ${custLast}`.trim() || fullApp?.customer?.name || "Customer";
          const approvedAmount = Number(fullApp?.approvedLoanAmount || fullApp?.customer?.loanAmount || 0);

          const emailResult = await sendPartnerPayoutInvoiceEmail({
            partner,
            customerName,
            appNo,
            loanType: fullApp?.loanType || "Personal Loan",
            approvedAmount,
            grossAmount: payout.grossAmount,
            payoutAmount: payout.amount,
            payoutPercentage: payout.payoutPercentage || finalPct,
            tdsApplicable: payout.tdsApplicable,
            tdsSection: payout.tdsSection,
            tdsPercentage: payout.tdsPercentage,
            tdsAmount: payout.tdsAmount,
            netAmount: payout.netAmount || payout.amount,
            invoiceNumber: payout.invoiceNumber,
            invoiceDate: payout.invoiceDate,
            utrNumber: note || payout.note || "",
            note: note || payout.note || "",
            bankName: partner.bankName || "",
            accountNumber: partner.accountNumber || "",
            ifscCode: partner.ifscCode || "",
            companyDetails: policy.companyDetails,
            invoiceNotes: payout.invoiceNotes,
          });

          if (emailResult) {
            payout.invoiceSentAt = new Date();
            payout.invoiceSentTo = partner.email;
            await payout.save();
          }
        }
      }
    } catch (notifyErr) {
      console.error("❌ Error sending payout invoice notification/email:", notifyErr);
    }

    return res.status(200).json({
      message: "Payout saved successfully",
      payout,
    });
  } catch (err) {
    console.error("Error setting payout:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

// POST /api/admin/payouts/:payoutId/send-invoice
// Admin sends or resends formal Section 194T commission invoice email to partner
router.post("/payouts/:payoutId/send-invoice", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { payoutId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(payoutId)) {
      return res.status(400).json({ message: "Invalid payout ID" });
    }

    const payout = await Payout.findById(payoutId);
    if (!payout) {
      return res.status(404).json({ message: "Payout not found" });
    }

    const [fullApp, partner, policy] = await Promise.all([
      Application.findById(payout.application)
        .populate("customerId", "firstName lastName name phone email")
        .lean(),
      User.findById(payout.partnerId)
        .select("firstName lastName email phone bankName accountNumber ifscCode accountHolderName employeeId partnerCode panNumber panCard")
        .lean(),
      getInvoiceAndTdsPolicy(),
    ]);

    if (!partner || !partner.email) {
      return res.status(400).json({ message: "Partner has no registered email address" });
    }

    const custFirst = (fullApp?.customerId?.firstName || fullApp?.customer?.firstName || "").trim();
    const custLast = (fullApp?.customerId?.lastName || fullApp?.customer?.lastName || "").trim();
    const customerName = `${custFirst} ${custLast}`.trim() || fullApp?.customer?.name || "Customer";
    const appNo = fullApp?.appNo || (fullApp?._id ? `TLF${fullApp._id.toString().slice(-4).toUpperCase()}` : "APP");
    const approvedAmount = Number(fullApp?.approvedLoanAmount || fullApp?.customer?.loanAmount || 0);

    const paidAmount = Number(payout.amount || 0);
    const rawGross = payout.grossAmount != null ? Number(payout.grossAmount) : null;
    const grossAmount = rawGross != null && rawGross > 0 ? rawGross : paidAmount;
    const rawNet = payout.netAmount != null ? Number(payout.netAmount) : null;
    const netAmount = rawNet != null && rawNet > 0 ? rawNet : paidAmount;
    const tdsApplicable = payout.tdsApplicable !== undefined ? payout.tdsApplicable : true;
    const tdsSection = payout.tdsSection || policy.tdsSection || DEFAULT_TDS_SECTION;
    const tdsPercentage = payout.tdsPercentage != null ? payout.tdsPercentage : (policy.tdsPercentage ?? DEFAULT_TDS_PERCENTAGE);
    const rawTds = payout.tdsAmount != null ? Number(payout.tdsAmount) : null;
    const tdsAmount =
      rawTds != null && rawTds > 0
        ? rawTds
        : tdsApplicable && grossAmount > 0
        ? Number(((grossAmount * tdsPercentage) / 100).toFixed(2))
        : 0;
    const invoiceNumber = payout.invoiceNumber || generateInvoiceNumber(appNo, payout._id);

    const emailResult = await sendPartnerPayoutInvoiceEmail({
      partner,
      customerName,
      appNo,
      loanType: fullApp?.loanType || "Personal Loan",
      approvedAmount,
      grossAmount,
      payoutAmount: netAmount,
      payoutPercentage: payout.payoutPercentage || (approvedAmount > 0 ? Number(((grossAmount / approvedAmount) * 100).toFixed(2)) : 0),
      tdsApplicable,
      tdsSection,
      tdsPercentage,
      tdsAmount,
      netAmount,
      invoiceNumber,
      invoiceDate: payout.invoiceDate || new Date(),
      utrNumber: payout.note || "",
      note: payout.note || "",
      bankName: partner.bankName || "",
      accountNumber: partner.accountNumber || "",
      ifscCode: partner.ifscCode || "",
      companyDetails: policy.companyDetails,
      invoiceNotes: payout.invoiceNotes || policy.invoiceNotes,
    });

    if (emailResult) {
      payout.invoiceSentAt = new Date();
      payout.invoiceSentTo = partner.email;
      if (!payout.invoiceNumber) payout.invoiceNumber = invoiceNumber;
      await payout.save();
      return res.json({
        success: true,
        message: `Invoice email successfully sent to ${partner.email}`,
        invoiceSentAt: payout.invoiceSentAt,
      });
    } else {
      return res.status(500).json({ message: "Failed to send invoice email via mail server" });
    }
  } catch (err) {
    console.error("Error sending payout invoice email:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// PUT /api/admin/payouts/:payoutId/invoice
// Admin edits invoice number / date / notes / TDS amounts (without re-settling status)
router.put("/payouts/:payoutId/invoice", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { payoutId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(payoutId)) {
      return res.status(400).json({ message: "Invalid payout ID" });
    }

    const payout = await Payout.findById(payoutId);
    if (!payout) {
      return res.status(404).json({ message: "Payout not found" });
    }

    const {
      invoiceNumber,
      invoiceDate,
      invoiceNotes,
      grossAmount,
      tdsApplicable,
      tdsSection,
      tdsPercentage,
      tdsAmount,
      netAmount,
      note,
      utrNumber,
    } = req.body;

    if (invoiceNumber !== undefined) payout.invoiceNumber = String(invoiceNumber || "").trim();
    if (invoiceDate !== undefined) {
      payout.invoiceDate = invoiceDate ? new Date(invoiceDate) : payout.invoiceDate;
    }
    if (invoiceNotes !== undefined) payout.invoiceNotes = invoiceNotes;
    if (grossAmount != null && Number(grossAmount) >= 0) payout.grossAmount = Number(grossAmount);
    if (tdsApplicable !== undefined) payout.tdsApplicable = Boolean(tdsApplicable);
    if (tdsSection !== undefined) payout.tdsSection = tdsSection || "194T";
    if (tdsPercentage != null) payout.tdsPercentage = Number(tdsPercentage);
    if (tdsAmount != null) payout.tdsAmount = Number(tdsAmount);
    if (netAmount != null && Number(netAmount) >= 0) {
      payout.netAmount = Number(netAmount);
      payout.amount = Number(netAmount);
    }
    if (utrNumber !== undefined || note !== undefined) {
      payout.note = utrNumber || note || payout.note || "";
    }

    await payout.save();

    return res.json({
      message: "Payout invoice updated successfully",
      payout,
    });
  } catch (err) {
    console.error("Error updating payout invoice:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /api/admin/payouts/:payoutId/invoice
// Admin fetches complete invoice details & rendered HTML preview
router.get("/payouts/:payoutId/invoice", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { payoutId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(payoutId)) {
      return res.status(400).json({ message: "Invalid payout ID" });
    }

    const payout = await Payout.findById(payoutId).lean();
    if (!payout) {
      return res.status(404).json({ message: "Payout not found" });
    }

    const [fullApp, partner, policy] = await Promise.all([
      Application.findById(payout.application)
        .populate("customerId", "firstName lastName name phone email")
        .lean(),
      User.findById(payout.partnerId)
        .select("firstName lastName email phone bankName accountNumber ifscCode accountHolderName employeeId partnerCode panNumber panCard")
        .lean(),
      getInvoiceAndTdsPolicy(),
    ]);

    const custFirst = (fullApp?.customerId?.firstName || fullApp?.customer?.firstName || "").trim();
    const custLast = (fullApp?.customerId?.lastName || fullApp?.customer?.lastName || "").trim();
    const customerName = `${custFirst} ${custLast}`.trim() || fullApp?.customer?.name || "Customer";
    const appNo = fullApp?.appNo || (fullApp?._id ? `TLF${fullApp._id.toString().slice(-4).toUpperCase()}` : "APP");
    const approvedAmount = Number(fullApp?.approvedLoanAmount || fullApp?.customer?.loanAmount || 0);

    const paidAmount = Number(payout.amount || 0);
    const rawGross = payout.grossAmount != null ? Number(payout.grossAmount) : null;
    const grossAmount = rawGross != null && rawGross > 0 ? rawGross : paidAmount;
    const rawNet = payout.netAmount != null ? Number(payout.netAmount) : null;
    const netAmount = rawNet != null && rawNet > 0 ? rawNet : paidAmount;
    const tdsApplicable = payout.tdsApplicable !== undefined ? payout.tdsApplicable : true;
    const tdsSection = payout.tdsSection || policy.tdsSection || DEFAULT_TDS_SECTION;
    const tdsPercentage = payout.tdsPercentage != null ? payout.tdsPercentage : (policy.tdsPercentage ?? DEFAULT_TDS_PERCENTAGE);
    const rawTds = payout.tdsAmount != null ? Number(payout.tdsAmount) : null;
    const tdsAmount =
      rawTds != null && rawTds > 0
        ? rawTds
        : tdsApplicable && grossAmount > 0
        ? Number(((grossAmount * tdsPercentage) / 100).toFixed(2))
        : 0;
    const invoiceNumber = payout.invoiceNumber || generateInvoiceNumber(appNo, payout._id);
    const invoiceDate = payout.invoiceDate || payout.updatedAt || new Date();

    const invoicePayload = {
      invoiceNumber,
      invoiceDate,
      partner: partner || { name: "Channel Partner", panNumber: "—" },
      customerName,
      appNo,
      loanType: fullApp?.loanType || "Personal Loan",
      approvedAmount,
      grossAmount,
      payoutAmount: netAmount,
      payoutPercentage: payout.payoutPercentage || (approvedAmount > 0 ? Number(((grossAmount / approvedAmount) * 100).toFixed(2)) : 0),
      tdsApplicable,
      tdsSection,
      tdsPercentage,
      tdsAmount,
      netAmount,
      utrNumber: payout.note || "",
      note: payout.note || "",
      bankName: partner?.bankName || "",
      accountNumber: partner?.accountNumber || "",
      ifscCode: partner?.ifscCode || "",
      companyDetails: policy.companyDetails,
      invoiceNotes: payout.invoiceNotes || policy.invoiceNotes,
      invoiceSentAt: payout.invoiceSentAt || null,
      invoiceSentTo: payout.invoiceSentTo || null,
    };

    const invoiceHtml = buildPartnerInvoiceHtml(invoicePayload);

    return res.json({
      success: true,
      invoice: invoicePayload,
      html: invoiceHtml,
    });
  } catch (err) {
    console.error("Error fetching invoice:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ==================== DEFAULT PAYOUT POLICY & TDS SETTINGS ====================

// GET /api/admin/payout-policy
// Admin gets default payout percentages by loan product & TDS configuration
router.get("/payout-policy", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { Config } = await import("../models/Config.js");
    let config = await Config.findOne({ key: "DEFAULT_PAYOUT_POLICY" });

    const industrialDefaults = {
      PERSONAL: 2.0,
      BUSINESS: 1.8,
      HOME_LOAN_SALARIED: 0.75,
      HOME_LOAN_SELF_EMPLOYED: 0.85,
      LAP: 1.0,
      LAP_SALARIED: 1.0,
      LAP_SELF_EMPLOYED: 1.0,
      DEFAULT: 2.0,
      // TDS Settings (Section 194T default)
      tdsApplicable: true,
      tdsSection: "194T",
      tdsPercentage: 10,
      tdsDescription: "Section 194T - Payment to Partners of Firm (10%)",
      // Invoice configuration
      invoicePrefix: "INV-PO",
      companyName: "DhanSource Capital Pvt Ltd",
      companyAddress: "Office No -31, C Wing, Ashoka Nagar, Kharadi, Pune, Maharashtra 411014",
      companyGstin: "27AAACD1234F1Z5",
      companyPan: "AAACD1234F",
      companyTan: "MUMA12345E",
      invoiceNotes: "Tax has been deducted at source under Section 194T of the Income Tax Act, 1961. TDS certificate (Form 16A) will be issued quarterly on TRACES portal.",
    };

    if (!config) {
      config = {
        key: "DEFAULT_PAYOUT_POLICY",
        value: industrialDefaults,
      };
    } else {
      // Merge with industrial defaults to ensure TDS fields exist
      config.value = {
        ...industrialDefaults,
        ...config.value,
      };
    }

    return res.json({ success: true, policy: config.value });
  } catch (err) {
    console.error("Error fetching payout policy:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// PUT /api/admin/payout-policy
// Admin updates payout policy — merges with existing so invoice vs commission saves don't wipe each other
router.put("/payout-policy", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { policy } = req.body;
    if (!policy || typeof policy !== "object") {
      return res.status(400).json({ message: "Invalid policy object" });
    }

    const { Config } = await import("../models/Config.js");
    const existing = await Config.findOne({ key: "DEFAULT_PAYOUT_POLICY" }).lean();
    const merged = {
      ...(existing?.value || {}),
      ...policy,
    };

    const updated = await Config.findOneAndUpdate(
      { key: "DEFAULT_PAYOUT_POLICY" },
      { value: merged },
      { upsert: true, new: true }
    );

    return res.json({
      success: true,
      message: "Settings updated successfully",
      policy: updated.value,
    });
  } catch (err) {
    console.error("Error updating payout policy:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ==================== PARTNER TARGET POLICY CONFIG ====================

// GET /api/admin/target-policy
// Admin gets current partner target policy
router.get("/target-policy", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { Config } = await import("../models/Config.js");
    let config = await Config.findOne({ key: "PARTNER_TARGET_POLICY" });

    if (!config) {
      // Return defaults if not set
      config = {
        key: "PARTNER_TARGET_POLICY",
        value: {
          fileCountTarget: 4,
          disbursementTarget: 2000000, // ₹20,00,000
        },
      };
    }

    res.json(config.value);
  } catch (err) {
    console.error("Error fetching target policy:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// POST /api/admin/target-policy
// Admin sets partner target policy (file count target - disbursement is now top-down distributed)
router.post("/target-policy", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { fileCountTarget, disbursementTarget } = req.body;

    // fileCountTarget is required
    if (!fileCountTarget || fileCountTarget < 1) {
      return res.status(400).json({
        message: "fileCountTarget is required and must be at least 1"
      });
    }

    // disbursementTarget is optional (not used in top-down model, kept for backward compatibility)
    const finalDisbursementTarget = disbursementTarget !== undefined ? Number(disbursementTarget) : 0;

    const { Config } = await import("../models/Config.js");
    let config = await Config.findOne({ key: "PARTNER_TARGET_POLICY" });

    if (config) {
      config.value = {
        fileCountTarget: Number(fileCountTarget),
        disbursementTarget: finalDisbursementTarget, // Optional, defaults to 0 in top-down model
      };
      await config.save();
    } else {
      config = await Config.create({
        key: "PARTNER_TARGET_POLICY",
        value: {
          fileCountTarget: Number(fileCountTarget),
          disbursementTarget: finalDisbursementTarget,
        },
      });
    }

    res.json({
      message: "Partner target policy updated successfully",
      policy: config.value,
    });
  } catch (err) {
    console.error("Error updating target policy:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ==================== PUBLIC LOAN DEFAULT PARTNER REFERRAL ====================

// GET /api/admin/public-loan-default-partner
router.get(
  "/public-loan-default-partner",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { Config } = await import("../models/Config.js");
      const doc = await Config.findOne({
        key: "PUBLIC_LOAN_DEFAULT_PARTNER_CODE",
      }).lean();
      const value = doc?.value && typeof doc.value === "object" ? doc.value : {};
      const partnerId = value.partnerId ? String(value.partnerId) : null;
      const partnerCode = value.partnerCode ? String(value.partnerCode).trim() : "";

      let partner = null;
      if (partnerId && mongoose.isValidObjectId(partnerId)) {
        partner = await User.findOne({
          _id: partnerId,
          role: ROLES.PARTNER,
        })
          .select("firstName lastName partnerCode status employeeId email")
          .lean();
      }

      res.json({
        partnerId: partner?._id?.toString() || partnerId,
        partnerCode: partner?.partnerCode || partnerCode || PUBLIC_LOAN_REFERRAL_FALLBACK,
        partnerName: partner
          ? `${partner.firstName || ""} ${partner.lastName || ""}`.trim()
          : null,
        partnerStatus: partner?.status || null,
        fallbackUsed: !partner?.partnerCode && !partnerCode,
      });
    } catch (err) {
      console.error("public-loan-default-partner GET:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// PUT /api/admin/public-loan-default-partner  body: { partnerId: string }
router.put(
  "/public-loan-default-partner",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const partnerId = req.body?.partnerId;
      if (!partnerId || !mongoose.isValidObjectId(String(partnerId))) {
        return res.status(400).json({ message: "Valid partnerId is required" });
      }

      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
        status: "ACTIVE",
      })
        .select("firstName lastName partnerCode")
        .lean();

      if (!partner?.partnerCode) {
        return res.status(400).json({
          message:
            "Partner not found, not active, or missing partner code. Only active partners with a code can be used.",
        });
      }

      const { Config } = await import("../models/Config.js");
      let config = await Config.findOne({ key: "PUBLIC_LOAN_DEFAULT_PARTNER_CODE" });
      const payload = {
        partnerId: String(partner._id),
        partnerCode: partner.partnerCode.trim(),
      };

      if (config) {
        config.value = payload;
        await config.save();
      } else {
        config = await Config.create({
          key: "PUBLIC_LOAN_DEFAULT_PARTNER_CODE",
          value: payload,
        });
      }

      res.json({
        message: "Default public loan referral partner updated",
        partnerId: payload.partnerId,
        partnerCode: payload.partnerCode,
        partnerName: `${partner.firstName || ""} ${partner.lastName || ""}`.trim(),
      });
    } catch (err) {
      console.error("public-loan-default-partner PUT:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// ==================== DISBURSED LOANS MASTER EXPLORER (Admin) ====================

// GET /api/admin/disbursed-loans
// Fetches all company-wide disbursed loan files with full customer, partner, RM & doc dossier
router.get(
  "/disbursed-loans",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { year, month, loanType } = req.query;

      const hasYear = year && year !== "all";
      const hasMonth = month && month !== "all";

      let startDate = null;
      let endDate = null;

      if (hasYear && hasMonth) {
        startDate = new Date(Number(year), Number(month) - 1, 1, 0, 0, 0, 0);
        endDate = new Date(Number(year), Number(month), 1, 0, 0, 0, 0);
      } else if (hasYear) {
        startDate = new Date(Number(year), 0, 1, 0, 0, 0, 0);
        endDate = new Date(Number(year) + 1, 0, 1, 0, 0, 0, 0);
      } else if (hasMonth) {
        const curYear = new Date().getFullYear();
        startDate = new Date(curYear, Number(month) - 1, 1, 0, 0, 0, 0);
        endDate = new Date(curYear, Number(month), 1, 0, 0, 0, 0);
      }

      // Query all DISBURSED applications
      const filter = activeApplicationsFilter({
        status: "DISBURSED",
      });

      if (loanType && loanType !== "all") {
        filter.loanType = loanType;
      }

      const apps = await Application.find(filter)
        .populate("customerId", "firstName lastName email phone panNumber aadharNumber employmentType monthlyIncome city pincode employeeId")
        .populate("partnerId", "firstName lastName employeeId partnerCode email phone bankName accountNumber ifscCode accountHolderName")
        .populate("rmId", "firstName lastName employeeId phone email")
        .populate("bankId", "bankName branch ifsc")
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();

      // Fetch Payouts to associate payment statuses
      const appIds = apps.map((a) => a._id);
      const payouts = await Payout.find({ applicationId: { $in: appIds } }).lean();
      const payoutMap = new Map();
      payouts.forEach((p) => {
        if (p.applicationId) payoutMap.set(p.applicationId.toString(), p);
      });

      // Filter by date range and shape data
      const finalApps = [];
      let totalVolume = 0;
      const partnerSet = new Set();

      apps.forEach((app) => {
        const dDate = getDisbursedAt(app);
        if (!startDate || !endDate || isDateInRange(dDate, startDate, endDate)) {
          const approvedAmount = Number(app.approvedLoanAmount || app.requestedAmount || 0);
          totalVolume += approvedAmount;

          const pId = app.partnerId?._id ? app.partnerId._id.toString() : null;
          if (pId) partnerSet.add(pId);

          const payout = payoutMap.get(app._id.toString());

          finalApps.push({
            id: app._id,
            _id: app._id,
            appNo: app.appNo || `TLF${app._id.toString().slice(-4).toUpperCase()}`,
            loanType: app.loanType,
            requestedAmount: Number(app.requestedAmount || app.customer?.loanAmount || 0),
            approvedLoanAmount: approvedAmount,
            status: app.status,
            bankName: app.bankName || app.bankId?.bankName || "DhanSource Capital",
            disbursedAt: dDate || app.createdAt,
            createdAt: app.createdAt,
            updatedAt: app.updatedAt,
            customer: {
              id: app.customerId?._id || app._id,
              firstName: app.customerId?.firstName || app.customer?.firstName || "Customer",
              lastName: app.customerId?.lastName || app.customer?.lastName || "",
              fullName: `${app.customerId?.firstName || app.customer?.firstName || "Customer"} ${app.customerId?.lastName || app.customer?.lastName || ""}`.trim(),
              email: app.customerId?.email || app.customer?.email || "—",
              phone: app.customerId?.phone || app.customer?.phone || "—",
              panNumber: app.customerId?.panNumber || app.customer?.panNumber || "—",
              aadharNumber: app.customerId?.aadharNumber || app.customer?.aadharNumber || "—",
              employmentType: app.customerId?.employmentType || app.customer?.employmentType || "—",
              monthlyIncome: app.customerId?.monthlyIncome || app.customer?.monthlyIncome || 0,
              city: app.customerId?.city || app.customer?.city || "—",
              pincode: app.customerId?.pincode || app.customer?.pincode || "—",
              employeeId: app.customerId?.employeeId || null,
            },
            partner: app.partnerId
              ? {
                  id: app.partnerId._id,
                  firstName: app.partnerId.firstName,
                  lastName: app.partnerId.lastName,
                  fullName: `${app.partnerId.firstName || ""} ${app.partnerId.lastName || ""}`.trim(),
                  partnerCode: app.partnerId.partnerCode,
                  employeeId: app.partnerId.employeeId,
                  email: app.partnerId.email,
                  phone: app.partnerId.phone,
                  bankName: app.partnerId.bankName,
                  accountNumber: app.partnerId.accountNumber,
                  ifscCode: app.partnerId.ifscCode,
                  accountHolderName: app.partnerId.accountHolderName,
                }
              : null,
            rm: app.rmId
              ? {
                  id: app.rmId._id,
                  name: `${app.rmId.firstName || ""} ${app.rmId.lastName || ""}`.trim(),
                  employeeId: app.rmId.employeeId,
                  phone: app.rmId.phone,
                  email: app.rmId.email,
                }
              : null,
            documents: Array.isArray(app.documents) ? app.documents : [],
            stageHistory: Array.isArray(app.stageHistory) ? app.stageHistory : [],
            payoutStatus: payout?.payOutStatus || "PENDING",
            payoutAmount: payout?.amount != null ? Number(payout.amount) : 0,
            payoutNote: payout?.note || "",
          });
        }
      });

      const totalFilesCount = finalApps.length;
      const averageTicketSize = totalFilesCount > 0 ? Math.round(totalVolume / totalFilesCount) : 0;

      res.json({
        summary: {
          totalDisbursedVolume: totalVolume,
          totalFilesCount,
          averageTicketSize,
          uniquePartnersCount: partnerSet.size,
          year: hasYear ? Number(year) : "all",
          month: hasMonth ? Number(month) : "all",
        },
        applications: finalApps,
      });
    } catch (err) {
      console.error("disbursed-loans GET error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// ==================== PARTNER TARGET MANAGEMENT (Admin) ====================

// GET /api/admin/partners/targets
// Admin gets all partner targets
router.get("/partners/targets", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { year, month } = req.query;

    // Get all partners
    const partners = await User.find({
      role: ROLES.PARTNER,
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
    // Use createdAt / disbursedAt — not updatedAt (RM moves were floating counts)
    const allApps = await Application.find(
      activeApplicationsFilter({
        partnerId: { $in: partnerIds },
        status: { $ne: "DRAFT" },
      })
    ).lean();

    const startDate =
      year && month ? new Date(Number(year), Number(month) - 1, 1) : null;
    const endDate =
      year && month ? new Date(Number(year), Number(month), 1) : null;

    // Combine partner data with targets and achievements
    const partnerTargets = partners.map((partner) => {
      const target = targets.find(
        (t) => t.assignedTo.toString() === partner._id.toString()
      );
      const partnerAppsAll = allApps.filter(
        (app) => app.partnerId.toString() === partner._id.toString()
      );
      const partnerApps =
        startDate && endDate
          ? partnerAppsAll.filter((app) =>
              isDateInRange(new Date(app.createdAt), startDate, endDate)
            )
          : partnerAppsAll;

      const fileCountTarget = target?.fileCountTarget || 4;
      const disbursementTarget = target?.disbursementTarget || 2000000;
      const achievedFileCount = partnerApps.length;
      const achievedDisbursement = partnerAppsAll
        .filter((app) => {
          if (app.status !== "DISBURSED") return false;
          if (!startDate || !endDate) return true;
          return isDateInRange(getDisbursedAt(app), startDate, endDate);
        })
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

// POST /api/admin/target/assign-partner
// Admin assigns target to a single partner
router.post("/target/assign-partner", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { partnerId, month, year, fileCountTarget, disbursementTarget } = req.body;

    if (!partnerId || !month || !year || !fileCountTarget || !disbursementTarget) {
      return res.status(400).json({
        message: "partnerId, month, year, fileCountTarget, and disbursementTarget are required"
      });
    }

    if (month < 1 || month > 12) {
      return res.status(400).json({ message: "Invalid month value" });
    }

    const adminId = req.user.sub;

    // Verify partner exists
    const partner = await User.findOne({
      _id: partnerId,
      role: ROLES.PARTNER,
    }).lean();

    if (!partner) {
      return res.status(404).json({ message: "Partner not found" });
    }

    let target = await Target.findOne({
      assignedTo: partnerId,
      role: ROLES.PARTNER,
      month: Number(month),
      year: Number(year),
    });

    if (target) {
      target.fileCountTarget = Number(fileCountTarget);
      target.disbursementTarget = Number(disbursementTarget);
      target.assignedBy = adminId;
      await target.save();
    } else {
      target = await Target.create({
        assignedBy: adminId,
        assignedTo: partnerId,
        role: ROLES.PARTNER,
        month: Number(month),
        year: Number(year),
        fileCountTarget: Number(fileCountTarget),
        disbursementTarget: Number(disbursementTarget),
      });
    }

    emitTargetUpdatedForDoc(global.io, target);

    res.status(201).json({
      message: "Target assigned to partner successfully",
      target,
    });
  } catch (err) {
    console.error("Assign partner target error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ==================== INCENTIVE MANAGEMENT (Admin) ====================

// GET /api/admin/incentive-slabs
// Fetch active milestone disbursement slabs
router.get(
  "/incentive-slabs",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.ASM),
  async (req, res) => {
    try {
      const slabs = await getActiveIncentiveSlabs();
      res.json({ 
        slabs, 
        rule: INCENTIVE_PLAN_RULE,
        planSummary: INCENTIVE_PLAN_RULE.ruleText,
      });
    } catch (err) {
      console.error("Error fetching incentive slabs:", err);
      res.status(500).json({ message: "Failed to fetch incentive slabs", error: err.message });
    }
  }
);

// PUT /api/admin/incentive-slabs
// Update active milestone disbursement slabs
router.put(
  "/incentive-slabs",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.ASM),
  async (req, res) => {
    try {
      const { slabs } = req.body;
      if (!Array.isArray(slabs) || slabs.length === 0) {
        return res.status(400).json({ message: "Slabs array is required and must not be empty" });
      }

      // Validate slabs
      const cleanSlabs = slabs.map((s, idx) => ({
        id: s.id || `slab_${idx + 1}`,
        tier: s.tier || `Tier ${idx + 1}`,
        minDisbursement: Math.max(0, Number(s.minDisbursement || 0)),
        rewardAmount: Math.max(0, Number(s.rewardAmount || 0)),
        rewardType: s.rewardType === "PERCENT" ? "PERCENT" : "FLAT",
      })).sort((a, b) => a.minDisbursement - b.minDisbursement);

      await Config.findOneAndUpdate(
        { key: "INCENTIVE_SLAB_POLICY" },
        { key: "INCENTIVE_SLAB_POLICY", value: cleanSlabs },
        { upsert: true, new: true }
      );

      // Instantly sync partner levels & milestone policy to all mobile & web apps
      if (global.io) {
        global.io.emit("partnerLevelsUpdated", {
          slabs: cleanSlabs,
          timestamp: Date.now(),
        });
        global.io.emit("dashboardUpdate", { type: "partnerLevels" });
      }

      res.json({ message: "Incentive slabs updated successfully", slabs: cleanSlabs });
    } catch (err) {
      console.error("Error updating incentive slabs:", err);
      res.status(500).json({ message: "Failed to update incentive slabs", error: err.message });
    }
  }
);

export const DEFAULT_HERO_CONFIG = {
  label: "EXTRA CASH BONUS",
  badgeText: "EXTRA CASH BONUS",
  title: "Unlock Milestone Bonuses",
  subtitle: "Achieve higher monthly disbursement targets to unlock bigger cash bonuses, VIP badges, and priority perks.",
  bgColor: "#064E3B",
  borderColor: "#047857",
  badgeBgColor: "#A7F3D0",
  badgeTextColor: "#065F46",
  textColor: "#FFFFFF",
  subtextColor: "#D1FAE5",
  monthColor: "#A7F3D0",
  showMonthBadge: true,
  showTag: true,
  showFormulaPills: true,
  formulaPills: [],
  isActive: true,
  targetTab: "ladder",
  monthLabel: "",
};

export const sanitizeHeroConfig = (hero = {}, fallback = DEFAULT_HERO_CONFIG) => {
  const badge = hero?.badgeText || hero?.label || fallback.badgeText || "EXTRA CASH BONUS";
  return {
    label: badge,
    badgeText: badge,
    title: hero?.title !== undefined && hero?.title !== null ? String(hero.title) : fallback.title,
    subtitle: hero?.subtitle !== undefined && hero?.subtitle !== null ? String(hero.subtitle) : fallback.subtitle,
    bgColor: hero?.bgColor || fallback.bgColor || "#064E3B",
    borderColor: hero?.borderColor || fallback.borderColor || "#047857",
    badgeBgColor: hero?.badgeBgColor || fallback.badgeBgColor || "#A7F3D0",
    badgeTextColor: hero?.badgeTextColor || fallback.badgeTextColor || "#065F46",
    textColor: hero?.textColor || fallback.textColor || "#FFFFFF",
    subtextColor: hero?.subtextColor || fallback.subtextColor || "#D1FAE5",
    monthColor: hero?.monthColor || fallback.monthColor || "#A7F3D0",
    showMonthBadge: hero?.showMonthBadge !== undefined ? Boolean(hero.showMonthBadge) : (fallback.showMonthBadge !== undefined ? fallback.showMonthBadge : true),
    showTag: hero?.showTag !== undefined ? Boolean(hero.showTag) : (fallback.showTag !== undefined ? fallback.showTag : true),
    showFormulaPills: hero?.showFormulaPills !== undefined ? Boolean(hero.showFormulaPills) : (fallback.showFormulaPills !== undefined ? fallback.showFormulaPills : true),
    formulaPills: Array.isArray(hero?.formulaPills)
      ? hero.formulaPills.filter((p) => p && typeof p === "object" && p.vol && p.reward).map((p) => ({ vol: String(p.vol), reward: String(p.reward) }))
      : (fallback.formulaPills || []),
    isActive: hero?.isActive !== undefined ? Boolean(hero.isActive) : (fallback.isActive !== undefined ? fallback.isActive : true),
    targetTab: hero?.targetTab === "incentive" ? "incentive" : "ladder",
    monthLabel: hero?.monthLabel !== undefined && hero?.monthLabel !== null ? String(hero.monthLabel) : (fallback.monthLabel || ""),
  };
};

export const DEFAULT_PARTNER_LEVELS_CONFIG = {
  hero: DEFAULT_HERO_CONFIG,
  levels: [
    {
      id: "BRONZE",
      name: "Bronze",
      iconName: "Shield",
      color: "#B45309",
      bgColor: "#FFFBEB",
      accentColor: "#FEF3C7",
      criteria: "Achieve ₹10L+ monthly disbursement volume",
      minDisbursement: 1000000,
      rewardAmount: 1000,
      benefits: [
        "Earn ₹1,000 monthly milestone cash bonus",
        "Standard commission payouts on every loan",
        "Access to all standard loan products & banks",
        "Eligible for monthly milestone incentives",
      ],
    },
    {
      id: "SILVER",
      name: "Silver",
      iconName: "Award",
      color: "#64748B",
      bgColor: "#F8FAFC",
      accentColor: "#F1F5F9",
      criteria: "Achieve ₹20L+ monthly disbursement volume",
      minDisbursement: 2000000,
      rewardAmount: 2000,
      benefits: [
        "Earn ₹2,000 monthly milestone cash bonus",
        "Priority file processing & fast-track approval",
        "Exclusive Silver dashboard badge",
        "Dedicated email & support helpline",
      ],
    },
    {
      id: "GOLD",
      name: "Gold",
      iconName: "Star",
      color: "#CA8A04",
      bgColor: "#FEFCE8",
      accentColor: "#FEF9C3",
      criteria: "Achieve ₹30L+ monthly disbursement volume",
      minDisbursement: 3000000,
      rewardAmount: 3000,
      benefits: [
        "Earn ₹3,000 monthly milestone cash bonus",
        "Dedicated Relationship Manager (RM)",
        "Faster loan logins & desk clearance",
        "Special festive campaigns & booster incentives",
      ],
    },
    {
      id: "RUBY",
      name: "Ruby",
      iconName: "Gem",
      color: "#E11D48",
      bgColor: "#FFF1F2",
      accentColor: "#FFE4E6",
      criteria: "Achieve ₹40L+ monthly disbursement volume",
      minDisbursement: 4000000,
      rewardAmount: 4000,
      benefits: [
        "Earn ₹4,000 monthly milestone cash bonus",
        "Priority underwriting & fast turnaround",
        "Exclusive Ruby tier dashboard badge",
        "Direct credit coordinator support",
      ],
    },
    {
      id: "DIAMOND",
      name: "Diamond",
      iconName: "Sparkles",
      color: "#0D9488",
      bgColor: "#F0FDF4",
      accentColor: "#CCFBF1",
      criteria: "Achieve ₹50L+ monthly disbursement volume",
      minDisbursement: 5000000,
      rewardAmount: 5000,
      benefits: [
        "Earn ₹5,000 monthly milestone cash bonus",
        "Senior Relationship Manager (RM) assigned",
        "Priority payout clearance & same-day validation",
        "Early access to exclusive high-ticket loan products",
      ],
    },
    {
      id: "PLATINUM",
      name: "Platinum",
      iconName: "Trophy",
      color: "#0F172A",
      bgColor: "#F8FAFC",
      accentColor: "#E2E8F0",
      criteria: "Achieve ₹1Cr+ monthly disbursement volume",
      minDisbursement: 10000000,
      rewardAmount: 10000,
      benefits: [
        "Earn ₹10,000 monthly milestone cash bonus",
        "24/7 VIP desk support & relationship priority",
        "Fast-track instant payout settlement",
        "Executive partner certificates & VIP recognition",
      ],
    },
    {
      id: "TITANIUM",
      name: "Titanium",
      iconName: "Crown",
      color: "#7C3AED",
      bgColor: "#FAF5FF",
      accentColor: "#F3E8FF",
      criteria: "Achieve ₹2Cr+ monthly disbursement volume",
      minDisbursement: 20000000,
      rewardAmount: 20000,
      benefits: [
        "Earn ₹20,000 monthly milestone cash bonus",
        "VIP partner status across all lender banks",
        "Direct escalation line to DhanSource credit heads",
        "Quarterly awards & luxury networking invitations",
      ],
    },
    {
      id: "CROWN_ELITE",
      name: "Crown Elite",
      iconName: "Crown",
      color: "#2563EB",
      bgColor: "#EFF6FF",
      accentColor: "#DBEAFE",
      criteria: "Achieve ₹5Cr+ monthly disbursement volume",
      minDisbursement: 50000000,
      rewardAmount: 50000,
      benefits: [
        "Earn ₹50,000 monthly milestone cash bonus (+unlimited scaling)",
        "Highest commission tier & top revenue share",
        "DhanSource Elite Council membership",
        "All-inclusive Annual Gala VIP invitation",
      ],
    },
  ],
};

// GET /api/admin/partner-levels - Fetch partner levels & hero configuration
router.get(
  "/partner-levels",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.ASM),
  async (req, res) => {
    try {
      const cfg = await Config.findOne({ key: "PARTNER_LEVELS_CONFIG" });
      if (cfg && cfg.value && cfg.value.levels) {
        const mergedHero = sanitizeHeroConfig(cfg.value.hero, DEFAULT_HERO_CONFIG);
        return res.json({ success: true, hero: mergedHero, levels: cfg.value.levels });
      }
      return res.json({ success: true, ...DEFAULT_PARTNER_LEVELS_CONFIG });
    } catch (err) {
      console.error("Error fetching partner levels config:", err);
      return res.status(500).json({ message: "Failed to fetch partner levels config", error: err.message });
    }
  }
);

// PUT /api/admin/partner-levels - Update partner levels & hero configuration (Full CRUD)
router.put(
  "/partner-levels",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  async (req, res) => {
    try {
      const { hero, levels } = req.body;
      const existing = await Config.findOne({ key: "PARTNER_LEVELS_CONFIG" });

      let cleanLevels = [];
      if (Array.isArray(levels) && levels.length > 0) {
        cleanLevels = levels.map((lvl, idx) => ({
          id: (lvl.id || lvl.name || `LEVEL_${idx + 1}`).toUpperCase().trim(),
          name: lvl.name || `Level ${idx + 1}`,
          iconName: lvl.iconName || "Shield",
          color: lvl.color || "#0D9488",
          bgColor: lvl.bgColor || "#F8FAFC",
          accentColor: lvl.accentColor || "#E2E8F0",
          criteria: lvl.criteria || "",
          minDisbursement: Math.max(0, Number(lvl.minDisbursement || 0)),
          rewardAmount: Math.max(0, Number(lvl.rewardAmount || 0)),
          benefits: Array.isArray(lvl.benefits) ? lvl.benefits.filter(Boolean) : [],
        }));
      } else if (existing?.value?.levels && Array.isArray(existing.value.levels) && existing.value.levels.length > 0) {
        cleanLevels = existing.value.levels;
      } else {
        cleanLevels = DEFAULT_PARTNER_LEVELS_CONFIG.levels;
      }

      const existingHero = existing?.value?.hero || DEFAULT_HERO_CONFIG;
      const cleanHero = sanitizeHeroConfig(hero, existingHero);

      const updated = await Config.findOneAndUpdate(
        { key: "PARTNER_LEVELS_CONFIG" },
        { key: "PARTNER_LEVELS_CONFIG", value: { hero: cleanHero, levels: cleanLevels } },
        { upsert: true, new: true }
      );

      // Auto-sync milestone calculation policy so Admin Incentives & Mobile Milestone Calculators stay unified
      try {
        const syncedSlabs = cleanLevels
          .filter((lvl) => Number(lvl.minDisbursement) > 0)
          .map((lvl, idx) => ({
            id: `slab_${idx + 1}`,
            tier: lvl.name,
            minDisbursement: Number(lvl.minDisbursement),
            rewardAmount: Number(lvl.rewardAmount),
            rewardType: "FLAT",
            description: `${lvl.name} (₹${(lvl.minDisbursement / 100000).toLocaleString("en-IN")}L) ➔ ₹${lvl.rewardAmount.toLocaleString("en-IN")} Bonus`,
          }))
          .sort((a, b) => a.minDisbursement - b.minDisbursement);

        if (syncedSlabs.length > 0) {
          await Config.findOneAndUpdate(
            { key: "INCENTIVE_SLAB_POLICY" },
            { key: "INCENTIVE_SLAB_POLICY", value: syncedSlabs },
            { upsert: true, new: true }
          );
        }
      } catch (syncErr) {
        console.warn("Notice: Could not auto-sync INCENTIVE_SLAB_POLICY:", syncErr);
      }

      // Instantly sync partner levels & milestone policy to all mobile & web apps
      if (global.io) {
        global.io.emit("partnerLevelsUpdated", {
          hero: cleanHero,
          levels: cleanLevels,
          timestamp: Date.now(),
        });
        global.io.emit("dashboardUpdate", { type: "partnerLevels" });
      }

      return res.json({
        success: true,
        message: "Partner levels configuration saved successfully",
        hero: cleanHero,
        levels: cleanLevels,
      });
    } catch (err) {
      console.error("Error updating partner levels config:", err);
      return res.status(500).json({ message: "Failed to update partner levels config", error: err.message });
    }
  }
);

// PUT /api/admin/milestone-banner - Dedicated endpoint to edit the milestone bonus banner card
router.put(
  "/milestone-banner",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  async (req, res) => {
    try {
      const heroInput = req.body?.hero || req.body;
      const existing = await Config.findOne({ key: "PARTNER_LEVELS_CONFIG" });
      const existingLevels = (existing?.value?.levels && Array.isArray(existing.value.levels))
        ? existing.value.levels
        : DEFAULT_PARTNER_LEVELS_CONFIG.levels;
      const existingHero = existing?.value?.hero || DEFAULT_HERO_CONFIG;

      const cleanHero = sanitizeHeroConfig(heroInput, existingHero);

      await Config.findOneAndUpdate(
        { key: "PARTNER_LEVELS_CONFIG" },
        { key: "PARTNER_LEVELS_CONFIG", value: { hero: cleanHero, levels: existingLevels } },
        { upsert: true, new: true }
      );

      if (global.io) {
        global.io.emit("partnerLevelsUpdated", {
          hero: cleanHero,
          levels: existingLevels,
          timestamp: Date.now(),
        });
        global.io.emit("dashboardUpdate", { type: "partnerLevels" });
      }

      return res.json({
        success: true,
        message: "Milestone bonus banner card updated successfully",
        hero: cleanHero,
        levels: existingLevels,
      });
    } catch (err) {
      console.error("Error updating milestone banner config:", err);
      return res.status(500).json({ message: "Failed to update milestone banner", error: err.message });
    }
  }
);

// GET /api/admin/incentives
// Admin sees milestone incentive overview per partner calculated from monthly disbursed volume
router.get(
  "/incentives",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { status, year, month } = req.query;

      // Get active slabs
      const activeSlabs = await getActiveIncentiveSlabs();

      // Find all partner IDs from applications as well to ensure NO partner is ever missed
      const appPartnerIds = await Application.distinct("partnerId", {
        partnerId: { $exists: true, $ne: null },
      });

      // Get all partners in the system with bank details
      const partners = await User.find({
        $or: [
          { role: { $in: [ROLES.PARTNER, "PARTNER", "partner"] } },
          { _id: { $in: appPartnerIds } },
        ],
      })
        .populate({
          path: "asmId",
          select: "firstName lastName employeeId",
        })
        .select(
          "firstName lastName employeeId email phone bankName accountNumber ifscCode accountHolderName asmId"
        )
        .lean();

      if (!partners.length) {
        return res.json([]);
      }

      const partnerIds = partners.map((p) => p._id);

      // Build date filter
      const currentDate = new Date();
      const isAllTime = year === "all" && month === "all";
      const targetYear = (year && year !== "all") ? Number(year) : (isAllTime ? null : currentDate.getFullYear());
      const targetMonth = (month && month !== "all") ? Number(month) : (isAllTime ? null : currentDate.getMonth() + 1);

      let startDate = null;
      let endDate = null;

      if (targetYear && targetMonth) {
        startDate = new Date(targetYear, targetMonth - 1, 1, 0, 0, 0, 0);
        endDate = new Date(targetYear, targetMonth, 1, 0, 0, 0, 0);
      } else if (targetYear) {
        startDate = new Date(targetYear, 0, 1, 0, 0, 0, 0);
        endDate = new Date(targetYear + 1, 0, 1, 0, 0, 0, 0);
      }

      // Fetch all disbursed applications
      const disbursedApps = await Application.find(
        activeApplicationsFilter({
          partnerId: { $in: partnerIds },
          status: "DISBURSED",
        })
      ).lean();

      // Group disbursed applications by partner for target period
      const volumeByPartner = new Map();
      const countByPartner = new Map();

      disbursedApps.forEach((app) => {
        const dDate = getDisbursedAt(app);
        if (!startDate || !endDate || isDateInRange(dDate, startDate, endDate)) {
          const pId = app.partnerId.toString();
          const amt = parseFloat(app.approvedLoanAmount) || 0;
          volumeByPartner.set(pId, (volumeByPartner.get(pId) || 0) + amt);
          countByPartner.set(pId, (countByPartner.get(pId) || 0) + 1);
        }
      });

      // Attach existing Incentive records (PENDING / PAID) for this period
      const incentiveQuery = {
        partnerId: { $in: partnerIds },
      };
      if (targetMonth) incentiveQuery.month = targetMonth;
      if (targetYear) incentiveQuery.year = targetYear;

      const incentiveDocs = await Incentive.find(incentiveQuery)
        .populate({
          path: "asmId",
          select: "firstName lastName employeeId",
        })
        .lean();

      const docMap = new Map();
      incentiveDocs.forEach((inv) => {
        docMap.set(inv.partnerId.toString(), inv);
      });

      // Compute milestone calculation for each partner
      let response = partners.map((partner) => {
        const pIdStr = partner._id.toString();
        const monthlyDisbursed = volumeByPartner.get(pIdStr) || 0;
        const disbursedCount = countByPartner.get(pIdStr) || 0;

        const milestone = calculatePartnerMilestone(monthlyDisbursed, activeSlabs);
        const doc = docMap.get(pIdStr);
        const docAsm = doc?.asmId || partner.asmId;

        const isPaid = doc?.status === "PAID";
        const isEligible = milestone.isEligible;

        // Canonical incentive amount (either from paid doc or calculated from slab milestone)
        const finalIncentiveAmount = doc?.amount != null ? doc.amount : milestone.incentiveAmount;

        const currentStatus = isPaid
          ? "PAID"
          : isEligible
          ? "PENDING"
          : "IN_PROGRESS";

        return {
          partnerId: partner._id,
          partnerName: `${partner.firstName} ${partner.lastName || ""}`.trim(),
          partnerEmployeeId: partner.employeeId,
          partnerPhone: partner.phone,
          partnerEmail: partner.email,
          partnerBankName: partner.bankName || "—",
          partnerAccountNumber: partner.accountNumber || "—",
          partnerIfscCode: partner.ifscCode || "—",
          partnerAccountHolderName:
            partner.accountHolderName || `${partner.firstName} ${partner.lastName || ""}`.trim(),
          asmId: docAsm?._id || partner.asmId?._id || null,
          asmName: docAsm ? `${docAsm.firstName} ${docAsm.lastName || ""}`.trim() : null,
          asmEmployeeId: docAsm?.employeeId || null,

          // Milestone Metrics
          month: targetMonth,
          year: targetYear,
          disbursedAmount: monthlyDisbursed,
          totalAchieved: monthlyDisbursed,
          achievedDisbursement: monthlyDisbursed,
          disbursedCount,
          achievedFileCount: disbursedCount,

          // Slab calculation
          achievedSlab: milestone.achievedSlab,
          nextSlab: milestone.nextSlab,
          tier: milestone.tier,
          incentiveLevel: milestone.tier,
          remainingToNextMilestone: milestone.remainingToNextMilestone,
          progressPercent: milestone.progressPercent,
          eligibleForIncentive: isEligible,

          // Incentive Financials
          incentiveAmount: Math.round(finalIncentiveAmount),
          amount: Math.round(finalIncentiveAmount),
          incentiveRecordId: doc?._id || null,
          id: doc?._id || null,
          incentiveStatus: currentStatus,
          status: currentStatus,
          incentivePaid: isPaid,
          paidAt: doc?.paidAt || null,
          notes: doc?.notes || null,
          utrNumber: doc?.notes || null,
          // Invoice / TDS (Section 194T) — same shape as payout invoices
          grossAmount: doc?.grossAmount != null && Number(doc.grossAmount) > 0
            ? Number(doc.grossAmount)
            : Math.round(finalIncentiveAmount),
          tdsApplicable: doc?.tdsApplicable !== undefined ? Boolean(doc.tdsApplicable) : true,
          tdsSection: doc?.tdsSection || "194T",
          tdsPercentage: doc?.tdsPercentage != null ? Number(doc.tdsPercentage) : 10,
          tdsAmount: doc?.tdsAmount != null ? Number(doc.tdsAmount) : 0,
          netAmount: doc?.netAmount != null && Number(doc.netAmount) > 0
            ? Number(doc.netAmount)
            : (doc?.amount != null ? Number(doc.amount) : Math.round(finalIncentiveAmount)),
          invoiceNumber: doc?.invoiceNumber || "",
          invoiceDate: doc?.invoiceDate || null,
          invoiceSentAt: doc?.invoiceSentAt || null,
          invoiceSentTo: doc?.invoiceSentTo || "",
          invoiceNotes: doc?.invoiceNotes || "",
        };
      });

      // Status filter if requested
      if (status === "PAID") {
        response = response.filter((r) => r.status === "PAID");
      } else if (status === "PENDING" || status === "ELIGIBLE") {
        response = response.filter((r) => r.status === "PENDING");
      }

      res.json(response);
    } catch (err) {
      console.error("Error fetching admin incentives:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// Helper: apply Sec 194T invoice fields on incentive + optionally email formal invoice
async function settleIncentiveInvoiceFields(incentive, partner, body = {}, opts = {}) {
  const policy = await getInvoiceAndTdsPolicy();
  const {
    amount,
    grossAmount: inputGross,
    tdsApplicable: inputTdsApplicable,
    tdsSection: inputTdsSection,
    tdsPercentage: inputTdsPercentage,
    tdsAmount: inputTdsAmount,
    netAmount: inputNetAmount,
    invoiceNumber: inputInvoiceNumber,
    invoiceDate: inputInvoiceDate,
    invoiceNotes: inputInvoiceNotes,
    sendInvoiceEmail: inputSendInvoiceEmail,
    note,
    utrNumber,
  } = body;

  const isTds =
    inputTdsApplicable !== undefined
      ? Boolean(inputTdsApplicable)
      : incentive.tdsApplicable !== undefined
      ? Boolean(incentive.tdsApplicable)
      : policy.tdsApplicable !== false;
  const tdsSection = inputTdsSection || incentive.tdsSection || policy.tdsSection || DEFAULT_TDS_SECTION;
  const tdsPercentage =
    inputTdsPercentage != null
      ? Number(inputTdsPercentage)
      : incentive.tdsPercentage != null
      ? Number(incentive.tdsPercentage)
      : policy.tdsPercentage ?? DEFAULT_TDS_PERCENTAGE;

  const grossBase =
    inputGross != null && Number(inputGross) > 0
      ? Number(inputGross)
      : amount != null && Number(amount) > 0
      ? Number(amount)
      : Number(incentive.grossAmount || incentive.amount || 0);

  const calc = calculateTdsAndNet({
    approvedAmount: Number(opts.disbursedVolume || 0),
    grossAmount: grossBase,
    directAmount: grossBase,
    tdsApplicable: isTds,
    tdsSection,
    tdsPercentage,
  });

  const finalGross = inputGross != null ? Number(inputGross) : calc.grossAmount;
  const finalTdsAmt = inputTdsAmount != null ? Number(inputTdsAmount) : calc.tdsAmount;
  const finalNetAmt =
    inputNetAmount != null
      ? Number(inputNetAmount)
      : calc.netAmount || finalGross;

  const partnerCode =
    partner?.employeeId || partner?.partnerCode || String(incentive.partnerId || "PARTNER");
  const periodRef = `${incentive.year || ""}-${String(incentive.month || "").padStart(2, "0")}`;
  const invoiceNum =
    inputInvoiceNumber ||
    incentive.invoiceNumber ||
    generateIncentiveInvoiceNumber(`${partnerCode}-${periodRef}`, incentive._id);

  incentive.grossAmount = finalGross;
  incentive.tdsApplicable = isTds;
  incentive.tdsSection = tdsSection;
  incentive.tdsPercentage = tdsPercentage;
  incentive.tdsAmount = finalTdsAmt;
  incentive.netAmount = finalNetAmt;
  incentive.amount = Math.round(finalNetAmt > 0 ? finalNetAmt : finalGross);
  incentive.invoiceNumber = invoiceNum;
  incentive.invoiceDate = inputInvoiceDate
    ? new Date(inputInvoiceDate)
    : incentive.invoiceDate || new Date();
  if (inputInvoiceNotes !== undefined) {
    incentive.invoiceNotes = inputInvoiceNotes;
  } else if (!incentive.invoiceNotes) {
    incentive.invoiceNotes = policy.invoiceNotes || "";
  }
  incentive.notes = utrNumber || note || incentive.notes || "";

  const shouldEmail = inputSendInvoiceEmail !== false;
  let emailed = false;

  if (shouldEmail && partner?.email) {
    const monthNames = [
      "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const periodLabel = `${monthNames[incentive.month] || incentive.month} ${incentive.year}`;
    emailed = await sendPartnerIncentiveInvoiceEmail({
      partner,
      customerName: opts.tierLabel || "Milestone Bonus",
      appNo: `INC-${periodRef}-${partnerCode}`.toUpperCase(),
      loanType: "Milestone Incentive Bonus",
      approvedAmount: Number(opts.disbursedVolume || 0),
      grossAmount: finalGross,
      payoutAmount: finalNetAmt,
      payoutPercentage: 0,
      tdsApplicable: isTds,
      tdsSection,
      tdsPercentage,
      tdsAmount: finalTdsAmt,
      netAmount: finalNetAmt,
      invoiceNumber: invoiceNum,
      invoiceDate: incentive.invoiceDate,
      utrNumber: incentive.notes || "",
      note: incentive.notes || "",
      bankName: partner.bankName || "",
      accountNumber: partner.accountNumber || "",
      ifscCode: partner.ifscCode || "",
      companyDetails: policy.companyDetails,
      invoiceNotes: incentive.invoiceNotes,
      periodLabel,
      tierLabel: opts.tierLabel || "Milestone",
    });
    if (emailed) {
      incentive.invoiceSentAt = new Date();
      incentive.invoiceSentTo = partner.email;
    }
  }

  return { emailed, finalNetAmt, finalGross };
}

// POST /api/admin/incentives/:id/pay
// Admin marks an existing incentive record as PAID (+ formal Sec 194T invoice email like payouts)
router.post(
  "/incentives/:id/pay",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid incentive ID" });
      }

      const incentive = await Incentive.findById(id);
      if (!incentive) {
        return res.status(404).json({ message: "Incentive record not found" });
      }

      const partner = await User.findById(incentive.partnerId)
        .select(
          "firstName lastName email phone bankName accountNumber ifscCode accountHolderName employeeId partnerCode panNumber panCard"
        )
        .lean();

      incentive.status = "PAID";
      incentive.paidAt = new Date();
      incentive.paidBy = req.user.sub;

      const { emailed } = await settleIncentiveInvoiceFields(incentive, partner, req.body, {
        tierLabel: "Milestone Bonus",
        disbursedVolume: incentive.achievedDisbursement || 0,
      });
      await incentive.save();

      try {
        const io = global.io;
        if (io) {
          await emitIncentiveStatusChanged(io, incentive, incentive.partnerId);
        }
        // Fallback simple status email only if formal invoice was not sent
        if (!emailed && partner?.email && req.body?.sendInvoiceEmail === false) {
          setImmediate(async () => {
            try {
              await sendIncentiveEmail(partner, {
                _id: incentive._id,
                amount: incentive.amount,
                status: "PAID",
                month: incentive.month,
                year: incentive.year,
                paidAt: incentive.paidAt,
                note: incentive.notes,
              });
            } catch (mailErr) {
              console.error("❌ Failed to send incentive email:", mailErr.message);
            }
          });
        }
      } catch (notifyErr) {
        console.error("❌ Error emitting incentive notifications:", notifyErr);
      }

      res.json({
        message: emailed
          ? "Incentive paid successfully. Section 194T tax invoice emailed to partner."
          : "Incentive paid successfully",
        incentive,
        invoiceEmailed: emailed,
      });
    } catch (err) {
      console.error("Error paying admin incentive:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// POST /api/admin/incentives/partner-pay
// Admin pays an eligible partner directly (creates Incentive doc if missing and marks PAID)
router.post(
  "/incentives/partner-pay",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { partnerId, month, year, amount, note, utrNumber } = req.body;

      if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
        return res.status(400).json({ message: "Invalid partner ID" });
      }

      const targetMonth = Number(month) || new Date().getMonth() + 1;
      const targetYear = Number(year) || new Date().getFullYear();
      const payAmount = Math.max(1, Math.round(Number(amount) || 1000));

      const partner = await User.findById(partnerId)
        .select(
          "firstName lastName email phone bankName accountNumber ifscCode accountHolderName employeeId partnerCode panNumber panCard asmId"
        )
        .lean();
      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      let incentive = await Incentive.findOne({
        partnerId,
        month: targetMonth,
        year: targetYear,
      });

      if (incentive) {
        incentive.status = "PAID";
        incentive.paidAt = new Date();
        incentive.paidBy = req.user.sub;
      } else {
        incentive = new Incentive({
          partnerId,
          asmId: partner.asmId || req.user.sub,
          month: targetMonth,
          year: targetYear,
          fileCountTarget: 0,
          achievedFileCount: 0,
          disbursementTarget: 0,
          achievedDisbursement: 0,
          basis: "FIXED",
          fixedValue: payAmount,
          amount: payAmount,
          status: "PAID",
          paidAt: new Date(),
          paidBy: req.user.sub,
          notes: utrNumber || note || "",
        });
      }

      // Resolve milestone tier label for invoice
      let tierLabel = "Milestone Bonus";
      let disbursedVolume = Number(incentive.achievedDisbursement || 0);
      try {
        const activeSlabs = await getActiveIncentiveSlabs();
        const startDate = new Date(targetYear, targetMonth - 1, 1, 0, 0, 0, 0);
        const endDate = new Date(targetYear, targetMonth, 1, 0, 0, 0, 0);
        const apps = await Application.find(
          activeApplicationsFilter({
            partnerId,
            status: "DISBURSED",
          })
        )
          .select("approvedLoanAmount disbursedAt disbursedDate stageHistory createdAt updatedAt")
          .lean();
        disbursedVolume = apps.reduce((sum, app) => {
          const dDate = getDisbursedAt(app);
          if (isDateInRange(dDate, startDate, endDate)) {
            return sum + (parseFloat(app.approvedLoanAmount) || 0);
          }
          return sum;
        }, 0);
        incentive.achievedDisbursement = disbursedVolume;
        const milestone = calculatePartnerMilestone(disbursedVolume, activeSlabs);
        tierLabel = milestone.tier || tierLabel;
      } catch (e) {
        console.warn("Could not resolve incentive milestone for invoice:", e.message);
      }

      const { emailed } = await settleIncentiveInvoiceFields(
        incentive,
        partner,
        { ...req.body, amount: payAmount },
        { tierLabel, disbursedVolume }
      );
      await incentive.save();

      try {
        const io = global.io;
        if (io) {
          await emitIncentiveStatusChanged(io, incentive, partnerId);
        }
        if (!emailed && partner.email && req.body?.sendInvoiceEmail === false) {
          setImmediate(async () => {
            try {
              await sendIncentiveEmail(partner, {
                _id: incentive._id,
                amount: incentive.amount,
                status: "PAID",
                month: incentive.month,
                year: incentive.year,
                paidAt: incentive.paidAt,
                note: incentive.notes,
              });
            } catch (mailErr) {
              console.error("❌ Failed to send incentive email:", mailErr.message);
            }
          });
        }
      } catch (notifyErr) {
        console.error("❌ Error emitting incentive notifications:", notifyErr);
      }

      res.json({
        message: emailed
          ? "Incentive settled. Section 194T tax invoice emailed to partner."
          : "Incentive settled and marked as paid successfully",
        incentive,
        invoiceEmailed: emailed,
      });
    } catch (err) {
      console.error("Error paying partner incentive:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// POST /api/admin/incentives/:id/send-invoice
// Admin sends or resends formal Section 194T incentive invoice email (same as payouts)
router.post(
  "/incentives/:id/send-invoice",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid incentive ID" });
      }

      const incentive = await Incentive.findById(id);
      if (!incentive) {
        return res.status(404).json({ message: "Incentive record not found" });
      }

      const [partner, policy] = await Promise.all([
        User.findById(incentive.partnerId)
          .select(
            "firstName lastName email phone bankName accountNumber ifscCode accountHolderName employeeId partnerCode panNumber panCard"
          )
          .lean(),
        getInvoiceAndTdsPolicy(),
      ]);

      if (!partner || !partner.email) {
        return res.status(400).json({ message: "Partner has no registered email address" });
      }

      const paidAmount = Number(incentive.amount || 0);
      const rawGross = incentive.grossAmount != null ? Number(incentive.grossAmount) : null;
      const grossAmount = rawGross != null && rawGross > 0 ? rawGross : paidAmount;
      const rawNet = incentive.netAmount != null ? Number(incentive.netAmount) : null;
      const netAmount = rawNet != null && rawNet > 0 ? rawNet : paidAmount;
      const tdsApplicable =
        incentive.tdsApplicable !== undefined ? incentive.tdsApplicable : true;
      const tdsSection = incentive.tdsSection || policy.tdsSection || DEFAULT_TDS_SECTION;
      const tdsPercentage =
        incentive.tdsPercentage != null
          ? incentive.tdsPercentage
          : policy.tdsPercentage ?? DEFAULT_TDS_PERCENTAGE;
      const rawTds = incentive.tdsAmount != null ? Number(incentive.tdsAmount) : null;
      const tdsAmount =
        rawTds != null && rawTds > 0
          ? rawTds
          : tdsApplicable && grossAmount > 0
          ? Number(((grossAmount * tdsPercentage) / 100).toFixed(2))
          : 0;

      const partnerCode = partner.employeeId || partner.partnerCode || "PARTNER";
      const periodRef = `${incentive.year}-${String(incentive.month).padStart(2, "0")}`;
      const invoiceNumber =
        incentive.invoiceNumber ||
        generateIncentiveInvoiceNumber(`${partnerCode}-${periodRef}`, incentive._id);
      const monthNames = [
        "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
      ];
      const periodLabel = `${monthNames[incentive.month] || incentive.month} ${incentive.year}`;

      const emailed = await sendPartnerIncentiveInvoiceEmail({
        partner,
        customerName: "Milestone Bonus",
        appNo: `INC-${periodRef}-${partnerCode}`.toUpperCase(),
        loanType: "Milestone Incentive Bonus",
        approvedAmount: Number(incentive.achievedDisbursement || 0),
        grossAmount,
        payoutAmount: netAmount,
        payoutPercentage: 0,
        tdsApplicable,
        tdsSection,
        tdsPercentage,
        tdsAmount,
        netAmount,
        invoiceNumber,
        invoiceDate: incentive.invoiceDate || incentive.paidAt || new Date(),
        utrNumber: incentive.notes || "",
        note: incentive.notes || "",
        bankName: partner.bankName || "",
        accountNumber: partner.accountNumber || "",
        ifscCode: partner.ifscCode || "",
        companyDetails: policy.companyDetails,
        invoiceNotes: incentive.invoiceNotes || policy.invoiceNotes,
        periodLabel,
        tierLabel: "Milestone",
      });

      if (emailed) {
        if (!incentive.invoiceNumber) incentive.invoiceNumber = invoiceNumber;
        if (!incentive.invoiceDate) incentive.invoiceDate = new Date();
        incentive.invoiceSentAt = new Date();
        incentive.invoiceSentTo = partner.email;
        await incentive.save();
        return res.json({
          message: `Incentive tax invoice emailed to ${partner.email}`,
          invoiceSentAt: incentive.invoiceSentAt,
          invoiceSentTo: incentive.invoiceSentTo,
          invoiceNumber: incentive.invoiceNumber,
        });
      }

      return res.status(500).json({ message: "Failed to send invoice email via mail server" });
    } catch (err) {
      console.error("Error sending incentive invoice email:", err);
      return res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// PUT /api/admin/incentives/:id/invoice
// Admin edits incentive invoice number / date / notes / TDS amounts
router.put(
  "/incentives/:id/invoice",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid incentive ID" });
      }

      const incentive = await Incentive.findById(id);
      if (!incentive) {
        return res.status(404).json({ message: "Incentive record not found" });
      }

      const {
        invoiceNumber,
        invoiceDate,
        invoiceNotes,
        grossAmount,
        tdsApplicable,
        tdsSection,
        tdsPercentage,
        tdsAmount,
        netAmount,
        note,
        utrNumber,
      } = req.body;

      if (invoiceNumber !== undefined) {
        incentive.invoiceNumber = String(invoiceNumber || "").trim();
      }
      if (invoiceDate !== undefined) {
        incentive.invoiceDate = invoiceDate ? new Date(invoiceDate) : incentive.invoiceDate;
      }
      if (invoiceNotes !== undefined) incentive.invoiceNotes = invoiceNotes;
      if (grossAmount != null && Number(grossAmount) >= 0) {
        incentive.grossAmount = Number(grossAmount);
      }
      if (tdsApplicable !== undefined) incentive.tdsApplicable = Boolean(tdsApplicable);
      if (tdsSection !== undefined) incentive.tdsSection = tdsSection || "194T";
      if (tdsPercentage != null) incentive.tdsPercentage = Number(tdsPercentage);
      if (tdsAmount != null) incentive.tdsAmount = Number(tdsAmount);
      if (netAmount != null && Number(netAmount) >= 0) {
        incentive.netAmount = Number(netAmount);
        incentive.amount = Math.round(Number(netAmount));
      }
      if (utrNumber !== undefined || note !== undefined) {
        incentive.notes = utrNumber || note || incentive.notes || "";
      }

      await incentive.save();

      return res.json({
        message: "Incentive invoice updated successfully",
        incentive,
      });
    } catch (err) {
      console.error("Error updating incentive invoice:", err);
      return res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// POST /api/admin/target/distribute-hierarchical
// Top-Down Target Distribution: Admin sets total company target, system divides it down the hierarchy
// Admin → ASM → RSM → RM → Partner
router.get(
  "/target/distribution-preview",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const month = Number(req.query.month);
      const year = Number(req.query.year);

      if (!month || !year) {
        return res.status(400).json({ message: "month and year are required" });
      }

      if (month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month value" });
      }

      const [asms, rsms, rms, partners, targetDocs] = await Promise.all([
        User.find({ role: ROLES.ASM }).select("_id").lean(),
        User.find({ role: ROLES.RSM }).select("_id").lean(),
        User.find({ role: ROLES.RM }).select("_id").lean(),
        User.find({ role: ROLES.PARTNER }).select("_id").lean(),
        Target.find({ month, year }).select("role disbursementTarget targetValue").lean(),
      ]);

      const sumByRole = (role) =>
        targetDocs
          .filter((t) => t.role === role)
          .reduce(
            (sum, t) => sum + Number(t.disbursementTarget || t.targetValue || 0),
            0
          );

      const current = {
        asmTotal: sumByRole(ROLES.ASM),
        rsmTotal: sumByRole(ROLES.RSM),
        rmTotal: sumByRole(ROLES.RM),
        partnerTotal: sumByRole(ROLES.PARTNER),
      };

      res.json({
        month,
        year,
        hierarchyCounts: {
          asmCount: asms.length,
          rsmCount: rsms.length,
          rmCount: rms.length,
          partnerCount: partners.length,
        },
        currentTotals: current,
      });
    } catch (err) {
      console.error("Target distribution preview error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// POST /api/admin/target/assign-new-users
// Assign targets only to users who don't have target entries for selected month/year.
// POST /api/admin/target/assign-new-users
// Industry standard approach for Top-Down models: 
// Re-distributes the existing Company Target across the updated hierarchy (including new joiners).
router.post(
  "/target/assign-new-users",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { month, year } = req.body || {};
      const targetMonth = Number(month);
      const targetYear = Number(year);

      if (!targetMonth || !targetYear) {
        return res.status(400).json({ message: "Month and year are required" });
      }

      const { deriveCurrentTargetContext, rebalanceHierarchyTargetsReplace } = await import("../utils/targetRebalanceService.js");

      // Step 1: Detect current target context (Total Company Target already set by Admin)
      const context = await deriveCurrentTargetContext(targetMonth, targetYear);

      if (!context.totalCompanyTarget || context.totalCompanyTarget <= 0) {
        return res.status(400).json({
          message: `No base target found for ${new Date(0, targetMonth - 1).toLocaleString('en-US', { month: 'long' })} ${targetYear}. Please set a company target first.`
        });
      }

      // Step 2: Run hierarchical re-distribution
      // This automatically picks up all current users (including new ones) and 
      // divides the existing totalCompanyTarget equally among the updated hierarchy.
      const result = await rebalanceHierarchyTargetsReplace({
        month: targetMonth,
        year: targetYear,
        totalCompanyTarget: context.totalCompanyTarget,
        partnerFileCountTarget: context.partnerFileCountTarget,
        assignedBy: context.assignedBy || req.user.sub,
      });

      const summary = result.distributionSummary || {};

      // Emit real-time socket updates for all affected users
      if (global.io && result.assignments.length > 0) {
        const { emitTargetUpdatesForDocs } = await import("../utils/targetSocketEmitter.js");
        emitTargetUpdatesForDocs(global.io, result.assignments);
      }

      return res.status(200).json({
        message: "Hierarchy synchronized and new joiners assigned targets.",
        totalNewAssignments: result.assignments.length,
        summary: {
          asmAssigned: summary.asmCount || 0,
          rsmAssigned: summary.rsmCount || 0,
          rmAssigned: summary.rmCount || 0,
          partnerAssigned: summary.partnerCount || 0,
        }
      });
    } catch (err) {
      console.error("Assign New Joiners Error:", err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  }
);

router.post(
  "/target/distribute-hierarchical",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const {
        month,
        year,
        totalCompanyTarget,
        partnerFileCountTarget,
        assignmentMode = "replace",
      } = req.body;

      if (!month || !year) {
        return res.status(400).json({ message: "Month and year are required" });
      }

      if (!totalCompanyTarget || totalCompanyTarget <= 0) {
        return res.status(400).json({
          message: "totalCompanyTarget is required and must be greater than 0"
        });
      }

      // Minimum realistic company target (₹10,00,000 = ₹10 Lakhs)
      const MIN_COMPANY_TARGET = 1000000;
      if (totalCompanyTarget < MIN_COMPANY_TARGET) {
        return res.status(400).json({
          message: `Total Company Target must be at least ₹10,00,000 (₹10 Lakhs). Current value: ₹${Number(totalCompanyTarget).toLocaleString('en-IN')}`
        });
      }

      if (!partnerFileCountTarget || partnerFileCountTarget < 1) {
        return res.status(400).json({
          message: "partnerFileCountTarget is required and must be at least 1"
        });
      }

      if (!["replace", "add"].includes(String(assignmentMode))) {
        return res.status(400).json({
          message: "assignmentMode must be either 'replace' or 'add'",
        });
      }

      const adminId = req.user.sub;
      const targetMonth = Number(month);
      const targetYear = Number(year);
      const totalTarget = Number(totalCompanyTarget);
      const fileCountTarget = Number(partnerFileCountTarget);
      const mode = String(assignmentMode);

      const applyDisbursementByMode = (existingValue, incomingValue) => {
        const existing = Number(existingValue || 0);
        const incoming = Number(incomingValue || 0);
        return mode === "add" ? existing + incoming : incoming;
      };
      const applyFileCountByMode = (existingValue, incomingValue) => {
        // File count target is always an absolute value (set/change), not additive.
        return Number(incomingValue || 0);
      };

      if (targetMonth < 1 || targetMonth > 12) {
        return res.status(400).json({ message: "Invalid month value" });
      }

      const assignments = [];
      const distributionSummary = {
        totalCompanyTarget: totalTarget,
        asmCount: 0,
        rsmCount: 0,
        rmCount: 0,
        partnerCount: 0,
      };

      // Step 1: Get all ASMs
      const asms = await User.find({ role: ROLES.ASM }).lean();

      if (asms.length === 0) {
        return res.status(400).json({ message: "No ASMs found. Please create ASMs first." });
      }

      // Step 2: Divide total target equally among ASMs
      const asmTarget = Math.round(totalTarget / asms.length);
      distributionSummary.asmCount = asms.length;

      for (const asm of asms) {
        // Step 3: Get all RSMs under this ASM
        const rsms = await User.find({ role: ROLES.RSM, asmId: asm._id }).lean();

        if (rsms.length === 0) {
          // If no RSMs, assign entire ASM target to ASM (they can manage directly)
          let asmTargetDoc = await Target.findOne({
            assignedTo: asm._id,
            role: ROLES.ASM,
            month: targetMonth,
            year: targetYear,
          });

          if (asmTargetDoc) {
            const finalAsmTarget = applyDisbursementByMode(
              asmTargetDoc.disbursementTarget || asmTargetDoc.targetValue,
              asmTarget
            );
            asmTargetDoc.disbursementTarget = finalAsmTarget;
            asmTargetDoc.targetValue = finalAsmTarget;
            asmTargetDoc.fileCountTarget = 0;
            asmTargetDoc.assignedBy = adminId;
            asmTargetDoc.isCalculated = true;
            await asmTargetDoc.save();
          } else {
            asmTargetDoc = await Target.create({
              assignedBy: adminId,
              assignedTo: asm._id,
              role: ROLES.ASM,
              month: targetMonth,
              year: targetYear,
              fileCountTarget: 0,
              disbursementTarget: asmTarget,
              targetValue: asmTarget,
              isCalculated: true,
            });
          }
          assignments.push(asmTargetDoc);
          continue;
        }

        // Step 4: Divide ASM target equally among RSMs
        const rsmTarget = Math.round(asmTarget / rsms.length);
        distributionSummary.rsmCount += rsms.length;

        for (const rsm of rsms) {
          // Step 5: Get all RMs under this RSM
          const rms = await User.find({
            role: ROLES.RM,
            $or: [
              { personalRsmId: rsm._id },
              { businessRsmId: rsm._id },
              { homeLapRsmId: rsm._id },
              { businessHomeRsmId: rsm._id }
            ]
          }).lean();

          // Remove duplicates (RMs can have both personalRsmId and businessHomeRsmId)
          const uniqueRms = rms.filter((rm, index, self) =>
            index === self.findIndex((r) => r._id.toString() === rm._id.toString())
          );

          if (uniqueRms.length === 0) {
            // If no RMs, assign entire RSM target to RSM
            let rsmTargetDoc = await Target.findOne({
              assignedTo: rsm._id,
              role: ROLES.RSM,
              month: targetMonth,
              year: targetYear,
            });

            if (rsmTargetDoc) {
              const finalRsmTarget = applyDisbursementByMode(
                rsmTargetDoc.disbursementTarget || rsmTargetDoc.targetValue,
                rsmTarget
              );
              rsmTargetDoc.disbursementTarget = finalRsmTarget;
              rsmTargetDoc.targetValue = finalRsmTarget;
              rsmTargetDoc.fileCountTarget = 0;
              rsmTargetDoc.assignedBy = adminId;
              rsmTargetDoc.isCalculated = true;
              await rsmTargetDoc.save();
            } else {
              rsmTargetDoc = await Target.create({
                assignedBy: adminId,
                assignedTo: rsm._id,
                role: ROLES.RSM,
                month: targetMonth,
                year: targetYear,
                fileCountTarget: 0,
                disbursementTarget: rsmTarget,
                targetValue: rsmTarget,
                isCalculated: true,
              });
            }
            assignments.push(rsmTargetDoc);
            continue;
          }

          // Step 6: Divide RSM target equally among RMs
          const rmTarget = Math.round(rsmTarget / uniqueRms.length);
          distributionSummary.rmCount += uniqueRms.length;

          for (const rm of uniqueRms) {
            // Step 7: Get all Partners under this RM
            const partners = await User.find({
              role: ROLES.PARTNER,
              rmId: rm._id,
            }).lean();

            if (partners.length === 0) {
              // If no partners, assign entire RM target to RM
              let rmTargetDoc = await Target.findOne({
                assignedTo: rm._id,
                role: ROLES.RM,
                month: targetMonth,
                year: targetYear,
              });

              if (rmTargetDoc) {
                const finalRmTarget = applyDisbursementByMode(
                  rmTargetDoc.disbursementTarget || rmTargetDoc.targetValue,
                  rmTarget
                );
                rmTargetDoc.disbursementTarget = finalRmTarget;
                rmTargetDoc.targetValue = finalRmTarget;
                rmTargetDoc.fileCountTarget = 0;
                rmTargetDoc.assignedBy = adminId;
                rmTargetDoc.isCalculated = true;
                await rmTargetDoc.save();
              } else {
                rmTargetDoc = await Target.create({
                  assignedBy: adminId,
                  assignedTo: rm._id,
                  role: ROLES.RM,
                  month: targetMonth,
                  year: targetYear,
                  fileCountTarget: 0,
                  disbursementTarget: rmTarget,
                  targetValue: rmTarget,
                  isCalculated: true,
                });
              }
              assignments.push(rmTargetDoc);
              continue;
            }

            // Step 8: Divide RM target equally among Partners
            const partnerDisbursementTarget = Math.round(rmTarget / partners.length);
            distributionSummary.partnerCount += partners.length;

            for (const partner of partners) {
              // Step 9: Assign target to Partner (both file count and disbursement)
              let partnerTarget = await Target.findOne({
                assignedTo: partner._id,
                role: ROLES.PARTNER,
                month: targetMonth,
                year: targetYear,
              });

              if (partnerTarget) {
                const finalPartnerDisbursement = applyDisbursementByMode(
                  partnerTarget.disbursementTarget || partnerTarget.targetValue,
                  partnerDisbursementTarget
                );
                const finalPartnerFileCount = applyFileCountByMode(
                  partnerTarget.fileCountTarget,
                  fileCountTarget
                );
                partnerTarget.fileCountTarget = finalPartnerFileCount;
                partnerTarget.disbursementTarget = finalPartnerDisbursement;
                partnerTarget.targetValue = finalPartnerDisbursement;
                partnerTarget.assignedBy = adminId;
                partnerTarget.isCalculated = false;
                await partnerTarget.save();
              } else {
                partnerTarget = await Target.create({
                  assignedBy: adminId,
                  assignedTo: partner._id,
                  role: ROLES.PARTNER,
                  month: targetMonth,
                  year: targetYear,
                  fileCountTarget: fileCountTarget,
                  disbursementTarget: partnerDisbursementTarget,
                  targetValue: partnerDisbursementTarget,
                  isCalculated: false,
                });
              }
              assignments.push(partnerTarget);
            }

            // Step 10: Assign target to RM (disbursement only - sum of partner targets)
            const rmActualTarget = partnerDisbursementTarget * partners.length;
            let rmTargetDoc = await Target.findOne({
              assignedTo: rm._id,
              role: ROLES.RM,
              month: targetMonth,
              year: targetYear,
            });

            if (rmTargetDoc) {
              const finalRmActualTarget = applyDisbursementByMode(
                rmTargetDoc.disbursementTarget || rmTargetDoc.targetValue,
                rmActualTarget
              );
              rmTargetDoc.disbursementTarget = finalRmActualTarget;
              rmTargetDoc.targetValue = finalRmActualTarget;
              rmTargetDoc.fileCountTarget = 0;
              rmTargetDoc.assignedBy = adminId;
              rmTargetDoc.isCalculated = true;
              await rmTargetDoc.save();
            } else {
              rmTargetDoc = await Target.create({
                assignedBy: adminId,
                assignedTo: rm._id,
                role: ROLES.RM,
                month: targetMonth,
                year: targetYear,
                fileCountTarget: 0,
                disbursementTarget: rmActualTarget,
                targetValue: rmActualTarget,
                isCalculated: true,
              });
            }
            assignments.push(rmTargetDoc);
          }

          // Step 11: Assign target to RSM (disbursement only - sum of RM targets)
          const rsmActualTarget = rmTarget * uniqueRms.length;
          let rsmTargetDoc = await Target.findOne({
            assignedTo: rsm._id,
            role: ROLES.RSM,
            month: targetMonth,
            year: targetYear,
          });

          if (rsmTargetDoc) {
            const finalRsmActualTarget = applyDisbursementByMode(
              rsmTargetDoc.disbursementTarget || rsmTargetDoc.targetValue,
              rsmActualTarget
            );
            rsmTargetDoc.disbursementTarget = finalRsmActualTarget;
            rsmTargetDoc.targetValue = finalRsmActualTarget;
            rsmTargetDoc.fileCountTarget = 0;
            rsmTargetDoc.assignedBy = adminId;
            rsmTargetDoc.isCalculated = true;
            await rsmTargetDoc.save();
          } else {
            rsmTargetDoc = await Target.create({
              assignedBy: adminId,
              assignedTo: rsm._id,
              role: ROLES.RSM,
              month: targetMonth,
              year: targetYear,
              fileCountTarget: 0,
              disbursementTarget: rsmActualTarget,
              targetValue: rsmActualTarget,
              isCalculated: true,
            });
          }
          assignments.push(rsmTargetDoc);
        }

        // Step 12: Assign target to ASM (disbursement only - sum of RSM targets)
        const asmActualTarget = rsmTarget * rsms.length;
        let asmTargetDoc = await Target.findOne({
          assignedTo: asm._id,
          role: ROLES.ASM,
          month: targetMonth,
          year: targetYear,
        });

        if (asmTargetDoc) {
          const finalAsmActualTarget = applyDisbursementByMode(
            asmTargetDoc.disbursementTarget || asmTargetDoc.targetValue,
            asmActualTarget
          );
          asmTargetDoc.disbursementTarget = finalAsmActualTarget;
          asmTargetDoc.targetValue = finalAsmActualTarget;
          asmTargetDoc.fileCountTarget = 0;
          asmTargetDoc.assignedBy = adminId;
          asmTargetDoc.isCalculated = true;
          await asmTargetDoc.save();
        } else {
          asmTargetDoc = await Target.create({
            assignedBy: adminId,
            assignedTo: asm._id,
            role: ROLES.ASM,
            month: targetMonth,
            year: targetYear,
            fileCountTarget: 0,
            disbursementTarget: asmActualTarget,
            targetValue: asmActualTarget,
            isCalculated: true,
          });
        }
        assignments.push(asmTargetDoc);
      }

      emitTargetUpdatesForDocs(global.io, assignments);

      res.status(201).json({
        message:
          mode === "add"
            ? "Top-down hierarchical targets added successfully"
            : "Top-down hierarchical targets distributed successfully",
        month: targetMonth,
        year: targetYear,
        assignmentMode: mode,
        totalCompanyTarget: totalTarget,
        partnerFileCountTarget: fileCountTarget,
        distributionSummary,
        totalAssignments: assignments.length,
        assignments: assignments.map((t) => ({
          role: t.role,
          assignedTo: t.assignedTo,
          fileCountTarget: t.fileCountTarget,
          disbursementTarget: t.disbursementTarget,
          isCalculated: t.isCalculated,
        })),
      });
    } catch (err) {
      console.error("Top-down hierarchical target distribution error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// --- Referral reward amounts (Super Admin; stored in Config) ---

router.get(
  "/referral-reward-amounts",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { Config } = await import("../models/Config.js");
      const doc = await Config.findOne({ key: "REFERRAL_REWARD_AMOUNTS" }).lean();
      const amounts = await getReferralRewardAmounts();
      res.json({
        disbursedReward: amounts.disbursedReward,
        signupReward: amounts.signupReward,
        savedInDatabase: amounts.savedInDatabase,
        savedValue: doc?.value && typeof doc.value === "object" ? doc.value : null,
      });
    } catch (err) {
      console.error("referral-reward-amounts GET:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

router.put(
  "/referral-reward-amounts",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const current = await getReferralRewardAmounts();
      const dRaw = req.body?.disbursedReward;
      const sRaw = req.body?.signupReward;

      const disbursedReward =
        dRaw === undefined || dRaw === null || dRaw === ""
          ? current.disbursedReward
          : Number(dRaw);
      const signupReward =
        sRaw === undefined || sRaw === null || sRaw === ""
          ? current.signupReward
          : Number(sRaw);

      if (!Number.isFinite(disbursedReward) || disbursedReward <= 0) {
        return res.status(400).json({
          message: "disbursedReward must be a positive number (INR)",
        });
      }
      if (!Number.isFinite(signupReward) || signupReward <= 0) {
        return res.status(400).json({
          message: "signupReward must be a positive number (INR)",
        });
      }

      const { Config } = await import("../models/Config.js");
      const payload = { disbursedReward, signupReward };
      let doc = await Config.findOne({ key: "REFERRAL_REWARD_AMOUNTS" });
      if (doc) {
        doc.value = payload;
        await doc.save();
      } else {
        await Config.create({
          key: "REFERRAL_REWARD_AMOUNTS",
          value: payload,
        });
      }

      // Instantly sync referral settings to mobile & web apps
      if (global.io) {
        global.io.emit("referralRewardAmountsUpdated", {
          disbursedReward,
          signupReward,
          timestamp: Date.now(),
        });
        global.io.emit("referralUpdated", { timestamp: Date.now() });
        global.io.emit("dashboardUpdate", { type: "referralRewardAmounts" });
      }

      res.json({
        message: "Referral reward amounts updated",
        disbursedReward,
        signupReward,
      });
    } catch (err) {
      console.error("referral-reward-amounts PUT:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

// --- Referral rewards (admin) — same lifecycle as incentives: PENDING → APPROVED → PAID ---

router.get(
  "/referral-rewards/summary",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const agg = await ReferralReward.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            totalAmount: { $sum: "$amount" },
          },
        },
      ]);
      const byStatus = {
        PENDING: { count: 0, totalAmount: 0 },
        APPROVED: { count: 0, totalAmount: 0 },
        PAID: { count: 0, totalAmount: 0 },
        CANCELLED: { count: 0, totalAmount: 0 },
      };
      for (const row of agg) {
        if (row._id && byStatus[row._id] != null) {
          byStatus[row._id] = {
            count: row.count,
            totalAmount: row.totalAmount || 0,
          };
        }
      }
      res.json({ byStatus });
    } catch (err) {
      console.error("admin referral-rewards summary:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

router.get(
  "/referral-rewards",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const skip = (page - 1) * limit;
      const filter = {};
      if (req.query.status && ["PENDING", "APPROVED", "PAID", "CANCELLED"].includes(req.query.status)) {
        filter.status = req.query.status;
      }
      if (req.query.eventType && ["SIGNUP", "DISBURSED"].includes(req.query.eventType)) {
        filter.eventType = req.query.eventType;
      }
      if (req.query.referrerId && mongoose.Types.ObjectId.isValid(req.query.referrerId)) {
        filter.referrerId = req.query.referrerId;
      }

      const [items, total] = await Promise.all([
        ReferralReward.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate("referrerId", "firstName lastName email phone referralCode employeeId role partnerCode")
          .populate(
            "referredUserId",
            "firstName lastName email phone employeeId partnerCode role"
          )
          .populate("applicationId", "appNo status loanType approvedLoanAmount")
          .populate("approvedBy", "firstName lastName email")
          .populate("paidBy", "firstName lastName email")
          .lean(),
        ReferralReward.countDocuments(filter),
      ]);

      res.json({
        rewards: items,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      });
    } catch (err) {
      console.error("admin referral-rewards list:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

router.patch(
  "/referral-rewards/:id",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const reward = await ReferralReward.findById(req.params.id);
      if (!reward) return res.status(404).json({ message: "Reward not found" });
      if (!["PENDING", "APPROVED"].includes(reward.status)) {
        return res.status(400).json({
          message: "Can only edit when status is PENDING or APPROVED",
        });
      }
      if (req.body?.amount != null) {
        const amt = Number(req.body.amount);
        if (!Number.isFinite(amt) || amt <= 0) {
          return res.status(400).json({ message: "amount must be a positive number" });
        }
        reward.amount = amt;
      }
      if (req.body?.note != null) reward.note = String(req.body.note).trim();
      await reward.save();
      res.json({ message: "Referral reward updated", reward });
    } catch (err) {
      console.error("admin referral reward PATCH:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

router.patch(
  "/referral-rewards/:id/approve",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const adminId = req.user.sub;
      const reward = await ReferralReward.findById(req.params.id);
      if (!reward) return res.status(404).json({ message: "Reward not found" });
      if (reward.status !== "PENDING") {
        return res.status(400).json({ message: `Cannot approve reward with status ${reward.status}` });
      }
      reward.status = "APPROVED";
      reward.approvedAt = new Date();
      reward.approvedBy = adminId;
      if (req.body?.note) reward.note = String(req.body.note).trim();
      await reward.save();
      res.json({ message: "Referral reward approved", reward });
    } catch (err) {
      console.error("admin referral approve:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

router.patch(
  "/referral-rewards/:id/pay",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const adminId = req.user.sub;
      const reward = await ReferralReward.findById(req.params.id);
      if (!reward) return res.status(404).json({ message: "Reward not found" });
      if (reward.status === "PAID") {
        return res.status(400).json({ message: "Reward already paid" });
      }
      if (reward.status === "CANCELLED") {
        return res.status(400).json({ message: "Cannot pay a cancelled reward" });
      }
      if (reward.status !== "APPROVED") {
        return res.status(400).json({
          message: "Approve this reward first, then mark as paid (like payouts/incentives).",
        });
      }
      reward.status = "PAID";
      reward.paidAt = new Date();
      reward.paidBy = adminId;
      if (req.body?.paymentReference != null) {
        reward.paymentReference = String(req.body.paymentReference).trim();
      }
      if (req.body?.note) reward.note = String(req.body.note).trim();

      await reward.save();

      if (reward.eventType === "DISBURSED" && reward.referredUserId) {
        await User.findByIdAndUpdate(reward.referredUserId, {
          referralRewardStatus: "PAID",
        });
      }

      res.json({ message: "Referral reward marked as paid", reward });
    } catch (err) {
      console.error("admin referral pay:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

router.patch(
  "/referral-rewards/:id/cancel",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const reward = await ReferralReward.findById(req.params.id);
      if (!reward) return res.status(404).json({ message: "Reward not found" });
      if (reward.status === "PAID") {
        return res.status(400).json({ message: "Cannot cancel a paid reward" });
      }
      if (reward.status === "CANCELLED") {
        return res.status(400).json({ message: "Already cancelled" });
      }
      if (!["PENDING", "APPROVED"].includes(reward.status)) {
        return res.status(400).json({ message: `Cannot cancel from status ${reward.status}` });
      }
      reward.status = "CANCELLED";
      if (req.body?.note) reward.note = String(req.body.note).trim();
      await reward.save();

      if (reward.eventType === "DISBURSED" && reward.referredUserId) {
        await User.findByIdAndUpdate(reward.referredUserId, {
          referralRewardStatus: "NONE",
          referralRewardAt: null,
        });
      }

      res.json({ message: "Referral reward cancelled", reward });
    } catch (err) {
      console.error("admin referral cancel:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

// ─── Partner withdraw requests (Admin pay after ASM approval) ───────────────

router.get(
  "/withdrawals",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const status = String(req.query.status || "PENDING_ADMIN").trim();
      const filter = {};
      if (status && status !== "ALL") filter.status = status;

      const list = await WithdrawalRequest.find(filter)
        .populate(
          "partnerId",
          "firstName lastName email phone employeeId partnerCode asmId bankName accountNumber ifscCode accountHolderName"
        )
        .populate("asmId", "firstName lastName employeeId")
        .sort({ createdAt: -1 })
        .lean();

      return res.json({ success: true, data: list });
    } catch (err) {
      console.error("Admin withdrawals list:", err);
      return res.status(500).json({ message: "Failed to load withdrawals" });
    }
  }
);

router.post(
  "/withdrawals/:id/pay",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const adminId = req.user.sub;
      const doc = await WithdrawalRequest.findOne({
        _id: req.params.id,
        status: "PENDING_ADMIN",
      });
      if (!doc) {
        return res.status(404).json({ message: "Withdraw request not found or not awaiting Admin" });
      }

      const settled = await settlePendingEarnings(doc.partnerId, doc.amount, adminId);
      doc.status = "PAID";
      doc.reviewedByAdmin = adminId;
      doc.adminReviewedAt = new Date();
      doc.settledPayoutIds = settled.settledPayoutIds || [];
      doc.settledIncentiveIds = settled.settledIncentiveIds || [];
      await doc.save();

      try {
        await createNotification(String(doc.partnerId), {
          type: "payout",
          title: "Withdraw paid",
          message: `Your withdraw of ₹${Number(doc.amount).toLocaleString("en-IN")} has been paid.`,
          data: { withdrawalId: String(doc._id), status: doc.status },
        });
      } catch (_) {}

      return res.json({
        success: true,
        message: "Withdraw marked as paid and pending earnings settled.",
        data: doc,
      });
    } catch (err) {
      console.error("Admin withdraw pay:", err);
      return res.status(500).json({ message: "Failed to pay withdraw" });
    }
  }
);

router.post(
  "/withdrawals/:id/reject",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const adminId = req.user.sub;
      const reason = String(req.body?.reason || req.body?.rejectReason || "").trim();
      const doc = await WithdrawalRequest.findOne({
        _id: req.params.id,
        status: "PENDING_ADMIN",
      });
      if (!doc) {
        return res.status(404).json({ message: "Withdraw request not found or not awaiting Admin" });
      }
      doc.status = "REJECTED";
      doc.rejectReason = reason || "Rejected by Admin";
      doc.reviewedByAdmin = adminId;
      doc.adminReviewedAt = new Date();
      await doc.save();

      try {
        await createNotification(String(doc.partnerId), {
          type: "payout",
          title: "Withdraw rejected by Admin",
          message: `Your withdraw request of ₹${Number(doc.amount).toLocaleString("en-IN")} was rejected${reason ? `: ${reason}` : "."}`,
          data: { withdrawalId: String(doc._id), status: doc.status },
        });
      } catch (_) {}

      return res.json({ success: true, message: "Withdraw rejected", data: doc });
    } catch (err) {
      console.error("Admin withdraw reject:", err);
      return res.status(500).json({ message: "Failed to reject withdraw" });
    }
  }
);

// POST /api/admin/evaluate-partner-performance
router.post(
  "/evaluate-partner-performance",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  async (req, res) => {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1; // current month
      
      const partners = await User.find({ role: ROLES.PARTNER, status: "ACTIVE" });
      
      let highestDisbursement = 0;
      let topPartnerId = null;

      for (const partner of partners) {
        const target = await Target.findOne({ 
          assignedTo: partner._id,
          month: month,
          year: year
        });
        
        const achievedAmount = target ? target.achievedDisbursement : 0;
        const achievedFiles = target ? target.achievedFileCount : 0;

        // Determine Level based on active incentive slabs
        const activeSlabs = await getActiveIncentiveSlabs();
        const milestoneResult = calculatePartnerMilestone(achievedAmount, activeSlabs);
        const newLevel = milestoneResult.tier ? milestoneResult.tier.toUpperCase().replace(/\s+/g, "_") : "BRONZE";
        
        if (achievedAmount > highestDisbursement) {
          highestDisbursement = achievedAmount;
          topPartnerId = partner._id;
        }

        partner.partnerLevel = newLevel;
        partner.isPartnerOfTheMonth = false;

        // Target increase logic
        if (target && target.disbursementTarget > 0) {
          const percentAchieved = (achievedAmount / target.disbursementTarget) * 100;
          if (percentAchieved >= 100) {
            target.disbursementTarget = Math.floor(target.disbursementTarget * 1.2); // 20% increase
          }
          await target.save();
        }

        await partner.save();
      }

      if (topPartnerId) {
        await User.findByIdAndUpdate(topPartnerId, { isPartnerOfTheMonth: true });
      }

      return res.json({ success: true, message: "Performance evaluated successfully" });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Performance evaluation failed" });
    }
  }
);

// PUT /api/admin/partner/:id - Admin update partner details (CRUD)
router.put("/partner/:id", auth, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      firstName,
      lastName,
      phone,
      email,
      aadharNumber,
      panNumber,
      address,
      officeAddress,
      residenceAddress,
      region,
      city,
      state,
      pincode,
    } = req.body;

    const updateFields = {};
    if (firstName !== undefined) updateFields.firstName = firstName;
    if (lastName !== undefined) updateFields.lastName = lastName;
    if (phone !== undefined) updateFields.phone = phone;
    if (email !== undefined) updateFields.email = email;
    if (aadharNumber !== undefined) updateFields.aadharNumber = aadharNumber;
    if (panNumber !== undefined) updateFields.panNumber = panNumber;
    if (address !== undefined) updateFields.address = address;
    if (officeAddress !== undefined) updateFields.officeAddress = officeAddress;
    if (residenceAddress !== undefined) updateFields.residenceAddress = residenceAddress;
    if (region !== undefined) updateFields.region = region;
    if (city !== undefined) updateFields.city = city;
    if (state !== undefined) updateFields.state = state;
    if (pincode !== undefined) updateFields.pincode = pincode;

    const partner = await User.findByIdAndUpdate(id, updateFields, { new: true }).select("-password");
    if (!partner) {
      return res.status(404).json({ message: "Partner not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Partner details updated successfully",
      partner,
    });
  } catch (error) {
    console.error("Admin update partner error:", error);
    return res.status(500).json({ message: error.message || "Failed to update partner details" });
  }
});

// ==========================================
// ADMIN: CHANGE/RESET PASSWORD FOR ANY USER
// ==========================================
router.post(
  ["/users/:id/change-password", "/change-user-password"],
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const id = req.params.id || req.body.userId || req.body.id;
      const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
      const { newPassword, confirmPassword } = req.body;

      if (!newPassword) {
        return res.status(400).json({ message: "New password is required" });
      }

      if (String(newPassword).length < 6) {
        return res
          .status(400)
          .json({ message: "Password must be at least 6 characters long" });
      }

      if (confirmPassword && newPassword !== confirmPassword) {
        return res.status(400).json({ message: "Passwords do not match" });
      }

      let user = null;
      if (id && mongoose.Types.ObjectId.isValid(id)) {
        user = await User.findById(id);
      }
      if (!user && email) {
        user = await User.findOne({ email });
      }

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      user.passwordHash = await argon2.hash(String(newPassword));
      if (user.tempPassword) {
        user.tempPassword = undefined;
      }
      await user.save();

      // Best effort email notification
      try {
        if (user.email) {
          await sendMail({
            to: user.email,
            subject: "Your DhanSource Account Password Has Been Updated",
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
                <h2 style="color: #0d9d84;">Password Updated</h2>
                <p>Hello ${user.firstName || "User"},</p>
                <p>Your password for your DhanSource account (<strong>${user.email}</strong>) has been successfully updated by the system administrator.</p>
                <p>You can now log in using your updated credentials.</p>
                <p>If you did not expect this change, please contact DhanSource Admin Support immediately.</p>
                <br/>
                <p style="color: #666; font-size: 12px;">DhanSource Team</p>
              </div>
            `,
          });
        }
      } catch (mailErr) {
        console.warn("Could not send password change notification email:", mailErr.message);
      }

      return res.status(200).json({
        success: true,
        message: `Password updated successfully for ${user.firstName || ""} ${user.lastName || ""} (${user.role})`.trim(),
      });
    } catch (error) {
      console.error("Admin change user password error:", error);
      return res
        .status(500)
        .json({ message: error.message || "Failed to update user password" });
    }
  }
);

// ==================== CUSTOMER SUPPORT SETTINGS ====================

router.get(
  "/support-settings",
  auth,
  requireRole(ROLES.ADMIN, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const settings = await getSupportSettings();
      return res.json({
        success: true,
        settings,
      });
    } catch (err) {
      console.error("GET /admin/support-settings error:", err);
      return res.status(500).json({ message: err.message || "Failed to fetch support settings" });
    }
  }
);

router.put(
  "/support-settings",
  auth,
  requireRole(ROLES.ADMIN, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { phone, email, whatsapp, hours } = req.body || {};
      const updated = await saveSupportSettings({ phone, email, whatsapp, hours });

      if (global.io) {
        global.io.emit("supportSettingsUpdated", {
          settings: updated,
          timestamp: Date.now(),
        });
      }

      return res.json({
        success: true,
        message: "Customer support contact settings updated successfully",
        settings: updated,
      });
    } catch (err) {
      console.error("PUT /admin/support-settings error:", err);
      return res.status(400).json({ message: err.message || "Failed to update support settings" });
    }
  }
);

export default router;
