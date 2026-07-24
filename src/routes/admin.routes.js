import { Router } from "express";
import argon2 from "argon2";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES, RSM_TYPES } from "../config/roles.js";
import { assertValidRmRsmPair } from "../utils/rmRsmHierarchy.js";
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
import { ReferralReward } from "../models/ReferralReward.js";
import { WithdrawalRequest } from "../models/WithdrawalRequest.js";
import { settlePendingEarnings } from "../utils/walletBalance.js";
import { BankMaster } from "../models/BankMaster.js";
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
  sendDocumentStatusEmail
} from "../utils/emailService.js";
import { sendPayoutEmail } from "../utils/emailService.js";
import { sendIncentiveEmail } from "../utils/emailService.js";
import { emitPayoutStatusChanged, emitIncentiveStatusChanged } from "../utils/socketEmitter.js";
import { emitTargetUpdatedForDoc, emitTargetUpdatesForDocs } from "../utils/targetSocketEmitter.js";
import { createEmailChangeRequest } from "../utils/emailChangeService.js";
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
      const isHomeLoan = (lt) => normalizeLoanType(lt).startsWith("HOME_LOAN_");

      if (normalizedRsmTypes.length) {
        const hasPersonal = normalizedRsmTypes.includes(RSM_TYPES.PERSONAL);
        const hasBusinessHome = normalizedRsmTypes.includes(RSM_TYPES.BUSINESS_HOME);

        // If both are selected, admin explicitly wants both groups → allow any loanType.
        if (hasPersonal && !hasBusinessHome && !isPersonal(normalizedLoanType)) {
          return res.status(400).json({
            message: `Invalid loanType for rsmTypes=PERSONAL. Expected PERSONAL but got "${loanType}".`,
          });
        }

        if (
          hasBusinessHome &&
          !hasPersonal &&
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
            parsedPincodes = parsed.map(p => String(p).trim());
          }
        } catch (e) {
          // If not JSON array, try comma-separated
          if (typeof serviceablePincodes === 'string') {
            parsedPincodes = serviceablePincodes.split(',').map(p => String(p).trim()).filter(Boolean);
          }
        }
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

router.post(
  "/create-asm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res, next) => {
    try {
      const { firstName, lastName, phone, email, dob, joinDate, region, password } =
        req.body || {};

      if (!firstName || !lastName || !email || !phone) {
        return res.status(400).json({ message: "name and email required" });
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

      const rawPassword =
        password || `Asm@${Math.random().toString(36).slice(2, 10)}`;

      const asm = await User.create({
        firstName,
        lastName,
        phone: normalizedPhone,
        email: email.toLowerCase(),
        passwordHash: await argon2.hash(rawPassword),
        role: ROLES.ASM,
        employeeId: await generateEmployeeId("ASM"),
        asmCode: makeAsmCode(),
        dob,
        joinDate: joinDate ? new Date(joinDate) : new Date(),
        region,
        adminId: req.user.sub, // link to the admin creating ASM
      });

      // 📧 Send credentials mail using professional email service
      try {
        const emailSent = await sendUserAccountEmail(asm, "ASM", rawPassword, {
          firstName: req.user.firstName || "Admin",
          lastName: req.user.lastName || "",
        });
        if (emailSent) {
          console.log(`✅ ASM creation email sent to: ${email}`);
        }
      } catch (mailErr) {
        console.error("❌ Failed to send ASM creation email:", mailErr.message);
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
        message: "ASM created and targets redistributed",
        id: asm._id,
        asmCode: asm.asmCode,
        employeeId: asm.employeeId,
        region: asm.region,
        dob: asm.dob,
        tempPassword: password ? undefined : rawPassword,
      });
    } catch (err) {
      console.error("Create ASM Error:", err);
      // Let global error handler convert duplicate-key and other errors properly.
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
        personalRsmId,
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

      if (!personalRsmId || !businessHomeRsmId) {
        return res.status(400).json({
          message: "Both personalRsmId and businessHomeRsmId are required",
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

      // Check if Personal RSM exists and is of correct type
      const personalRsm = await User.findOne({
        _id: personalRsmId,
        role: ROLES.RSM,
        rsmType: RSM_TYPES.PERSONAL
      });
      if (!personalRsm) {
        return res.status(404).json({
          message: "Personal Loan RSM not found or invalid type"
        });
      }

      // Check if Business/Home RSM exists and is of correct type
      const businessHomeRsm = await User.findOne({
        _id: businessHomeRsmId,
        role: ROLES.RSM,
        rsmType: RSM_TYPES.BUSINESS_HOME
      });
      if (!businessHomeRsm) {
        return res.status(404).json({
          message: "Business & Home Loan RSM not found or invalid type"
        });
      }

      // Both RSMs should be under the same ASM
      if (personalRsm.asmId.toString() !== businessHomeRsm.asmId.toString()) {
        return res.status(400).json({
          message: "Both RSMs must be under the same ASM",
        });
      }

      const pairCheck = await assertValidRmRsmPair(
        personalRsm._id,
        businessHomeRsm._id
      );
      if (!pairCheck.ok) {
        return res.status(400).json({ message: pairCheck.message });
      }

      const rawPassword =
        password || `Rm@${Math.random().toString(36).slice(2, 10)}`;

      // Get ASM for region inheritance
      const asm = await User.findById(personalRsm.asmId);

      // Create RM
      const rm = await User.create({
        employeeId: await generateEmployeeId("RM"),
        firstName,
        lastName,
        phone: normalizedPhone,
        region: region || asm?.region || "N/A", // Use provided region or inherit from ASM
        email: email.toLowerCase(),
        passwordHash: await argon2.hash(rawPassword),
        role: ROLES.RM,
        rmCode: makeRmCode(),
        asmId: personalRsm.asmId, // link to ASM (inherited from RSM)
        personalRsmId: personalRsm._id, // link to Personal Loan RSM
        businessHomeRsmId: businessHomeRsm._id, // link to Business/Home Loan RSM
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

// Create RSM (Admin only) - moved from /api/rsm/create-rsm
router.post(
  "/create-rsm",
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
        asmId,
        rsmType,
      } = req.body || {};

      if (!firstName || !lastName || !email || !phone || !rsmType || !asmId) {
        return res.status(400).json({
          message:
            "firstName, lastName, email, phone, asmId and rsmType are required",
        });
      }

      if (!Object.values(RSM_TYPES).includes(rsmType)) {
        return res.status(400).json({
          message: `Invalid rsmType. Allowed: ${Object.values(RSM_TYPES).join(
            ", "
          )}`,
        });
      }

      // Check if ASM exists
      const asm = await User.findOne({ _id: asmId, role: ROLES.ASM });
      if (!asm) return res.status(404).json({ message: "ASM not found" });

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
        password || `Rsm@${Math.random().toString(36).slice(2, 10)}`;

      const rsm = await User.create({
        firstName,
        lastName,
        phone,
        email: email.toLowerCase(),
        passwordHash: await argon2.hash(rawPassword),
        role: ROLES.RSM,
        employeeId: await generateEmployeeId("RSM"),
        dob,
        joinDate: joinDate ? new Date(joinDate) : new Date(),
        region: asm.region || region,
        asmId: asm._id,
        rsmType,
      });

      // Send credentials email
      try {
        const emailSent = await sendUserAccountEmail(
          rsm,
          "RSM",
          password ? null : rawPassword,
          {
            firstName: req.user.firstName || "Admin",
            lastName: req.user.lastName || "",
          }
        );
        if (emailSent) {
          console.log(`✅ RSM creation email sent to: ${email}`);
        }
      } catch (mailErr) {
        console.error(
          "❌ Failed to send RSM creation email:",
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
        message: "RSM created successfully",
        id: rsm._id,
        employeeId: rsm.employeeId,
        rsmType: rsm.rsmType,
        asmId: rsm.asmId,
        tempPassword: password ? undefined : rawPassword,
      });
    } catch (err) {
      console.error("Create RSM Error:", err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  }
);

router.get(
  "/get-rm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const list = await User.find({ role: ROLES.RM })
        .select("-passwordHash -__v") // hide password & __v
        .populate({
          path: "asmId",
          select: "firstName lastName employeeId",
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

      // Flatten asm and RSM details into same object
      const formatted = list.map((rm) => {
        const asm = rm.asmId;
        const personalRsm = rm.personalRsmId;
        const businessHomeRsm = rm.businessHomeRsmId;

        // Store original IDs before destructuring
        const originalPersonalRsmId = typeof rm.personalRsmId === 'object' && rm.personalRsmId?._id
          ? rm.personalRsmId._id
          : rm.personalRsmId;
        const originalBusinessHomeRsmId = typeof rm.businessHomeRsmId === 'object' && rm.businessHomeRsmId?._id
          ? rm.businessHomeRsmId._id
          : rm.businessHomeRsmId;

        // Extract base RM data without populated objects
        const {
          asmId: _asmId,
          personalRsmId: _personalRsmId,
          businessHomeRsmId: _businessHomeRsmId,
          ...rmBase
        } = rm;

        return {
          ...rmBase,
          asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
          asmEmployeeId: asm ? asm.employeeId : null,
          asmId: asm ? asm._id : null, // use _id, not asmId
          // Personal Loan RSM details
          personalRsmId: personalRsm ? personalRsm._id : originalPersonalRsmId || null,
          personalRsmName: personalRsm ? `${personalRsm.firstName} ${personalRsm.lastName}` : null,
          personalRsmEmployeeId: personalRsm ? personalRsm.employeeId : null,
          personalRsmPhone: personalRsm ? personalRsm.phone : null,
          personalRsmEmail: personalRsm ? personalRsm.email : null,
          // Business & Home Loan RSM details
          businessHomeRsmId: businessHomeRsm ? businessHomeRsm._id : originalBusinessHomeRsmId || null,
          businessHomeRsmName: businessHomeRsm ? `${businessHomeRsm.firstName} ${businessHomeRsm.lastName}` : null,
          businessHomeRsmEmployeeId: businessHomeRsm ? businessHomeRsm.employeeId : null,
          businessHomeRsmPhone: businessHomeRsm ? businessHomeRsm.phone : null,
          businessHomeRsmEmail: businessHomeRsm ? businessHomeRsm.email : null,
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Error fetching RMs" });
    }
  }
);

// List all RSMs (Admin)
router.get(
  "/get-rsm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const list = await User.find({ role: ROLES.RSM })
        .select("-passwordHash -__v")
        .populate({
          path: "asmId",
          select: "firstName lastName employeeId",
        })
        .lean();

      const formatted = list.map((rsm) => {
        const asm = rsm.asmId;
        return {
          _id: rsm._id,
          firstName: rsm.firstName,
          lastName: rsm.lastName,
          email: rsm.email,
          phone: rsm.phone,
          employeeId: rsm.employeeId,
          rsmType: rsm.rsmType || null, // Explicitly include rsmType
          region: rsm.region,
          status: rsm.status,
          createdAt: rsm.createdAt,
          updatedAt: rsm.updatedAt,
          asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
          asmEmployeeId: asm ? asm.employeeId : null,
          asmId: asm ? asm._id : null,
        };
      });

      console.log("RSMs fetched:", formatted.length, "RSMs with types:", formatted.map(r => ({ name: `${r.firstName} ${r.lastName}`, type: r.rsmType })));
      res.json(formatted);
    } catch (err) {
      console.error("Error fetching RSMs:", err);
      res.status(500).json({ message: "Error fetching RSMs" });
    }
  }
);

// List all ASMs (Admin)
router.get(
  "/get-asm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const list = await User.find({ role: ROLES.ASM })
      .select("-passwordHash")
      .lean();
    res.json(list);
  }
);

router.get(
  "/get-partners",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      // PENDING = awaiting admin verification / RM assignment — listed only via
      // GET /admin/get-unassigned-partners (RM Partner screen), not the main directory.
      const list = await User.find({
        role: ROLES.PARTNER,
        status: { $ne: "PENDING" },
      })
        .select("-passwordHash -__v")
        .populate({
          path: "rmId", // populate RM details
          select: "firstName lastName employeeId asmId",
          populate: {
            path: "asmId", // populate ASM details if hierarchy goes higher
            select: "firstName lastName employeeId",
          },
        })
        .lean();

      const formatted = list.map((partner) => {
        const rm = partner.rmId;
        const asm = rm?.asmId;

        // Remove nested objects to flatten hierarchy
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

// GET /get-customers?customerId=xxxx
router.get(
  "/get-customers",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { customerId } = req.query; // get customerId from query

      // Build the query
      const query = customerId ? { customerId } : {}; // if no customerId, return all

      const applications = await Application.find(query)
        .populate({
          path: "customerId",
          select: "employeeId _id firstName lastName email phone loanAmount",
        })
        .populate({
          path: "partnerId",
          select: "firstName lastName employeeId",
        })
        .populate({
          path: "rmId",
          select: "firstName lastName employeeId asmId",
          populate: {
            path: "asmId",
            select: "firstName lastName employeeId",
          },
        })
        .select("appNo loanType approvedLoanAmount status createdAt customer")
        .lean();

      const formatted = applications.map((app) => {
        const c = app.customer || {}; // embedded customer info
        const customerUser = app.customerId || {}; // main User document
        const p = app.partnerId || {};
        const r = app.rmId || {};
        const a = r.asmId || {};

        return {
          _id: c._id || customerUser._id || null, // use customerId._id if embedded customer is missing
          appNo: app.appNo,
          firstName: c.firstName || customerUser.firstName || null,
          lastName: c.lastName || customerUser.lastName || null,
          userId: customerUser._id || null,
          employeeId: customerUser.employeeId || null,
          email: c.email || null,
          phone: c.phone || null,
          loanType: app.loanType,
          loanAmount: c.loanAmount || 0,
          disburseAmount: app.approvedLoanAmount || 0,
          status: app.status,
          applicationDate: app.createdAt,
          partnerName: p.firstName ? `${p.firstName} ${p.lastName}` : null,
          partnerEmployeeId: p.employeeId || null,
          rmName: r.firstName ? `${r.firstName} ${r.lastName}` : null,
          rmEmployeeId: r.employeeId || null,
          asmName: a.firstName ? `${a.firstName} ${a.lastName}` : null,
          asmEmployeeId: a.employeeId || null,
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
      const list = await User.find({
        role: ROLES.CUSTOMER,

        partnerId: req.params.partnerId,
      })

        .select("-passwordHash -__v")

        .populate({
          path: "partnerId",

          select: "firstName lastName employeeId rmId",

          populate: {
            path: "rmId", // also get RM details under Partner

            select: "firstName lastName employeeId",
          },
        })

        .lean();

      // ✅ Flatten partner + rm details into same object

      const formatted = list.map((customer) => {
        const partner = customer.partnerId;

        const rm = partner?.rmId;

        delete customer.partnerId;

        return {
          ...customer,

          partnerName: partner
            ? `${partner.firstName} ${partner.lastName}`
            : null,

          partnerEmployeeId: partner ? partner.employeeId : null,

          rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,

          rmEmployeeId: rm ? rm.employeeId : null,
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching customers under partner:", err);

      res.status(500).json({ message: "Error fetching customers" });
    }
  }
);

// ✅ DELETE /admin/customer/:customerId - Delete customer and all their loan applications (Admin only)
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

      // Find the customer
      const customer = await User.findOne({
        _id: customerId,
        role: ROLES.CUSTOMER
      });

      if (!customer) {
        return res.status(404).json({ message: "Customer not found" });
      }

      // Find all applications for this customer
      const applications = await Application.find({
        customerId: customerId
      });

      // Delete all documents/files associated with applications
      for (const app of applications) {
        if (app.docs && Array.isArray(app.docs)) {
          for (const doc of app.docs) {
            if (doc.url) {
              try {
                const filePath = doc.url.startsWith('/')
                  ? path.join(process.cwd(), doc.url)
                  : doc.url;
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                }
              } catch (fileErr) {
                console.error(`Error deleting file ${doc.url}:`, fileErr.message);
                // Continue even if file deletion fails
              }
            }
          }
        }
      }

      // Delete all applications for this customer
      const deletedAppsCount = await Application.deleteMany({
        customerId: customerId
      });

      // Delete the customer user
      await User.deleteOne({ _id: customerId });

      res.json({
        message: "Customer and all associated loan applications deleted successfully",
        customerId: customerId,
        customerName: `${customer.firstName} ${customer.lastName}`,
        deletedApplications: deletedAppsCount.deletedCount,
      });
    } catch (error) {
      console.error("Error deleting customer:", error);
      res.status(500).json({
        message: "Failed to delete customer",
        error: error.message
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
      // Applications stats
      const totalFiles = await Application.countDocuments();
      const rejectedFiles = await Application.countDocuments({
        status: "REJECTED",
      });
      const approvedFiles = await Application.countDocuments({
        status: "APPROVED",
      });
      const inProcessFiles = await Application.countDocuments({
        status: {
          $in: ["SUBMITTED", "KYC_PENDING", "KYC_COMPLETE", "UNDER_REVIEW"],
        },
      });

      // Total disbursed = revenue (sum of approvedLoanAmount of DISBURSED apps)
      const revenueAgg = await Application.aggregate([
        { $match: { status: "DISBURSED" } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: { $toDouble: "$approvedLoanAmount" } },
          },
        },
      ]);
      const totalRevenue =
        revenueAgg.length > 0 ? Number(revenueAgg[0].totalRevenue) : 0;

      // manual payouts
      const payoutAgg = await Payout.aggregate([
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      const totalPayout = payoutAgg.length > 0 ? payoutAgg[0].total : 0;

      // Company-wide disbursement target (current month) from ASM targets
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();
      const asmTargets = await Target.aggregate([
        {
          $match: {
            role: ROLES.ASM,
            month: currentMonth,
            year: currentYear,
          },
        },
        {
          $group: {
            _id: null,
            totalTarget: { $sum: "$targetValue" },
          },
        },
      ]);
      const totalDisbursementTarget =
        asmTargets.length > 0 ? Number(asmTargets[0].totalTarget) : 0;

      // Users count
      const totalASM = await User.countDocuments({ role: ROLES.ASM });
      const totalRM = await User.countDocuments({ role: ROLES.RM });
      const totalRSM = await User.countDocuments({ role: ROLES.RSM });
      const totalPartners = await User.countDocuments({ role: ROLES.PARTNER });
      const totalCustomers = await User.countDocuments({
        role: ROLES.CUSTOMER,
      });

      res.json({
        totalFiles,
        rejectedFiles,
        approvedFiles,
        inProcessFiles,
        totalRevenue, // 👈 Super Admin revenue = all partners' disbursed sum
        totalPayout,
        totalDisbursementTarget,
        totalASM,
        totalRM,
        totalRSM,
        totalPartners,
        totalCustomers,
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
      await session.withTransaction(async () => {
        await User.updateMany(
          { role: ROLES.RSM, asmId: oldAsmId },
          { $set: { asmId: newAsmId } },
          { session }
        );

        const rms = await User.find({ role: ROLES.RM, asmId: oldAsmId }, "_id").session(session);
        const rmIds = rms.map((rm) => rm._id);

        await User.updateMany(
          { role: ROLES.RM, asmId: oldAsmId },
          { $set: { asmId: newAsmId } },
          { session }
        );

        const partners = await User.find(
          { role: ROLES.PARTNER, rmId: { $in: rmIds } },
          "_id"
        ).session(session);
        const partnerIds = partners.map((p) => p._id);

        await User.updateMany(
          { role: ROLES.PARTNER, rmId: { $in: rmIds } },
          { $set: { asmId: newAsmId } },
          { session }
        );

        if (partnerIds.length > 0) {
          await User.updateMany(
            { partnerId: { $in: partnerIds } },
            { $set: { asmId: newAsmId } },
            { session }
          );
        }

        oldAsm = await User.findOneAndUpdate(
          { _id: oldAsmId, role: ROLES.ASM },
          { $set: { status: "SUSPENDED" } },
          { new: true, session }
        );
        newAsm = await User.findById(newAsmId).session(session);
        if (!newAsm || newAsm.role !== ROLES.ASM) {
          throw new Error("New ASM not found or invalid");
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
          "All RMs, Partners, and Customers reassigned to new ASM. Old ASM deactivated and notified.",
        reassignmentAudit,
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
      await session.withTransaction(async () => {
        oldRsm = await User.findById(rsmId).session(session);
        if (!oldRsm || oldRsm.role !== ROLES.RSM) {
          throw new Error("Old RSM not found");
        }

        if (oldRsm.rsmType === "PERSONAL") {
          await User.updateMany(
            { role: ROLES.RM, personalRsmId: rsmId },
            { $set: { personalRsmId: newRsmId } },
            { session }
          );
        } else if (oldRsm.rsmType === "BUSINESS_HOME") {
          await User.updateMany(
            { role: ROLES.RM, businessHomeRsmId: rsmId },
            { $set: { businessHomeRsmId: newRsmId } },
            { session }
          );
        } else {
          await User.updateMany(
            { role: ROLES.RM, $or: [{ personalRsmId: rsmId }, { businessHomeRsmId: rsmId }] },
            { $set: { personalRsmId: newRsmId, businessHomeRsmId: newRsmId } },
            { session }
          );
        }

        await User.findOneAndUpdate(
          { _id: rsmId, role: ROLES.RSM },
          { $set: { status: "SUSPENDED" } },
          { new: true, session }
        );

        newRsm = await User.findById(newRsmId).session(session);
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
          html: `<p>Dear ${oldRsm.firstName}, your RSM account has been deactivated and your RMs have been reassigned.</p>`,
        }).catch(err => console.error(err));
      }
      if (newRsm && newRsm.email) {
        sendMail({
          to: newRsm.email,
          subject: "You Have Been Assigned New RMs",
          html: `<p>Dear ${newRsm.firstName}, you have been assigned RMs from a deactivated RSM.</p>`,
        }).catch(err => console.error(err));
      }

      res.json({
        message: "RSM deactivated and RMs reassigned successfully.",
        reassignmentAudit,
      });
    } catch (error) {
      if (error.message === "Old RSM not found") {
        return res.status(404).json({ message: error.message });
      }
      console.error("Error in /rsm-deactivate:", error);
      res.status(500).json({ message: error.message });
    } finally {
      await session.endSession();
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
      await session.withTransaction(async () => {
        const partners = await User.find({ role: ROLES.PARTNER, rmId: oldRmId }, "_id").session(session);
        const partnerIds = partners.map((p) => p._id);

        await User.updateMany(
          { role: ROLES.PARTNER, rmId: oldRmId },
          { $set: { rmId: newRmId } },
          { session }
        );

        await Application.updateMany(
          buildReassignableApplicationFilter({ rmId: oldRmId }),
          { $set: { rmId: newRmId } },
          { session }
        );

        if (partnerIds.length > 0) {
          await User.updateMany(
            { partnerId: { $in: partnerIds } },
            { $set: { rmId: newRmId } },
            { session }
          );
        }

        oldRm = await User.findOneAndUpdate(
          { _id: oldRmId, role: ROLES.RM },
          { $set: { status: "SUSPENDED" } },
          { new: true, session }
        );
        newRm = await User.findById(newRmId).session(session);
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
        message: "RM deactivated and Partners reassigned successfully.",
        reassignmentAudit,
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

      let customerUpdate;
      let appUpdate;
      let payoutUpdate;
      let incentiveUpdate;
      let lockedPayouts = 0;
      let lockedIncentives = 0;
      let oldPartner;
      let reassignmentAudit;

      await session.withTransaction(async () => {
        // 1. Reassign all Customers from old Partner to new Partner
        customerUpdate = await User.updateMany(
          { role: ROLES.CUSTOMER, partnerId: oldPartnerId },
          { $set: { partnerId: newPartnerId } },
          { session }
        );

        // 2. Reassign all Applications from old Partner to new Partner
        appUpdate = await Application.updateMany(
          buildReassignableApplicationFilter({ partnerId: oldPartnerId }),
          { $set: { partnerId: newPartnerId } },
          { session }
        );

        // 3. Reassign only unsettled payout/incentive ownership
        payoutUpdate = await Payout.updateMany(
          { partnerId: oldPartnerId, payOutStatus: REASSIGNABLE_PAYOUT_STATUS },
          { $set: { partnerId: newPartnerId } },
          { session }
        );
        incentiveUpdate = await Incentive.updateMany(
          { partnerId: oldPartnerId, status: REASSIGNABLE_INCENTIVE_STATUS },
          { $set: { partnerId: newPartnerId } },
          { session }
        );
        lockedPayouts = await Payout.countDocuments({
          partnerId: oldPartnerId,
          payOutStatus: LOCKED_PAYOUT_STATUS,
        }).session(session);
        lockedIncentives = await Incentive.countDocuments({
          partnerId: oldPartnerId,
          status: LOCKED_INCENTIVE_STATUS,
        }).session(session);

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
          "Partner deactivated and active workload reassigned successfully. Settled finance/history is preserved.",
        reassignmentAudit,
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


// Permanently delete an ASM (only after deactivation)
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

      // Enforce safety: only allow delete once already deactivated
      if (asm.status === "ACTIVE") {
        return res
          .status(400)
          .json({ message: "Deactivate ASM before deleting the account" });
      }

      await Target.deleteMany({ assignedTo: asm._id });
      await User.deleteOne({ _id: asm._id });

      res.json({
        message: "ASM account deleted permanently",
        id: asm._id,
        email: asm.email,
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

// Permanently delete an RSM (only after deactivation)
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
          .json({ message: "Deactivate RSM before deleting the account" });
      }

      const rmStillLinked = await User.countDocuments({
        role: ROLES.RM,
        $or: [{ personalRsmId: rsmId }, { businessHomeRsmId: rsmId }],
      });
      if (rmStillLinked > 0) {
        return res.status(400).json({
          message:
            "Cannot delete RSM while RMs are still assigned. Reassign them first.",
        });
      }

      await Target.deleteMany({ assignedTo: rsm._id });
      await User.deleteOne({ _id: rsm._id });

      res.json({
        message: "RSM account deleted permanently",
        id: rsm._id,
        email: rsm.email,
      });
    } catch (error) {
      console.error("Error deleting RSM:", error);
      res.status(500).json({ message: "Failed to delete RSM" });
    }
  }
);

// Permanently delete an RM (only after deactivation)
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
          .json({ message: "Deactivate RM before deleting the account" });
      }

      await Target.deleteMany({ assignedTo: rm._id });
      await User.deleteOne({ _id: rm._id });

      res.json({
        message: "RM account deleted permanently",
        id: rm._id,
        email: rm.email,
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

// Permanently delete/reject a partner request with all documents
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

      // Delete all applications associated with this partner
      await Application.deleteMany({ partnerId: partner._id });

      // Delete all payouts associated with this partner
      await Payout.deleteMany({ partnerId: partner._id });

      // Delete all targets assigned to this partner
      await Target.deleteMany({ assignedTo: partner._id });

      // Reassign customers to null (or handle as needed)
      await User.updateMany(
        { partnerId: partner._id },
        { $unset: { partnerId: "" } }
      );

      // Delete the partner user account (this will also remove their documents from S3 if configured)
      await User.deleteOne({ _id: partner._id });

      // 📧 Send rejection email
      try {
        await sendMail({
          to: partner.email,
          subject: "Partner Registration Request Rejected",
          html: `
            <p>Dear ${partner.firstName} ${partner.lastName},</p>
            <p>We regret to inform you that your Partner registration request has been <b>rejected</b>.</p>
            <p><b>Partner ID:</b> ${partner.partnerCode || partner.employeeId || "-"}</p>
            <p>All associated documents and data have been removed from our system.</p>
            <p>If you believe this action was incorrect, please contact support immediately.</p>
            <br/>
            <p>Regards,<br/>DhanSource Capital</p>
          `,
        });
        console.log("📧 Rejection mail sent to:", partner.email);
      } catch (mailErr) {
        console.error("❌ Failed to send rejection email:", mailErr.message);
      }

      res.json({
        message: "Partner request rejected and deleted permanently. All associated data removed.",
        id: partner._id,
        email: partner.email,
      });
    } catch (error) {
      console.error("Error deleting Partner:", error);
      res.status(500).json({ message: "Failed to delete Partner" });
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
  requireRole(ROLES.ADMIN),
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

      // Remove undefined values
      Object.keys(updateData).forEach(
        (key) => updateData[key] === undefined && delete updateData[key]
      );

      const updatedAdmin = await User.findOneAndUpdate(
        { _id: adminId, role: ROLES.ADMIN },
        { $set: updateData },
        { new: true, runValidators: true, projection: "-passwordHash" }
      );

      if (!updatedAdmin)
        return res.status(404).json({ message: "Admin not found" });

      let emailChangePending = false;
      let emailChangeMessage = null;

      if (
        email &&
        String(email).toLowerCase() !== String(updatedAdmin.email).toLowerCase()
      ) {
        const normalizedEmail = String(email).toLowerCase();
        const exists = await User.findOne({
          email: normalizedEmail,
          _id: { $ne: adminId },
        });
        if (exists) {
          return res.status(409).json({ message: "Email already in use" });
        }

        const currentAdmin = await User.findById(adminId).select("email firstName passwordHash");
        if (!currentPassword) {
          return res.status(400).json({ message: "Current password is required for email change." });
        }
        const passOk = await argon2.verify(currentAdmin.passwordHash, String(currentPassword));
        if (!passOk) {
          return res.status(400).json({ message: "Current password is incorrect." });
        }
        if (
          currentEmail &&
          String(currentEmail).toLowerCase().trim() !== String(currentAdmin.email).toLowerCase().trim()
        ) {
          return res.status(400).json({ message: "Current email does not match your active email." });
        }
        await createEmailChangeRequest({
          user: currentAdmin,
          currentEmail: currentAdmin.email,
          newEmail: normalizedEmail,
          clientUrl: process.env.CLIENT_URL,
        });
        emailChangePending = true;
        emailChangeMessage =
          "Email change link sent. Please confirm via the link in your inbox.";
      }

      const profileObj = updatedAdmin?.toObject ? updatedAdmin.toObject() : updatedAdmin;
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
      console.error(err);
      res.status(500).json({ message: err.message });
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

        const customers = await Application.distinct("customerId", {
          partnerId: { $in: partnerIds },
        });

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
          const partnersWithDisbursement = await Application.distinct("partnerId", {
            partnerId: { $in: partnerIds },
            status: "DISBURSED"
          });

          // Only count partners who have disbursed
          partnerIds = partnersWithDisbursement;
        }

        const customers = await Application.distinct("customerId", {
          partnerId: { $in: partnerIds },
        });

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
        const customers = await Application.distinct("customerId", {
          partnerId: user._id,
        });

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

        const customers = await Application.distinct("customerId", {
          $or: [
            { rsmId: id },
            { rmId: { $in: rmIds } },
            { partnerId: { $in: partnerIds } }
          ]
        });

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
      Application.countDocuments({
        partnerId,
        status: { $in: ACTIVE_APPLICATION_STATUSES },
      }),
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
        const partner = await User.findById(requestDoc.user);
        if (!partner) {
          return res.status(404).json({ message: "Partner not found for this request" });
        }
        if (partner.role !== ROLES.PARTNER) {
          return res.status(400).json({ message: "Delete flow currently supports Partner only" });
        }

        // Always do soft-delete first (deactivate account access).
        partner.status = "SUSPENDED";

        const hardDeleteCheck = await evaluatePartnerHardDeleteEligibility(partner._id);
        if (hardDeleteCheck.eligible) {
          const deletedTag = `deleted_${partner._id}_${Date.now()}`;
          partner.firstName = "Deleted";
          partner.lastName = "User";
          partner.middleName = "";
          partner.email = `${deletedTag}@deleted.local`;
          partner.phone = buildSoftDeletedPhone();
          partner.address = "";
          partner.region = "";
          partner.pincode = "";
          partner.landmark = "";
          partner.docs = [];
          partner.deletedAt = new Date();

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

        await partner.save();
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

// GET /api/admin/customers/pending-payouts
// Admin gets pending payout customers (disbursed loans without DONE payout)
router.get("/customers/pending-payouts", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    // Fetch all disbursed applications
    const applications = await Application.find({ status: "DISBURSED" })
      .populate("customerId", "employeeId firstName lastName email phone")
      .populate("partnerId", "firstName lastName email phone")
      .lean();

    // Get all payouts for these applications
    const appIds = applications.map((app) => app._id);
    const payouts = await Payout.find({ application: { $in: appIds } })
      .select("application amount payOutStatus")
      .lean();

    const doneAppIds = new Set(
      payouts
        .filter((p) => p.payOutStatus === "DONE")
        .map((p) => p.application.toString())
    );

    // Only consider applications with DISBURSED and NOT already DONE
    const disbursedApps = applications.filter(
      (app) =>
        app.status === "DISBURSED" && !doneAppIds.has(app._id.toString())
    );

    // Map to customer format (include proposed payout amount if any)
    const customers = disbursedApps.map((app) => {
      const payout = payouts.find(
        (p) => p.application.toString() === app._id.toString()
      );

      return {
        customerId: app.customerId?._id,
        customerEmployeeId: app.customerId?.employeeId || null,
        customerName: `${app.customerId?.firstName ?? ""} ${app.customerId?.lastName ?? ""
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
          name: `${app.partnerId?.firstName ?? ""} ${app.partnerId?.lastName ?? ""
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
    // Fetch all applications
    const applications = await Application.find()
      .populate("customerId", "employeeId firstName lastName email phone")
      .populate("partnerId", "firstName lastName email phone")
      .lean();

    const appIds = applications.map((app) => app._id);

    const donePayouts = await Payout.find({
      application: { $in: appIds },
      payOutStatus: "DONE",
    })
      .select("application amount payOutStatus")
      .lean();

    const doneMap = {};
    donePayouts.forEach((p) => {
      doneMap[p.application.toString()] = p;
    });

    const customers = applications
      .filter((app) => doneMap[app._id.toString()]) // only apps with DONE payout
      .map((app) => {
        const payout = doneMap[app._id.toString()];
        return {
          customerId: app.customerId?._id,
          customerEmployeeId: app.customerId?.employeeId || null,
          customerName: `${app.customerId?.firstName ?? ""} ${app.customerId?.lastName ?? ""
            }`.trim(),
          contact: app.customerId?.phone || null,
          email: app.customerId?.email || null,
          loanType: app.loanType,
          requestedAmount: app.customer?.loanAmount || null,
          approvedAmount: app.approvedLoanAmount || null,
          status: app.status,
          payOutStatus: payout?.payOutStatus || "DONE",
          payoutAmount: payout?.amount || 0,
          partner: {
            partnerId: app.partnerId?._id,
            name: `${app.partnerId?.firstName ?? ""} ${app.partnerId?.lastName ?? ""
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
    console.error("Error fetching done payout customers:", err);
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

    // Find all applications for this customer
    const applications = await Application.find({ customerId })
      .select("_id partnerId")
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
      .select("application partnerId amount payOutStatus note")
      .lean();

    // Map partner details + application info + payout status
    const partnerDetails = partnersData
      .map((partner) => {
        // Find applications for this partner and customer
        const partnerApps = applications.filter(
          (app) => app.partnerId?.toString() === partner._id.toString()
        );

        return partnerApps.map((app) => {
          // Find payout for this application if exists
          const payout = payouts.find(
            (p) => p.application.toString() === app._id.toString()
          );

          return {
            _id: partner._id,
            firstName: partner.firstName,
            lastName: partner.lastName,
            email: partner.email,
            phone: partner.phone,
            bankName: partner.bankName,
            ifscCode: partner.ifscCode,
            accountNumber: partner.accountNumber,
            accountHolderName: partner.accountHolderName,
            applicationId: app._id,
            payoutAmount: payout?.amount || 0,
            payoutStatus: payout?.payOutStatus || "PENDING",
            payoutNote: payout?.note || "",
          };
        });
      })
      .flat();

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
    const { applicationId, partnerId, payoutPercentage, note, payOutStatus } =
      req.body;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(applicationId)) {
      return res.status(400).json({ message: "Invalid application ID" });
    }

    // Fetch application (Admin can access all)
    const application = await Application.findOne({
      _id: applicationId,
    }).select("approvedLoanAmount partnerId");

    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    // Ensure partner matches
    if (application.partnerId && application.partnerId.toString() !== partnerId) {
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

    const previousStatus = payout ? payout.payOutStatus : null;

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
        addedBy: req.user.sub, // Admin user
      });
    }

    // 🔔 If status changed to DONE → emit socket + send email to partner
    try {
      if (payout && payout.payOutStatus === "DONE" && previousStatus !== "DONE") {
        const io = global.io;
        if (io) {
          await emitPayoutStatusChanged(io, payout._id, "DONE", payout.partnerId, payout.amount);
        }

        // Fetch partner for email
        const partner = await User.findById(payout.partnerId)
          .select("firstName lastName email")
          .lean();
        if (partner && partner.email) {
          // Map payout fields to email format
          await sendPayoutEmail(partner, {
            _id: payout._id,
            amount: payout.amount,
            status: "PAID",
            paymentDate: new Date(),
          });
        }
      }
    } catch (notifyErr) {
      console.error("❌ Error sending payout notifications/email:", notifyErr);
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

// GET /api/admin/incentives
// Admin sees incentive overview per partner, same shape as ASM incentives
router.get(
  "/incentives",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { status, year, month } = req.query;

      // Get all partners in the system
      const partners = await User.find({ role: ROLES.PARTNER })
        .populate({
          path: "asmId",
          select: "firstName lastName employeeId",
        })
        .lean();
      if (!partners.length) {
        return res.json([]);
      }

      const partnerIds = partners.map((p) => p._id);

      // Build date filter (same logic as ASM incentives)
      const currentDate = new Date();
      const targetMonth = month ? Number(month) : currentDate.getMonth() + 1;
      const targetYear = year ? Number(year) : currentDate.getFullYear();

      const startDate = new Date(targetYear, targetMonth - 1, 1);
      const endDate = new Date(targetYear, targetMonth, 1);

      // Partner targets for month/year
      const targets = await Target.find({
        assignedTo: { $in: partnerIds },
        role: ROLES.PARTNER,
        month: targetMonth,
        year: targetYear,
      }).lean();

      // Relevant applications (non-draft) in the period
      const relevantApps = await Application.find({
        partnerId: { $in: partnerIds },
        status: { $ne: "DRAFT" },
        updatedAt: {
          $gte: startDate,
          $lt: endDate,
        },
      }).lean();

      // Compute incentive metrics for each partner (same as ASM logic)
      const incentiveData = partners.map((partner) => {
        const partnerTargets = targets.filter(
          (t) => t.assignedTo.toString() === partner._id.toString()
        );
        const partnerApps = relevantApps.filter(
          (app) => app.partnerId.toString() === partner._id.toString()
        );

        const target = partnerTargets[0] || {};
        const fileCountTarget = target.fileCountTarget || 4;
        const disbursementTarget =
          target.disbursementTarget || target.targetValue || 2000000;

        const achievedFileCount = partnerApps.length;
        const achievedDisbursement = partnerApps
          .filter((app) => app.status === "DISBURSED")
          .reduce(
            (sum, app) => sum + (parseFloat(app.approvedLoanAmount) || 0),
            0
          );

        const fileTargetMet = achievedFileCount >= fileCountTarget;
        const disbursementTargetMet = achievedDisbursement >= disbursementTarget;
        const targetAchieved = fileTargetMet && disbursementTargetMet;

        const fileTargetExceeded = achievedFileCount > fileCountTarget;
        const disbursementTargetExceeded =
          achievedDisbursement > disbursementTarget;
        const targetExceeded = disbursementTargetExceeded;

        const fileAchievementPercentage =
          fileCountTarget > 0
            ? (achievedFileCount / fileCountTarget) * 100
            : 0;
        const disbursementAchievementPercentage =
          disbursementTarget > 0
            ? (achievedDisbursement / disbursementTarget) * 100
            : 0;

        const overallAchievementPercentage = Math.min(
          fileAchievementPercentage,
          disbursementAchievementPercentage
        );

        let incentiveLevel = "NONE";
        let incentiveAmount = 0;

        if (targetExceeded && targetAchieved) {
          if (achievedFileCount >= 6 && achievedDisbursement >= 3000000) {
            incentiveLevel = "HIGH";
            incentiveAmount = Math.max(
              2000,
              (achievedDisbursement - disbursementTarget) * 0.01
            );
          } else if (achievedFileCount >= 5 && achievedDisbursement >= 2500000) {
            incentiveLevel = "MEDIUM";
            incentiveAmount = Math.max(
              1000,
              (achievedDisbursement - disbursementTarget) * 0.01
            );
          } else if (targetExceeded) {
            incentiveLevel = "BASIC";
            incentiveAmount = Math.max(
              500,
              (achievedDisbursement - disbursementTarget) * 0.005
            );
          }
        }

        return {
          partnerId: partner._id,
          partnerName: `${partner.firstName} ${partner.lastName}`,
          partnerEmployeeId: partner.employeeId,
          asmId: partner.asmId?._id || null,
          asmName: partner.asmId ? `${partner.asmId.firstName} ${partner.asmId.lastName}` : null,
          asmEmployeeId: partner.asmId?.employeeId || null,
          // Legacy fields
          totalTarget: disbursementTarget,
          totalAchieved: achievedDisbursement,
          achievementPercentage: overallAchievementPercentage.toFixed(2),
          disbursedCount: achievedFileCount,
          // Hybrid model
          fileCountTarget,
          achievedFileCount,
          disbursementTarget,
          achievedDisbursement,
          fileTargetMet,
          disbursementTargetMet,
          targetAchieved,
          fileTargetExceeded: fileTargetExceeded || false,
          disbursementTargetExceeded: disbursementTargetExceeded || false,
          targetExceeded: targetExceeded || false,
          fileAchievementPercentage: fileAchievementPercentage.toFixed(2),
          disbursementAchievementPercentage:
            disbursementAchievementPercentage.toFixed(2),
          eligibleForIncentive: targetExceeded && targetAchieved,
          incentiveLevel,
          incentiveAmount: Math.round(incentiveAmount),
        };
      });

      // Attach Incentive records (PENDING / PAID) for this period
      const incentiveDocs = await Incentive.find({
        partnerId: { $in: partnerIds },
        month: targetMonth,
        year: targetYear,
      })
        .populate({
          path: "asmId",
          select: "firstName lastName employeeId",
        })
        .lean();

      const docMap = new Map();
      incentiveDocs.forEach((inv) => {
        docMap.set(inv.partnerId.toString(), inv);
      });

      let response = incentiveData.map((row) => {
        const doc = docMap.get(row.partnerId.toString());
        const docAsm = doc?.asmId;

        // Canonical incentive amount:
        // 👉 Incentive is NOT auto-calculated anymore.
        // 👉 Only use the amount explicitly set in Incentive documents.
        const canonicalAmount =
          typeof doc?.amount === "number" ? doc.amount : 0;

        return {
          ...row,
          asmName: docAsm ? `${docAsm.firstName} ${docAsm.lastName}` : row.asmName,
          asmEmployeeId: docAsm ? docAsm.employeeId : row.asmEmployeeId,
          // Ensure frontend sees the same value everywhere
          incentiveAmount: Math.round(canonicalAmount),
          incentiveRecordId: doc?._id || null,
          incentiveStatus: doc?.status || null,
          basis: doc?.basis || null,
          percentValue: doc?.percentValue || null,
          fixedValue: doc?.fixedValue || null,
          notes: doc?.notes || null,
          incentivePaid: doc?.status === "PAID",
          // Backward‑compat single source of truth
          id: doc?._id || null,
          amount: Math.round(canonicalAmount),
          status: doc?.status || (row.eligibleForIncentive ? "PENDING" : null),
        };
      });

      // Optional status filter for admin cards + lists
      if (status === "PAID") {
        response = response.filter((r) => r.incentivePaid || r.incentiveStatus === "PAID" || r.status === "PAID");
      } else if (status === "PENDING") {
        response = response.filter(
          (r) => r.status === "PENDING" || r.incentiveStatus === "PENDING"
        );
      }

      res.json(response);
    } catch (err) {
      console.error("Error fetching admin incentives:", err);
      res
        .status(500)
        .json({ message: "Server error", error: err.message });
    }
  }
);

// POST /api/admin/incentives/:id/pay
// Admin marks an incentive as PAID
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
        return res.status(404).json({ message: "Incentive not found" });
      }

      const { amount } = req.body;
      if (amount && Number(amount) > 0) {
        incentive.amount = Math.round(Number(amount));
      }

      incentive.status = "PAID";
      incentive.paidAt = new Date();
      incentive.paidBy = req.user.sub;
      await incentive.save();

      // 🔔 Emit socket + notification for partner
      try {
        const io = global.io;
        if (io) {
          await emitIncentiveStatusChanged(io, incentive, incentive.partnerId);
        }

        // 📧 Send incentive paid email to partner (non-blocking)
        setImmediate(async () => {
          try {
            const partner = await User.findById(incentive.partnerId)
              .select("firstName lastName email")
              .lean();
            if (partner && partner.email) {
              await sendIncentiveEmail(partner, {
                _id: incentive._id,
                amount: incentive.amount,
                status: incentive.status,
                month: incentive.month,
                year: incentive.year,
                paidAt: incentive.paidAt,
              });
            }
          } catch (mailErr) {
            console.error("❌ Failed to send incentive email:", mailErr.message);
          }
        });
      } catch (notifyErr) {
        console.error("❌ Error emitting incentive notifications:", notifyErr);
      }

      res.json({
        message: "Incentive marked as paid successfully",
        incentive,
      });
    } catch (err) {
      console.error("Error paying admin incentive:", err);
      res
        .status(500)
        .json({ message: "Server error", error: err.message });
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
        const paidTarget = await User.findById(reward.referredUserId)
          .select("role")
          .lean();
        if (paidTarget?.role === ROLES.CUSTOMER) {
          await User.findByIdAndUpdate(reward.referredUserId, {
            referralRewardStatus: "PAID",
          });
        }
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
        .populate("partnerId", "firstName lastName email phone employeeId partnerCode asmId")
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

        // Determine Level
        let newLevel = "BRONZE";
        if (achievedFiles >= 50 || achievedAmount >= 20000000) {
          newLevel = "PLATINUM";
        } else if (achievedFiles >= 25 || achievedAmount >= 10000000) {
          newLevel = "GOLD";
        } else if (achievedFiles >= 10 || achievedAmount >= 5000000) {
          newLevel = "SILVER";
        }
        
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

export default router;
