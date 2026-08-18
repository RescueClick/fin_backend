import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { Application } from "../models/Application.js";
import { User } from "../models/User.js";
import argon2 from "argon2";
import { upload } from "../middleware/upload.js"; // the multer config above;
import {
  oversizeDocBatchViolation,
  oversizeSingleDocViolation,
  formatOversizeMessage,
  deleteS3ObjectsForUploadedFiles,
} from "../utils/docUploadLimits.js";
import {
  normalizeDocTypeKey,
  normalizeIncomingDocType,
  getMandatoryDocRules,
  findMissingMandatoryDocs,
  serializeMandatoryDocRules,
} from "../utils/loanMandatoryDocRules.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { Banner } from "../models/Banner.js";
import { Payout } from "../models/Payout.js";
import { partnerUpload } from "../middleware/profileUpload.js";
import mongoose from "mongoose";
import { makePartnerCode } from "../utils/codes.js";
import { sendMail } from "../utils/sendMail.js";
import { createEmailChangeRequest } from "../utils/emailChangeService.js";
import { sendPartnerRegistrationEmail, sendLoanApplicationEmail, sendDeleteAccountRequestEmail } from "../utils/emailService.js";
import { Target } from "../models/Target.js";
import { Incentive } from "../models/Incentive.js";
import { ReferralReward } from "../models/ReferralReward.js";
import { WithdrawalRequest } from "../models/WithdrawalRequest.js";
import {
  getPartnerWalletBalance,
} from "../utils/walletBalance.js";
import { createNotification, createNotificationsForUsers } from "../utils/notificationService.js";
import { DeleteAccountRequest } from "../models/DeleteAccountRequest.js";
import { Config } from "../models/Config.js";
import { findCustomerApplyBlocker } from "../utils/loanReapplyPolicy.js";
import { normalizePhoneToTen } from "../utils/phoneNormalize.js";
import {
  getReferralWebBaseUrl,
  getInviteBaseUrl,
  getPartnerAppPlayStoreUrl,
  appendPartnerShareUtm,
  canonicalPartnerReferralCode,
} from "../config/branding.js";
import {
  PUBLIC_LOAN_REFERRAL_FALLBACK_PARTNER_CODE,
  PARTNER_REGISTRATION_PATH_SEGMENT,
} from "../constants/publicReferral.js";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const router = Router();


function firstNonEmptyTrimmed(values) {
  for (const v of values) {
    if (v == null) continue;
    const t = String(v).trim();
    if (t) return t;
  }
  return "";
}

const validateApplicationPayload = ({
  customer = {},
  product = {},
  loanType,
  references = [],
  coApplicant,
}) => {
  const errors = [];

  const normalizePhone = (value) => {
    const digits = String(value ?? "").replace(/\D/g, "");
    if (!digits) return "";
    // If user provides +91 / spaced numbers / extra digits, take last 10.
    if (digits.length >= 10) return digits.slice(-10);
    return digits; // let validations fail below if too short
  };

  const normalizeEmail = (value) => {
    return String(value ?? "").trim().replace(/\s+/g, "");
  };

  // Normalize for consistent validation.
  customer.email = normalizeEmail(customer.email);
  customer.phone = normalizePhone(customer.phone);
  if (Array.isArray(references)) {
    references = references.map((r) => ({
      ...r,
      phone: normalizePhone(r?.phone),
    }));
  }
  if (coApplicant && typeof coApplicant === "object") {
    coApplicant.phone = normalizePhone(coApplicant.phone);
  }

  if (!customer.firstName) errors.push("Customer first name is required");
  if (!customer.email) errors.push("Customer email is required");
  if (customer.email && !/^\S+@\S+\.\S+$/.test(customer.email)) {
    errors.push("Customer email format is invalid");
  }
  if (!customer.phone) {
    errors.push("Customer phone is required");
  } else if (!/^\d{10}$/.test(String(customer.phone))) {
    errors.push("Customer phone must be 10 digits");
  }

  if (
    !loanType ||
    !Application.schema.path("loanType").enumValues.includes(loanType)
  ) {
    errors.push("A valid loanType is required");
  }

  const loanAmt = Number(customer?.loanAmount ?? 0);
  if (!loanAmt || loanAmt <= 0) {
    errors.push("Loan amount must be greater than zero");
  }

  if (["PERSONAL", "HOME_LOAN_SALARIED"].includes(loanType || "")) {
    if (!product.companyName) errors.push("Company name is required");
    if (!product.designation) errors.push("Designation is required");
    if (!product.monthlySalary) errors.push("Monthly salary is required");
  }

  if (["BUSINESS", "HOME_LOAN_SELF_EMPLOYED"].includes(loanType || "")) {
    if (!product.businessName) errors.push("Business name is required");
    if (!product.businessAddress) errors.push("Business address is required");
    if (!product.businessVintage) errors.push("Business vintage is required");
  }

  const refs = Array.isArray(references)
    ? references
    : references
      ? [references]
      : [];

  if (refs.length < 2) {
    errors.push("At least two references are required");
  }

  refs.forEach((ref, index) => {
    if (!ref?.name) errors.push(`Reference ${index + 1} name is required`);
    if (!ref?.phone) {
      errors.push(`Reference ${index + 1} phone is required`);
    } else if (!/^\d{10}$/.test(String(ref.phone))) {
      errors.push(`Reference ${index + 1} phone must be 10 digits`);
    }
  });

  // Co-applicant is required for female applicants, but only for BUSINESS and HOME_LOAN_SELF_EMPLOYED loan types
  if (
    customer.gender === "Female" &&
    ["BUSINESS", "HOME_LOAN_SELF_EMPLOYED"].includes(loanType || "") &&
    !coApplicant?.phone
  ) {
    errors.push("Co-applicant phone is required for female applicants with business or home loan self-employed applications");
  }

  return errors;
};

// Check if a customer exists by email or phone
router.get("/check-customer", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const { email, phone } = req.query;
    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone is required" });
    }

    const query = [];
    if (email) query.push({ email: String(email).trim().toLowerCase() });
    if (phone) query.push({ phone: String(phone).trim() });

    const existingUser = await User.findOne({ $or: query });

    if (existingUser) {
      const matchField = email && existingUser.email === String(email).trim().toLowerCase() ? "Email" : "Phone number";
      return res.json({
        exists: true,
        message: `${matchField} is already registered in the system.`,
      });
    }

    return res.json({ exists: false });
  } catch (err) {
    console.error("Error checking customer existence:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

const ACTIVE_APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "DOC_INCOMPLETE",
  "DOC_COMPLETE",
  "DOC_SUBMITTED",
  "LOGIN",
  "UNDER_REVIEW",
  "APPROVED",
  "AGREEMENT",
];

const normalizeLoanType = (loanType) => {
  const key = String(loanType || "").trim().toUpperCase();
  const aliases = {
    PERSONAL_LOAN: "PERSONAL",
    BUSINESS_LOAN: "BUSINESS",
  };
  return aliases[key] || key;
};

// Preserve multiple files of the same docType while still replacing existing re-uploads.
const mergeApplicationDocs = (existingDocs = [], newDocs = [], uploadedBy) => {
  const groupedExisting = new Map();
  const mergedDocs = [];

  for (const doc of existingDocs) {
    const key = normalizeDocTypeKey(doc.docType);
    if (!groupedExisting.has(key)) groupedExisting.set(key, []);
    groupedExisting.get(key).push(doc);
  }

  for (const incoming of newDocs) {
    const key = normalizeDocTypeKey(incoming.docType);
    const bucket = groupedExisting.get(key) || [];
    const existingDoc = bucket.length ? bucket.shift() : null;
    groupedExisting.set(key, bucket);

    if (existingDoc) {
      mergedDocs.push({
        ...existingDoc,
        url: incoming.url,
        status: "PENDING",
        remarks: "",
        uploadedBy: uploadedBy ?? existingDoc.uploadedBy ?? null,
        updatedAt: new Date(),
        verifiedAt: null,
        rejectedAt: null,
        verifiedBy: null,
        rejectedBy: null,
      });
    } else {
      mergedDocs.push(incoming);
    }
  }

  for (const docs of groupedExisting.values()) {
    if (docs?.length) mergedDocs.push(...docs);
  }

  return mergedDocs;
};
// application creation logic follows below

// GET /api/partner/public-default-referral-code — no auth (public loan forms)
router.get("/public-default-referral-code", async (req, res) => {
  try {
    const doc = await Config.findOne({
      key: "PUBLIC_LOAN_DEFAULT_PARTNER_CODE",
    }).lean();
    const partnerCode =
      doc?.value && typeof doc.value === "object" && doc.value.partnerCode
        ? String(doc.value.partnerCode).trim()
        : "";
    res.json({
      partnerCode:
        partnerCode || PUBLIC_LOAN_REFERRAL_FALLBACK_PARTNER_CODE,
    });
  } catch (err) {
    console.error("public-default-referral-code:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/loan-doc-rules", auth, async (req, res) => {
  try {
    const loanType = normalizeLoanType(req.query.loanType);
    if (!loanType) {
      return res.status(400).json({ message: "loanType query param is required" });
    }

    const customer = {
      gender: req.query.gender,
    };
    const rules = getMandatoryDocRules(loanType, customer);
    return res.json({
      loanType,
      rules: serializeMandatoryDocRules(rules),
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to fetch loan document rules",
      error: err.message,
    });
  }
});

// Dummy eligibility check (PAN-only) for fast prototype.
// Later you can replace this logic with real CIBIL logic.
router.post("/eligibility/check", async (req, res) => {
  try {
    const pan = String(req.body?.pan || "").trim().toUpperCase();

    // Basic PAN format: 5 letters, 4 digits, 1 letter
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    if (!pan || !panRegex.test(pan)) {
      return res.status(400).json({ message: "Invalid PAN format" });
    }

    // Deterministic dummy score generation for repeatable UI tests.
    let sum = 0;
    for (const ch of pan) sum += ch.charCodeAt(0);
    // Score range: 500-800
    const score = (sum % 301) + 500;

    const eligible = score >= 700;

    let band = "C";
    if (score >= 750) band = "A";
    else if (score >= 700) band = "B";
    else if (score >= 650) band = "C";
    else band = "D";

    return res.json({
      eligible,
      score,
      cibilBand: band,
      reason: eligible ? null : "Not eligible in dummy check. Please try again later.",
    });
  } catch (err) {
    return res.status(500).json({ message: "Eligibility check failed", error: err.message });
  }
});

// Pre-generate partnerId so the upload middleware can place files under a stable key
const assignPartnerId = (req, _res, next) => {
  req.partnerId = new mongoose.Types.ObjectId();
  next();
};

router.post(
  "/signup-partner",
  assignPartnerId,
  partnerUpload.any(), // Accept any file field
  async (req, res) => {
    try {
      const partnerData = JSON.parse(req.body.newFormData || "{}");

      const {
        firstName,
        middleName,
        lastName,
        phone,
        dob: rawDob,
        email,
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
        password,
        joinDate,
      } = partnerData;

      // Validate and format date of birth
      const formatDate = (dateString) => {
        if (!dateString) return null;

        // Remove any whitespace
        dateString = dateString.trim();

        // Try to parse the date in different formats
        let date;

        // Format: YYYY-MM-DD (ISO format)
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
          const parts = dateString.split('-');
          const year = parseInt(parts[0]);
          const month = parseInt(parts[1]);
          const day = parseInt(parts[2]);

          // Check if month is valid (1-12)
          if (month < 1 || month > 12) {
            // Might be DD-MM-YYYY format, swap day and month
            if (day >= 1 && day <= 12 && month >= 1 && month <= 31) {
              date = new Date(year, day - 1, month);
            } else {
              throw new Error(`Invalid date format: ${dateString}. Expected YYYY-MM-DD or DD-MM-YYYY`);
            }
          } else {
            date = new Date(year, month - 1, day);
          }
        }
        // Format: DD-MM-YYYY
        else if (/^\d{2}-\d{2}-\d{4}$/.test(dateString)) {
          const parts = dateString.split('-');
          const day = parseInt(parts[0]);
          const month = parseInt(parts[1]);
          const year = parseInt(parts[2]);
          date = new Date(year, month - 1, day);
        }
        // Format: DD/MM/YYYY
        else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateString)) {
          const parts = dateString.split('/');
          const day = parseInt(parts[0]);
          const month = parseInt(parts[1]);
          const year = parseInt(parts[2]);
          date = new Date(year, month - 1, day);
        }
        // Try to parse as-is (might be ISO string)
        else {
          date = new Date(dateString);
        }

        // Validate the date
        if (isNaN(date.getTime())) {
          throw new Error(`Invalid date: ${dateString}. Please use format YYYY-MM-DD, DD-MM-YYYY, or DD/MM/YYYY`);
        }

        // Check if date is reasonable (not in future, not too old)
        const today = new Date();
        const minDate = new Date(1900, 0, 1);

        if (date > today) {
          throw new Error(`Date of birth cannot be in the future: ${dateString}`);
        }

        if (date < minDate) {
          throw new Error(`Date of birth seems too old: ${dateString}`);
        }

        // Return in ISO format (YYYY-MM-DD)
        return date.toISOString().split('T')[0];
      };

      let dob = null;
      if (rawDob) {
        try {
          dob = formatDate(rawDob);
        } catch (error) {
          return res.status(400).json({
            message: error.message,
            field: 'dob',
            receivedValue: rawDob
          });
        }
      }

      if (!firstName || !lastName || !phone || !email) {
        return res.status(400).json({
          message: "firstName, lastName, phone, and email are required",
        });
      }

      const normalizedPhone = normalizePhoneToTen(phone);
      if (!/^\d{10}$/.test(normalizedPhone)) {
        return res.status(400).json({
          message: "Please enter a valid 10-digit phone number",
        });
      }

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

      const rawPassword =
        password || `Pt@${Math.random().toString(36).slice(2, 10)}`;

      // Self-service partners always start PENDING under super admin until admin assigns an RM
      const superAdmin = await User.findOne({ role: ROLES.SUPER_ADMIN })
        .select("_id")
        .lean();
      if (!superAdmin) {
        return res.status(503).json({
          message:
            "Registration is temporarily unavailable. Please contact support.",
        });
      }

      let assignedRmId = superAdmin._id;
      const status = "PENDING";
      let referringPartnerId = null;

      const referralInputRaw = firstNonEmptyTrimmed([
        partnerData.partnerReferralCode,
        partnerData.referralCode,
        partnerData.rmCode,
        partnerData.rmcode,
      ]);

      if (referralInputRaw) {
        const trimmed = referralInputRaw.trim();
        const upper = trimmed.toUpperCase();
        if (upper.startsWith("RM-")) {
          const rm = await User.findOne({
            rmCode: trimmed,
            role: ROLES.RM,
            status: "ACTIVE",
          })
            .select("_id")
            .lean();
          if (!rm) {
            return res.status(400).json({
              message: "Invalid or inactive RM code",
            });
          }
          assignedRmId = rm._id;
        } else {
          const referringPartner = await User.findOne({
            partnerCode: {
              $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i"),
            },
            role: ROLES.PARTNER,
            status: "ACTIVE",
          })
            .select("_id rmId")
            .lean();
          if (!referringPartner) {
            return res.status(400).json({
              message: "Invalid or inactive partner referral code",
            });
          }
          referringPartnerId = referringPartner._id;
          if (referringPartner.rmId) {
            assignedRmId = referringPartner.rmId;
          }
        }
      }

      const partnerId = req.partnerId || new mongoose.Types.ObjectId();

      const docs = (req.files || []).map((file) => {
        if (!file.location) {
          throw new Error("S3 upload failed: missing file location");
        }
        return {
          docType: file.fieldname.toUpperCase(),
          url: file.location,
          uploadedBy: null,
          status: "PENDING",
        };
      });

      // Create partner
      const partner = await User.create({
        _id: partnerId,
        employeeId: await generateEmployeeId("PARTNER"),
        firstName,
        middleName,
        lastName,
        phone: normalizedPhone,
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
        rmId: assignedRmId,
        joinDate: joinDate ? new Date(joinDate) : new Date(),
        status,
        docs,
        referredBy: referringPartnerId || undefined,
        referralRewardStatus: "NONE",
      });

      // 📧 Send activation email to partner using email service
      await sendPartnerRegistrationEmail(partner, password ? null : rawPassword);

      // 🔔 Create notification for Admin about new partner registration
      try {
        const adminUsers = await User.find({
          role: { $in: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
          status: "ACTIVE"
        }).select("_id").lean();

        if (adminUsers.length > 0) {
          const adminUserIds = adminUsers.map(u => u._id.toString());

          await createNotificationsForUsers(adminUserIds, {
            type: "registration",
            title: "New Partner Registration",
            message: `${partner.firstName} ${partner.lastName} (${partner.email}) has registered as a Partner. Status: ${partner.status}`,
            category: "partner",
            priority: partner.status === "PENDING" ? "high" : "normal",
            data: {
              partnerId: partner._id.toString(),
              partnerCode: partner.partnerCode,
              employeeId: partner.employeeId,
              status: partner.status,
              registrationDate: new Date(),
            },
            actionBy: {
              _id: partner._id,
              name: `${partner.firstName} ${partner.lastName}`,
              role: ROLES.PARTNER,
              email: partner.email,
              employeeId: partner.employeeId,
            },
          });

          // Emit socket event to admin users
          if (global.io) {
            global.io.to("admin").emit("newPartnerRegistered", {
              partner: {
                _id: partner._id,
                firstName: partner.firstName,
                lastName: partner.lastName,
                email: partner.email,
                status: partner.status,
                partnerCode: partner.partnerCode,
                employeeId: partner.employeeId,
              },
              timestamp: new Date(),
            });
            console.log("✅ Socket event emitted to admin users for new partner registration");
          }
        }
      } catch (notifErr) {
        console.error("❌ Error creating admin notification:", notifErr);
      }

      // 🔔 Notify RM only when this partner is actually assigned to an RM (not admin queue)
      if (assignedRmId) {
        try {
          const assignee = await User.findById(assignedRmId).select("role").lean();
          if (assignee?.role === ROLES.RM) {
            await createNotification(assignedRmId.toString(), {
              type: "registration",
              title: "New Partner Assigned",
              message: `${partner.firstName} ${partner.lastName} (${partner.partnerCode}) has been assigned to you. Status: ${partner.status}`,
              category: "partner",
              priority: "normal",
              data: {
                partnerId: partner._id.toString(),
                partnerCode: partner.partnerCode,
                employeeId: partner.employeeId,
                status: partner.status,
              },
              actionBy: {
                _id: partner._id,
                name: `${partner.firstName} ${partner.lastName}`,
                role: ROLES.PARTNER,
                email: partner.email,
              },
            });

            if (global.io) {
              global.io
                .to(`rm_${assignedRmId.toString()}`)
                .emit("newPartnerRegistered", {
                  partner: {
                    _id: partner._id,
                    firstName: partner.firstName,
                    lastName: partner.lastName,
                    email: partner.email,
                    status: partner.status,
                    partnerCode: partner.partnerCode,
                  },
                  timestamp: new Date(),
                });
              console.log(
                "✅ Socket event emitted to RM for new partner registration"
              );
            }

            const line = await getReportingLineFromRmId(assignedRmId.toString());
            const regDataAsm = {
              partnerId: partner._id.toString(),
              partnerCode: partner.partnerCode,
              employeeId: partner.employeeId,
              status: partner.status,
            };
            const partnerSock = {
              _id: partner._id,
              firstName: partner.firstName,
              lastName: partner.lastName,
              email: partner.email,
              status: partner.status,
              partnerCode: partner.partnerCode,
              employeeId: partner.employeeId,
            };
            const regTitle = "New Partner Registration";
            const regMsgAsm = `${partner.firstName} ${partner.lastName} (${partner.email}) registered. Status: ${partner.status}`;
            if (line.asmId && global.io) {
              const nidAsm = generateNotificationId({
                applicationId: partner._id.toString(),
                timestamp: Date.now(),
                userId: line.asmId,
                type: "registration",
              });
              await createNotification(line.asmId, {
                type: "registration",
                title: regTitle,
                message: regMsgAsm,
                category: "partner",
                priority: "normal",
                data: regDataAsm,
                notificationId: nidAsm,
              });
              global.io.to(`asm_${line.asmId}`).emit("newPartnerRegistered", {
                partner: partnerSock,
                notificationId: nidAsm,
                timestamp: new Date(),
              });
            }
            for (const rsmId of line.rsmIds) {
              if (!global.io) continue;
              const nidRsm = generateNotificationId({
                applicationId: partner._id.toString(),
                timestamp: Date.now(),
                userId: rsmId,
                type: "registration",
              });
              await createNotification(rsmId, {
                type: "registration",
                title: regTitle,
                message: regMsgAsm,
                category: "partner",
                priority: "normal",
                data: regDataAsm,
                notificationId: nidRsm,
              });
              global.io.to(`rsm_${rsmId}`).emit("newPartnerRegistered", {
                partner: partnerSock,
                notificationId: nidRsm,
                timestamp: new Date(),
              });
            }
            if (line.asmId || line.rsmIds.length) {
              console.log(
                "✅ ASM/RSM notifications emitted for new partner registration"
              );
            }
          }
        } catch (rmNotifErr) {
          console.error("❌ Error creating RM notification:", rmNotifErr);
        }
      }

      // 🔔 Create notification for the partner about their registration
      try {
        await createNotification(partner._id.toString(), {
          type: "registration",
          title: "Registration Successful",
          message: `Your partner account has been created successfully. Your account status is: ${partner.status}. ${partner.status === "PENDING" ? "You will be notified once your account is activated." : "You can now start using the platform."}`,
          category: "partner",
          priority: "normal",
          data: {
            partnerCode: partner.partnerCode,
            employeeId: partner.employeeId,
            status: partner.status,
          },
        });

        // Emit socket event to partner
        if (global.io) {
          global.io.to(`partner_${partner._id.toString()}`).emit("registrationSuccessful", {
            partner: {
              _id: partner._id,
              firstName: partner.firstName,
              lastName: partner.lastName,
              status: partner.status,
              partnerCode: partner.partnerCode,
            },
            timestamp: new Date(),
          });
          console.log("✅ Socket event emitted to partner for registration success");
        }
      } catch (partnerNotifErr) {
        console.error("❌ Error creating partner notification:", partnerNotifErr);
      }

      // 🔹 STEP 2: Redistribute RM target among all Partners
      if (assignedRmId && status === "ACTIVE") {
        const now = new Date();
        const month = now.getMonth() + 1; // current month
        const year = now.getFullYear();

        const rmTargetDoc = await Target.findOne({
          assignedTo: assignedRmId,
          role: ROLES.RM,
          month,
          year,
        });

        if (rmTargetDoc) {
          const partners = await User.find({
            role: ROLES.PARTNER,
            rmId: assignedRmId,
          }).lean();
          const perPartnerTarget = rmTargetDoc.targetValue / partners.length;

          for (let p of partners) {
            let pT = await Target.findOne({
              assignedTo: p._id,
              role: ROLES.PARTNER,
              month,
              year,
            });

            if (pT) {
              pT.targetValue = perPartnerTarget;
              await pT.save();
            } else {
              await Target.create({
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
        message:
          "Partner registration submitted. An administrator will assign your RM and activate your account.",
        id: partner._id,
        partnerCode: partner.partnerCode,
        rmId: partner.rmId,
        status: partner.status,
        tempPassword: password ? undefined : rawPassword,
        employeeId: partner.employeeId,
        docs,
      });
    } catch (err) {
      console.error("Error signing up partner:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

// Public application creation (no login required)
router.post(
  "/public/create-application",
  upload.array("docs"), // max 10 files
  async (req, res) => {
    try {
      const {
        customer,
        product,
        loanType,
        references,
        coApplicant,
        partnerReferralCode,
        status: applicationStatus,
      } = JSON.parse(req.body.data || "{}");

      const validationErrors = validateApplicationPayload({
        customer,
        product,
        loanType,
        references,
        coApplicant,
      });

      if (validationErrors.length > 0) {
        return res
          .status(400)
          .json({ message: "Validation failed", errors: validationErrors });
      }

      // Resolve referral partner mapping
      let assignedPartnerId = null;
      let assignedRmId = null;
      let assignedAsmId = null;
      let referralPartner = null;

      if (partnerReferralCode) {
        referralPartner = await User.findOne({
          partnerCode: partnerReferralCode.trim(),
          role: ROLES.PARTNER,
          status: "ACTIVE",
        });

        if (!referralPartner) {
          return res.status(400).json({ message: "Invalid partner referral code" });
        }

        assignedPartnerId = referralPartner._id;
        assignedRmId = referralPartner.rmId || null;
        if (referralPartner.rmId) {
          const referralRm = await User.findById(referralPartner.rmId);
          assignedAsmId = referralRm?.asmId || null;
        }
      }

      // Check if customer exists
      let customerUser = await User.findOne({
        $or: [
          { email: customer.email.toLowerCase() },
          { phone: customer.phone },
          { appNo: customer.appNo },
        ],
        role: ROLES.CUSTOMER,
      });

      // If not exists, create customer
      let tempPassword;
      if (!customerUser) {
        tempPassword =
          customer.password || `Cus@${Math.random().toString(36).slice(2, 10)}`;

        // ✅ CRITICAL: Retry logic to handle duplicate employeeId race conditions
        let retries = 0;
        const maxRetries = 5;
        let created = false;

        while (!created && retries < maxRetries) {
          try {
            const employeeId = await generateEmployeeId("CUSTOMER");
            customerUser = await User.create({
              employeeId,
              firstName: customer.firstName,
              middleName: customer.middleName || "",
              lastName: customer.lastName || "",
              email: customer.email.toLowerCase(),
              phone: customer.phone,
              password: customer.password,
              passwordHash: await argon2.hash(customer.password || tempPassword),
              role: ROLES.CUSTOMER,
              status: "ACTIVE",
              partnerId: assignedPartnerId || undefined,
              rmId: assignedRmId || undefined,
              referredBy: referralPartner?._id || undefined,
              referralRewardStatus: referralPartner?._id ? "PENDING" : "NONE",
            });
            created = true;
            console.log(`✅ Customer created with unique employeeId: ${employeeId}`);
          } catch (createError) {
            // Handle duplicate key error (E11000)
            if (createError.code === 11000 && createError.keyPattern?.employeeId) {
              retries++;
              console.warn(`⚠️ Duplicate employeeId detected (attempt ${retries}/${maxRetries}), retrying...`);
              if (retries >= maxRetries) {
                throw new Error(`Failed to create customer after ${maxRetries} attempts due to duplicate employeeId. Please try again.`);
              }
              // Wait a bit before retrying
              await new Promise(resolve => setTimeout(resolve, 100 * retries));
            } else {
              // Other errors, throw immediately
              throw createError;
            }
          }
        }
      }

      // Keep existing customer attached to owning partner/RM when fields were never set
      if (customerUser && assignedPartnerId) {
        const linkPatch = {};
        if (!customerUser.partnerId) linkPatch.partnerId = assignedPartnerId;
        if (!customerUser.rmId && assignedRmId) linkPatch.rmId = assignedRmId;
        if (Object.keys(linkPatch).length) {
          await User.updateOne({ _id: customerUser._id }, { $set: linkPatch });
          Object.assign(customerUser, linkPatch);
        }
      }

      // Map uploaded docs
      const docTypes = Array.isArray(req.body.docTypes)
        ? req.body.docTypes
        : req.body.docTypes
          ? [req.body.docTypes]
          : [];

      if (req.files?.length) {
        const viol = oversizeDocBatchViolation(req.files, docTypes);
        if (viol) {
          await deleteS3ObjectsForUploadedFiles(req.files);
          return res.status(400).json({ message: formatOversizeMessage(viol) });
        }
      }

      const newDocs = req.files.map((file, index) => {
        if (!file.location) {
          throw new Error("S3 upload failed: missing file location");
        }
        return {
          docType: normalizeIncomingDocType(docTypes[index] || "UNKNOWN"),
          url: file.location,
          uploadedBy: null,
          status: "PENDING",
        };
      });


      // Prepare conditional sections
      let employmentInfo = null;
      let businessInfo = null;
      let propertyInfo = null;

      if (["PERSONAL", "HOME_LOAN_SALARIED"].includes(loanType)) {
        employmentInfo = {
          companyName: product.companyName,
          designation: product.designation,
          companyAddress: product.companyAddress || product.currentAddress,
          monthlySalary: product.monthlySalary,
          totalExperience: product.totalExperience,
          currentExperience: product.currentExperience,
          salaryInHand: product.salaryInHand,
        };
      }

      if (["BUSINESS", "HOME_LOAN_SELF_EMPLOYED"].includes(loanType)) {
        businessInfo = {
          businessName: product.businessName,
          businessAddress: product.businessAddress,
          businessLandmark: product.businessLandmark,
          businessVintage: product.businessVintage,
          gstNumber: product.gstNumber,
          annualTurnoverInINR: product.annualTurnoverInINR,
          yearsInBusiness: product.yearsInBusiness,
        };
      }

      if (
        ["HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED"].includes(loanType)
      ) {
        propertyInfo = {
          propertyType: product.propertyType,
          propertyValue: product.propertyValue,
          propertyAddress: product.propertyAddress,
        };
      }

      const refs = Array.isArray(references)
        ? references
        : references
          ? [references]
          : [];

      // Draft/incomplete can be updated; REJECTED history kept — reapply only after 3 months
      let existingApp = await Application.findOne({
        customerId: customerUser._id,
        status: { $in: ["DRAFT", "DOC_INCOMPLETE"] },
        isArchived: { $ne: true },
        $or: [{ deletedAt: null }, { deletedAt: { $gt: new Date() } }],
      }).sort({ updatedAt: -1 });

      if (!existingApp) {
        const blocker = await findCustomerApplyBlocker(customerUser._id);
        if (blocker) {
          return res.status(400).json({
            message: blocker.message,
            reason: blocker.type,
            existingAppNo: blocker.app?.appNo,
            existingStatus: blocker.app?.status,
            canApplyAfter: blocker.unlockAt || null,
          });
        }
      }

      const customerData = {
        firstName: customer.firstName,
        middleName: customer.middleName || "",
        lastName: customer.lastName || "",
        email: customer.email,
        officialEmail: customer.officialEmail || "",
        phone: customer.phone,
        alternatePhone: customer.alternatePhone || "",
        mothersName: customer.mothersName || "",
        panNumber: customer.panNumber || "",
        dateOfBirth: customer.dateOfBirth,
        gender: customer.gender,
        maritalStatus: customer.maritalStatus,
        spouseName: customer.spouseName || "",
        currentAddress: customer.currentAddress || "",
        currentAddressLandmark: customer.currentAddressLandmark || "",
        currentAddressPinCode: customer.currentAddressPinCode || "",
        currentAddressHouseStatus: customer.currentAddressHouseStatus || "",
        currentAddressOwnRented: customer.currentAddressOwnRented || "",
        currentAddressStability: customer.currentAddressStability || "",
        permanentAddress: customer.permanentAddress || "",
        permanentAddressLandmark: customer.permanentAddressLandmark || "",
        permanentAddressPinCode: customer.permanentAddressPinCode || "",
        permanentAddressHouseStatus: customer.permanentAddressHouseStatus || "",
        permanentAddressOwnRented: customer.permanentAddressOwnRented || "",
        permanentAddressStability: customer.permanentAddressStability || "",
        stabilityOfResidency: customer.stabilityOfResidency || "",
        loanAmount: Number(customer.loanAmount ?? 0),
        partnerId: assignedPartnerId,
        rmId: assignedRmId,
        asmId: assignedAsmId,
      };

      if (
        existingApp &&
        ["DRAFT", "DOC_INCOMPLETE"].includes(existingApp.status)
      ) {
        // Partner resubmission should reflect only the docs uploaded in this request.
        // (Do NOT keep older docs that the partner didn't re-upload.)
        const docsToSave = newDocs;
        if (applicationStatus !== "DRAFT") {
          const missingDocs = findMissingMandatoryDocs(loanType, customer, docsToSave);
          if (missingDocs.length > 0) {
            return res.status(400).json({
              message: "Mandatory documents missing",
              missingDocs,
            });
          }
        }
        existingApp.docs = docsToSave;
        existingApp.customer = { ...existingApp.customer, ...customerData };
        existingApp.employmentInfo = employmentInfo;
        existingApp.businessInfo = businessInfo;
        existingApp.propertyInfo = propertyInfo;
        existingApp.coApplicant = coApplicant;
        existingApp.references = refs;
        existingApp.partnerId = assignedPartnerId;
        existingApp.rmId = assignedRmId;
        existingApp.asmId = assignedAsmId;
        // Keep DOC_INCOMPLETE status if it was DOC_INCOMPLETE, otherwise set to SUBMITTED
        // (Option A: new applications should not start in DRAFT)
        if (existingApp.status !== "DOC_INCOMPLETE") {
          existingApp.status = "SUBMITTED";
        }

        await existingApp.save();

        return res.status(200).json({
          message: "Application updated & resubmitted",
          id: existingApp._id,
          appNo: existingApp.appNo,
          status: existingApp.status,
          docs: existingApp.docs,
        });
      }

      // Otherwise create new application
      if (applicationStatus !== "DRAFT") {
        const missingDocs = findMissingMandatoryDocs(loanType, customer, newDocs);
        if (missingDocs.length > 0) {
          return res.status(400).json({
            message: "Mandatory documents missing",
            missingDocs,
          });
        }
      }

      // ✅ CRITICAL: Retry logic to handle duplicate appNo race conditions
      let app = null;
      let appRetries = 0;
      const maxAppRetries = 5;
      let appCreated = false;

      while (!appCreated && appRetries < maxAppRetries) {
        try {
          const appNo = await generateEmployeeId("APPLICATION");
          app = await Application.create({
            appNo,
            partnerId: assignedPartnerId,
            rmId: assignedRmId,
            asmId: assignedAsmId,
            customerId: customerUser._id,
            loanType,
            customer: customerData,
            docs: newDocs,
            references: refs,
            employmentInfo,
            businessInfo,
            propertyInfo,
            coApplicant,
            status: "SUBMITTED",
            stageHistory: [],
          });
          appCreated = true;
          console.log(`✅ Application created with unique appNo: ${appNo}`);
        } catch (createError) {
          // Handle duplicate key error (E11000)
          if (createError.code === 11000 && createError.keyPattern?.appNo) {
            appRetries++;
            console.warn(`⚠️ Duplicate appNo detected (attempt ${appRetries}/${maxAppRetries}), retrying...`);
            if (appRetries >= maxAppRetries) {
              throw new Error(`Failed to create application after ${maxAppRetries} attempts due to duplicate appNo. Please try again.`);
            }
            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, 100 * appRetries));
          } else if (
            createError.code === 11000 &&
            (createError.keyPattern?.partnerId ||
              createError.keyPattern?.customerId ||
              createError.keyPattern?.loanType)
          ) {
            const dedupedApp = await Application.findOne({
              partnerId: assignedPartnerId,
              customerId: customerUser._id,
              loanType,
              deletedAt: null,
              status: { $in: ACTIVE_APPLICATION_STATUSES },
            }).sort({ createdAt: -1 });
            if (dedupedApp) {
              app = dedupedApp;
              appCreated = true;
              console.warn(
                `⚠️ Duplicate create blocked, reusing existing application ${dedupedApp._id}`
              );
              continue;
            }
            throw createError;
          } else {
            // Other errors, throw immediately
            throw createError;
          }
        }
      }

      // Send email using professional email service
      let emailSent = false;
      try {
        const customerData = {
          firstName: customer.firstName,
          email: customerUser.email,
        };
        emailSent = await sendLoanApplicationEmail(
          customerData,
          {
            appNo: app.appNo,
            loanType: app.loanType,
            status: app.status,
            appliedLoanAmount: customer.loanAmount || 0,
            loanAmount: customer.loanAmount || 0,
          },
          customer.password ? null : tempPassword
        );
        if (emailSent) {
          console.log(`✅ Application creation email sent to: ${customerUser.email}`);
        }
      } catch (mailErr) {
        console.error("❌ Email send failed:", mailErr.message);
        // Don't fail the request if email fails - application is still created
      }

      res.status(201).json({
        message: emailSent
          ? "Application + Customer created and Email has been sent"
          : "Application + Customer created (Email sending failed, but application was saved)",
        id: app._id,
        appNo: app.appNo,
        status: app.status,
        emailSent,
        customerLogin: {
          email: customerUser.email,
          password: customer.password ? customer.password : tempPassword,
        },
        docs: app.docs,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

router.post(
  "/create-applications",
  auth,
  requireRole(ROLES.PARTNER, ROLES.CUSTOMER),
  upload.array("docs"), // max 10 files
  async (req, res) => {
    try {
      const userId = req.user.sub;

      // If Partner, validate RM mapping
      const partner =
        req.user.role === ROLES.PARTNER
          ? await User.findOne({ _id: userId, role: ROLES.PARTNER })
          : null;

      if (req.user.role === ROLES.PARTNER && !partner?.rmId) {
        return res
          .status(400)
          .json({ message: "Partner is not mapped to an RM" });
      }

      // Get RM & ASM
      let rm = null;
      let asm = null;
      if (req.user.role === ROLES.PARTNER) {
        rm = await User.findById(partner.rmId);
        if (rm?.asmId) {
          asm = await User.findById(rm.asmId);
        }
      }

      // Parse input JSON
      const {
        customer,
        product,
        loanType,
        references,
        coApplicant,
        partnerReferralCode,
        status: applicationStatus,
      } = JSON.parse(req.body.data || "{}");

      const validationErrors = validateApplicationPayload({
        customer,
        product,
        loanType,
        references,
        coApplicant,
      });

      if (validationErrors.length > 0) {
        return res
          .status(400)
          .json({ message: "Validation failed", errors: validationErrors });
      }

      // Resolve partner mapping when customer applies directly via referral code
      let referralPartner = null;
      let assignedPartnerId = req.user.role === ROLES.PARTNER ? userId : null;
      let assignedRmId = req.user.role === ROLES.PARTNER ? partner?.rmId : null;
      let assignedAsmId = req.user.role === ROLES.PARTNER ? partner?.asmId : null;

      if (req.user.role !== ROLES.PARTNER && partnerReferralCode) {
        referralPartner = await User.findOne({
          partnerCode: partnerReferralCode.trim(),
          role: ROLES.PARTNER,
          status: "ACTIVE",
        });

        if (!referralPartner) {
          return res.status(400).json({ message: "Invalid partner referral code" });
        }

        assignedPartnerId = referralPartner._id;
        assignedRmId = referralPartner.rmId || null;

        if (referralPartner.rmId) {
          const referralRm = await User.findById(referralPartner.rmId);
          assignedAsmId = referralRm?.asmId || null;
        }
      }

      if (req.user.role === ROLES.PARTNER && rm?.asmId) {
        assignedAsmId = assignedAsmId || rm.asmId;
      }

      // Check if customer exists
      const existingUser = await User.findOne({
        $or: [
          { email: customer.email.toLowerCase() },
          { phone: customer.phone },
        ],
      });

      let customerUser = null;
      if (existingUser) {
        if (existingUser.role !== ROLES.CUSTOMER) {
          const matchField = existingUser.email === customer.email.toLowerCase() ? "email" : "phone number";
          return res.status(409).json({
            message: `This ${matchField} is already registered as a ${existingUser.role}. Please use unique contact details for the customer.`,
          });
        }
        customerUser = existingUser;
      }

      // ✅ IDENTITY VALIDATION: If customer exists, ensure the name matches to prevent account mixing.
      if (customerUser) {
        const existingFirstName = (customerUser.firstName || "").trim().toLowerCase();
        const existingLastName = (customerUser.lastName || "").trim().toLowerCase();
        const incomingFirstName = (customer.firstName || "").trim().toLowerCase();
        const incomingLastName = (customer.lastName || "").trim().toLowerCase();

        // If both first and last name are different, it's likely a different person using the same contact info.
        if (existingFirstName !== incomingFirstName || existingLastName !== incomingLastName) {
          const field = customerUser.email.toLowerCase() === customer.email.toLowerCase() ? "email" : "phone";
          return res.status(409).json({
            message: `This ${field} is already registered to another customer: ${customerUser.firstName} ${customerUser.lastName}. Please use unique contact details for ${customer.firstName} or use the existing customer's registered name.`,
            existingCustomer: {
              name: `${customerUser.firstName} ${customerUser.lastName}`,
              email: customerUser.email,
              phone: customerUser.phone
            }
          });
        }
      }

      // If not exists, create customer
      let tempPassword;
      if (!customerUser) {
        tempPassword =
          customer.password || `Cus@${Math.random().toString(36).slice(2, 10)}`;

        // ✅ CRITICAL: Retry logic to handle duplicate employeeId race conditions
        let retries = 0;
        const maxRetries = 5;
        let created = false;

        while (!created && retries < maxRetries) {
          try {
            const employeeId = await generateEmployeeId("CUSTOMER");
            customerUser = await User.create({
              employeeId,
              firstName: customer.firstName,
              middleName: customer.middleName || "",
              lastName: customer.lastName || "",
              email: customer.email.toLowerCase(),
              phone: customer.phone,
              password: customer.password,
              passwordHash: await argon2.hash(customer.password || tempPassword),
              role: ROLES.CUSTOMER,
              status: "ACTIVE",
              partnerId: assignedPartnerId || undefined,
              rmId: assignedRmId || undefined,
              referredBy: referralPartner?._id || undefined,
              referralRewardStatus: referralPartner?._id ? "PENDING" : "NONE",
            });
            created = true;
            console.log(`✅ Customer created with unique employeeId: ${employeeId}`);
          } catch (createError) {
            // Handle duplicate key error (E11000)
            if (createError.code === 11000 && createError.keyPattern?.employeeId) {
              retries++;
              console.warn(`⚠️ Duplicate employeeId detected (attempt ${retries}/${maxRetries}), retrying...`);
              if (retries >= maxRetries) {
                throw new Error(`Failed to create customer after ${maxRetries} attempts due to duplicate employeeId. Please try again.`);
              }
              // Wait a bit before retrying
              await new Promise(resolve => setTimeout(resolve, 100 * retries));
            } else {
              // Other errors, throw immediately
              throw createError;
            }
          }
        }
      }

      // Keep existing customer attached to owning partner/RM when fields were never set
      if (customerUser && assignedPartnerId) {
        const linkPatch = {};
        if (!customerUser.partnerId) linkPatch.partnerId = assignedPartnerId;
        if (!customerUser.rmId && assignedRmId) linkPatch.rmId = assignedRmId;
        if (Object.keys(linkPatch).length) {
          await User.updateOne({ _id: customerUser._id }, { $set: linkPatch });
          Object.assign(customerUser, linkPatch);
        }
      }

      // Map uploaded docs
      const docTypes = Array.isArray(req.body.docTypes)
        ? req.body.docTypes
        : req.body.docTypes
          ? [req.body.docTypes]
          : [];

      if (req.files?.length) {
        const viol = oversizeDocBatchViolation(req.files, docTypes);
        if (viol) {
          await deleteS3ObjectsForUploadedFiles(req.files);
          return res.status(400).json({ message: formatOversizeMessage(viol) });
        }
      }

      const newDocs = req.files.map((file, index) => {
        if (!file.location) {
          throw new Error("S3 upload failed: missing file location");
        }
        return {
          docType: normalizeIncomingDocType(docTypes[index] || "UNKNOWN"),
          url: file.location,
          uploadedBy: userId,
          status: "PENDING",
        };
      });


      // Prepare conditional sections
      let employmentInfo = null;
      let businessInfo = null;
      let propertyInfo = null;

      if (["PERSONAL", "HOME_LOAN_SALARIED"].includes(loanType)) {
        employmentInfo = {
          companyName: product.companyName,
          designation: product.designation,
          companyAddress: product.companyAddress || product.currentAddress,
          monthlySalary: product.monthlySalary,
          totalExperience: product.totalExperience,
          currentExperience: product.currentExperience,
          salaryInHand: product.salaryInHand,
        };
      }

      if (["BUSINESS", "HOME_LOAN_SELF_EMPLOYED"].includes(loanType)) {
        businessInfo = {
          businessName: product.businessName,
          businessAddress: product.businessAddress,
          businessLandmark: product.businessLandmark,
          businessVintage: product.businessVintage,
          gstNumber: product.gstNumber,
          annualTurnoverInINR: product.annualTurnoverInINR,
          yearsInBusiness: product.yearsInBusiness,
        };
      }

      if (
        ["HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED"].includes(loanType)
      ) {
        propertyInfo = {
          propertyType: product.propertyType,
          propertyValue: product.propertyValue,
          propertyAddress: product.propertyAddress,
        };
      }

      const refs = Array.isArray(references)
        ? references
        : references
          ? [references]
          : [];

      // Draft/incomplete can be updated; REJECTED history kept — reapply only after 3 months
      let existingApp = await Application.findOne({
        customerId: customerUser._id,
        status: { $in: ["DRAFT", "DOC_INCOMPLETE"] },
        isArchived: { $ne: true },
        $or: [{ deletedAt: null }, { deletedAt: { $gt: new Date() } }],
      }).sort({ updatedAt: -1 });

      if (!existingApp) {
        const blocker = await findCustomerApplyBlocker(customerUser._id);
        if (blocker) {
          return res.status(400).json({
            message: blocker.message,
            reason: blocker.type,
            existingAppNo: blocker.app?.appNo,
            existingStatus: blocker.app?.status,
            canApplyAfter: blocker.unlockAt || null,
          });
        }
      }

      const customerData = {
        firstName: customer.firstName,
        middleName: customer.middleName || "",
        lastName: customer.lastName || "",
        email: customer.email,
        officialEmail: customer.officialEmail || "",
        phone: customer.phone,
        alternatePhone: customer.alternatePhone || "",
        mothersName: customer.mothersName || "",
        panNumber: customer.panNumber || "",
        dateOfBirth: customer.dateOfBirth,
        gender: customer.gender,
        maritalStatus: customer.maritalStatus,
        spouseName: customer.spouseName || "",
        currentAddress: customer.currentAddress || "",
        currentAddressLandmark: customer.currentAddressLandmark || "",
        currentAddressPinCode: customer.currentAddressPinCode || "",
        currentAddressHouseStatus: customer.currentAddressHouseStatus || "",
        currentAddressOwnRented: customer.currentAddressOwnRented || "",
        currentAddressStability: customer.currentAddressStability || "",
        permanentAddress: customer.permanentAddress || "",
        permanentAddressLandmark: customer.permanentAddressLandmark || "",
        permanentAddressPinCode: customer.permanentAddressPinCode || "",
        permanentAddressHouseStatus: customer.permanentAddressHouseStatus || "",
        permanentAddressOwnRented: customer.permanentAddressOwnRented || "",
        permanentAddressStability: customer.permanentAddressStability || "",
        stabilityOfResidency: customer.stabilityOfResidency || "",
        loanAmount: Number(customer.loanAmount ?? 0),
        bankStatementPassword: customer.bankStatementPassword || "",
        partnerId: assignedPartnerId,
        rmId: assignedRmId,
        asmId: assignedAsmId,
      };

      if (
        existingApp &&
        ["DRAFT", "DOC_INCOMPLETE"].includes(existingApp.status)
      ) {
        // Partner resubmission should reflect only the docs uploaded in this request.
        // (Do NOT keep older docs that the partner didn't re-upload.)
        const docsToSave = newDocs;
        if (applicationStatus !== "DRAFT") {
          const missingDocs = findMissingMandatoryDocs(loanType, customer, docsToSave);
          if (missingDocs.length > 0) {
            return res.status(400).json({
              message: "Mandatory documents missing",
              missingDocs,
            });
          }
        }
        existingApp.docs = docsToSave;
        existingApp.customer = { ...existingApp.customer, ...customerData };
        existingApp.employmentInfo = employmentInfo;
        existingApp.businessInfo = businessInfo;
        existingApp.propertyInfo = propertyInfo;
        existingApp.coApplicant = coApplicant;
        existingApp.references = refs;
        existingApp.partnerId = assignedPartnerId;
        existingApp.rmId = assignedRmId;
        existingApp.asmId = assignedAsmId;
        // Keep DOC_INCOMPLETE status if it was DOC_INCOMPLETE, otherwise set to SUBMITTED
        // (Option A: new applications should not start in DRAFT)
        if (existingApp.status !== "DOC_INCOMPLETE") {
          existingApp.status = "SUBMITTED";
        }

        await existingApp.save();

        return res.status(200).json({
          message: "Application updated & resubmitted",
          id: existingApp._id,
          appNo: existingApp.appNo,
          status: existingApp.status,
          docs: existingApp.docs,
        });
      }

      // Otherwise create new application
      if (applicationStatus !== "DRAFT") {
        const missingDocs = findMissingMandatoryDocs(loanType, customer, newDocs);
        if (missingDocs.length > 0) {
          return res.status(400).json({
            message: "Mandatory documents missing",
            missingDocs,
          });
        }
      }

      // ✅ CRITICAL: Retry logic to handle duplicate appNo race conditions
      let app = null;
      let appRetries = 0;
      const maxAppRetries = 5;
      let appCreated = false;

      while (!appCreated && appRetries < maxAppRetries) {
        try {
          const appNo = await generateEmployeeId("APPLICATION");
          app = await Application.create({
            appNo,
            partnerId: assignedPartnerId,
            rmId: assignedRmId,
            asmId: assignedAsmId,
            customerId: customerUser._id,
            loanType,
            customer: customerData,
            docs: newDocs,
            references: refs,
            employmentInfo,
            businessInfo,
            propertyInfo,
            coApplicant,
            status: "SUBMITTED",
            stageHistory: [],
          });
          appCreated = true;
          console.log(`✅ Application created with unique appNo: ${appNo}`);
        } catch (createError) {
          // Handle duplicate key error (E11000)
          if (createError.code === 11000 && createError.keyPattern?.appNo) {
            appRetries++;
            console.warn(`⚠️ Duplicate appNo detected (attempt ${appRetries}/${maxAppRetries}), retrying...`);
            if (appRetries >= maxAppRetries) {
              throw new Error(`Failed to create application after ${maxAppRetries} attempts due to duplicate appNo. Please try again.`);
            }
            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, 100 * appRetries));
          } else if (
            createError.code === 11000 &&
            (createError.keyPattern?.partnerId ||
              createError.keyPattern?.customerId ||
              createError.keyPattern?.loanType)
          ) {
            const dedupedApp = await Application.findOne({
              partnerId: assignedPartnerId,
              customerId: customerUser._id,
              loanType,
              deletedAt: null,
              status: { $in: ACTIVE_APPLICATION_STATUSES },
            }).sort({ createdAt: -1 });
            if (dedupedApp) {
              app = dedupedApp;
              appCreated = true;
              console.warn(
                `⚠️ Duplicate create blocked, reusing existing application ${dedupedApp._id}`
              );
              continue;
            }
            throw createError;
          } else {
            // Other errors, throw immediately
            throw createError;
          }
        }
      }

      // Send email using professional email service
      let emailSent = false;
      try {
        const customerData = {
          firstName: customer.firstName,
          email: customerUser.email,
        };
        emailSent = await sendLoanApplicationEmail(
          customerData,
          {
            appNo: app.appNo,
            loanType: app.loanType,
            status: app.status,
            appliedLoanAmount: customer.loanAmount || 0,
            loanAmount: customer.loanAmount || 0,
          },
          customer.password ? null : tempPassword
        );
        if (emailSent) {
          console.log(`✅ Application creation email sent to: ${customerUser.email}`);
        }
      } catch (mailErr) {
        console.error("❌ Email send failed:", mailErr.message);
        // Don't fail the request if email fails - application is still created
      }

      res.status(201).json({
        message: emailSent
          ? "Application + Customer created and Email has been sent"
          : "Application + Customer created (Email sending failed, but application was saved)",
        id: app._id,
        appNo: app.appNo,
        status: app.status,
        emailSent,
        customerLogin: {
          email: customerUser.email,
          password: customer.password ? customer.password : tempPassword,
        },
        docs: app.docs,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

/**
 * Wizard init: create application + customer early (no docs/references validation).
 * Frontend stepper uses this to autosave step-by-step before documents are uploaded.
 */
router.post(
  "/applications/init",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const { loanType = "PERSONAL", customer = {} } = req.body || {};

      if (
        !loanType ||
        !Application.schema.path("loanType").enumValues.includes(loanType)
      ) {
        return res.status(400).json({ message: "A valid loanType is required" });
      }

      const normalizePhone = (value) => {
        const digits = String(value ?? "").replace(/\D/g, "");
        if (!digits) return "";
        if (digits.length >= 10) return digits.slice(-10);
        return digits;
      };

      const normalizeEmail = (value) => {
        return String(value ?? "").trim().replace(/\s+/g, "");
      };

      const normalizedEmail = normalizeEmail(customer.email).toLowerCase();
      const normalizedPhone = normalizePhone(customer.phone);

      if (!customer.firstName || !customer.lastName) {
        return res
          .status(400)
          .json({ message: "Customer firstName and lastName are required" });
      }
      if (!normalizedEmail || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
        return res.status(400).json({ message: "Valid customer email is required" });
      }
      if (!normalizedPhone || !/^\d{10}$/.test(normalizedPhone)) {
        return res.status(400).json({ message: "Valid 10-digit customer phone is required" });
      }

      const partner = await User.findOne({ _id: partnerId, role: ROLES.PARTNER });
      if (!partner?.rmId) {
        return res.status(400).json({ message: "Partner is not mapped to an RM" });
      }

      const rm = await User.findById(partner.rmId);
      const assignedRmId = partner.rmId;
      const assignedAsmId = rm?.asmId || null;

      // Create or reuse customer user
      const tempPassword =
        customer.password || `Temp@${Math.random().toString(36).slice(2, 10)}`;

      let customerUser = await User.findOne({
        $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
        role: ROLES.CUSTOMER,
      });

      // ✅ IDENTITY VALIDATION
      if (customerUser) {
        const existingFirstName = (customerUser.firstName || "").trim().toLowerCase();
        const existingLastName = (customerUser.lastName || "").trim().toLowerCase();
        const incomingFirstName = (customer.firstName || "").trim().toLowerCase();
        const incomingLastName = (customer.lastName || "").trim().toLowerCase();

        if (existingFirstName !== incomingFirstName || existingLastName !== incomingLastName) {
          const field = customerUser.email.toLowerCase() === normalizedEmail ? "email" : "phone";
          return res.status(409).json({
            message: `This ${field} is already registered to another customer: ${customerUser.firstName} ${customerUser.lastName}.`,
            existingCustomer: {
              name: `${customerUser.firstName} ${customerUser.lastName}`,
            }
          });
        }
      }

      if (!customerUser) {
        const employeeId = await generateEmployeeId("CUSTOMER");
        customerUser = await User.create({
          employeeId,
          firstName: customer.firstName,
          middleName: customer.middleName || "",
          lastName: customer.lastName,
          email: normalizedEmail,
          phone: normalizedPhone,
          passwordHash: await argon2.hash(tempPassword),
          role: ROLES.CUSTOMER,
          status: "ACTIVE",
          partnerId,
          rmId: assignedRmId,
        });
      }

      if (customerUser) {
        const linkPatch = {};
        if (!customerUser.partnerId) linkPatch.partnerId = partnerId;
        if (!customerUser.rmId && assignedRmId) linkPatch.rmId = assignedRmId;
        if (Object.keys(linkPatch).length) {
          await User.updateOne({ _id: customerUser._id }, { $set: linkPatch });
          Object.assign(customerUser, linkPatch);
        }
      }

      // Create application skeleton
      let app = null;
      let appCreated = false;
      let appRetries = 0;
      const maxAppRetries = 5;

      while (!appCreated && appRetries < maxAppRetries) {
        try {
          const appNo = await generateEmployeeId("APPLICATION");
          app = await Application.create({
            appNo,
            partnerId,
            rmId: assignedRmId,
            asmId: assignedAsmId,
            customerId: customerUser._id,
            loanType,
            customer: {
              firstName: customer.firstName,
              middleName: customer.middleName || "",
              lastName: customer.lastName || "",
              email: normalizedEmail,
              officialEmail: customer.officialEmail,
              phone: normalizedPhone,
              mothersName: customer.mothersName,
              panNumber: customer.panNumber,
              dateOfBirth: customer.dateOfBirth,
              gender: customer.gender,
              maritalStatus: customer.maritalStatus,
              spouseName: customer.spouseName,
            },
            references: [],
            docs: [],
            employmentInfo: null,
            businessInfo: null,
            propertyInfo: null,
            status: "SUBMITTED",
            stageHistory: [],
          });
          appCreated = true;
        } catch (createError) {
          if (createError.code === 11000 && createError.keyPattern?.appNo) {
            appRetries++;
            if (appRetries >= maxAppRetries) {
              throw new Error(
                `Failed to create application after ${maxAppRetries} attempts due to duplicate appNo.`
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * appRetries));
          } else {
            throw createError;
          }
        }
      }

      if (!app) {
        return res.status(500).json({ message: "Failed to initialize application" });
      }

      return res.status(201).json({
        message: "Application initialized successfully",
        id: app._id,
        appNo: app.appNo,
        status: app.status,
        customerLogin: {
          email: customerUser.email,
          password: tempPassword,
        },
      });
    } catch (err) {
      console.error("Wizard init error:", err);
      return res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

/**
 * Wizard save-step: update application partially for stepper autosave.
 * Note: this endpoint intentionally does NOT require docs/references.
 */
router.patch(
  "/applications/:id/save-step",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const { id } = req.params;
      const { step, customer, employmentInfo, references, password } = req.body || {};

      if (!step) {
        return res.status(400).json({ message: "step is required" });
      }

      const application = await Application.findOne({
        _id: id,
        partnerId,
      });

      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      const normalizePhone = (value) => {
        const digits = String(value ?? "").replace(/\D/g, "");
        if (!digits) return "";
        if (digits.length >= 10) return digits.slice(-10);
        return digits;
      };

      if (step === "address") {
        application.customer = {
          ...application.customer,
          ...(customer || {}),
        };
      } else if (step === "loan") {
        if (customer?.loanAmount !== undefined) {
          application.customer.loanAmount = Number(customer.loanAmount) || 0;
          application.requestedAmount = application.customer.loanAmount;
        }
      } else if (step === "employment") {
        application.employmentInfo = {
          ...(application.employmentInfo || {}),
          ...(employmentInfo || {}),
        };
      } else if (step === "review") {
        if (Array.isArray(references)) {
          application.references = references
            .filter(Boolean)
            .map((r) => ({
              name: r.name,
              phone: normalizePhone(r.phone),
            }));
        }

        if (password) {
          application.customer.password = password;
          const customerUser = await User.findById(application.customerId);
          if (customerUser) {
            customerUser.passwordHash = await argon2.hash(password);
            await customerUser.save();
          }
        }
      } else {
        return res.status(400).json({ message: `Unknown step: ${step}` });
      }

      await application.save();
      return res.json({
        message: "Step saved successfully",
        id: application._id,
        status: application.status,
      });
    } catch (err) {
      console.error("Wizard save-step error:", err);
      return res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

/** Partner submits application => (no-op if already SUBMITTED) */
router.post(
  "/applications/:id/submit",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    const app = await Application.findOne({
      _id: req.params.id,
      partnerId: req.user.sub,
    }).populate("customerId");
    if (!app) return res.status(404).json({ message: "Application not found" });

    try {
      const oldStatus = app.status;

      // Option A: new apps are created directly as SUBMITTED,
      // so this endpoint should be safe to call multiple times.
      if (oldStatus === "SUBMITTED") {
        const alreadyLogged =
          Array.isArray(app.stageHistory) &&
          app.stageHistory.some(
            (s) => s?.from === "SUBMITTED" && s?.to === "SUBMITTED" && s?.note === "Partner submitted"
          );

        if (!alreadyLogged) {
          app.stageHistory.push({
            from: "SUBMITTED",
            to: "SUBMITTED",
            by: req.user.sub,
            note: "Partner submitted",
          });
          await app.save();

          // Send email notification to customer about submission
          setImmediate(async () => {
            try {
              if (app.customerId && app.customerId.email) {
                const { sendApplicationStatusEmail } = await import("../utils/emailService.js");
                await sendApplicationStatusEmail(
                  {
                    firstName:
                      app.customer?.firstName || app.customerId.firstName || "Customer",
                    email: app.customerId.email,
                  },
                  {
                    appNo: app.appNo,
                    loanType: app.loanType,
                    status: app.status,
                  },
                  oldStatus,
                  "SUBMITTED"
                );
              }
            } catch (mailErr) {
              console.error("❌ Failed to send submission email:", mailErr.message);
              // Don't fail the request if email fails
            }
          });
        }

        return res.json({ message: "Submitted", status: app.status });
      }

      if (oldStatus === "DOC_INCOMPLETE") {
        const alreadyLogged =
          Array.isArray(app.stageHistory) &&
          app.stageHistory.some(
            (s) =>
              s?.from === "DOC_INCOMPLETE" &&
              s?.to === "DOC_INCOMPLETE" &&
              s?.note === "Partner submitted"
          );

        if (!alreadyLogged) {
          app.stageHistory.push({
            from: "DOC_INCOMPLETE",
            to: "DOC_INCOMPLETE",
            by: req.user.sub,
            note: "Partner submitted",
          });
          await app.save();

          setImmediate(async () => {
            try {
              if (app.customerId && app.customerId.email) {
                const { sendApplicationStatusEmail } = await import(
                  "../utils/emailService.js"
                );
                await sendApplicationStatusEmail(
                  {
                    firstName:
                      app.customer?.firstName ||
                      app.customerId.firstName ||
                      "Customer",
                    email: app.customerId.email,
                  },
                  {
                    appNo: app.appNo,
                    loanType: app.loanType,
                    status: app.status,
                  },
                  oldStatus,
                  "DOC_INCOMPLETE"
                );
              }
            } catch (mailErr) {
              console.error("❌ Failed to send submission email:", mailErr.message);
            }
          });
        }

        return res.json({ message: "Submitted", status: app.status });
      }

      // For older records, allow DRAFT -> SUBMITTED.
      if (oldStatus === "DRAFT") {
        app.transition("SUBMITTED", req.user.sub, "Partner submitted");
        await app.save();

        // Send email notification to customer about submission
        setImmediate(async () => {
          try {
            if (app.customerId && app.customerId.email) {
              const { sendApplicationStatusEmail } = await import("../utils/emailService.js");
              await sendApplicationStatusEmail(
                {
                  firstName:
                    app.customer?.firstName || app.customerId.firstName || "Customer",
                  email: app.customerId.email,
                },
                {
                  appNo: app.appNo,
                  loanType: app.loanType,
                  status: app.status,
                },
                oldStatus,
                "SUBMITTED"
              );
            }
          } catch (mailErr) {
            console.error("❌ Failed to send submission email:", mailErr.message);
            // Don't fail the request if email fails
          }
        });

        return res.json({ message: "Submitted", status: app.status });
      }

      return res.status(400).json({
        message: `Cannot submit application from status ${oldStatus}`,
      });
    } catch (e) {
      res.status(400).json({ message: e.message });
    }
  }
);

/** Partner-visible apps: include REJECTED until scheduled delete runs (deletedAt in future). */
function partnerVisibleAppsFilter(partnerId) {
  return {
    partnerId,
    isArchived: { $ne: true },
    $or: [
      { deletedAt: null },
      { deletedAt: { $gt: new Date() } },
    ],
  };
}

function resolveAppRemarks(app) {
  if (app?.remarks) return app.remarks;
  const history = app?.stageHistory;
  if (Array.isArray(history) && history.length) {
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry?.note && String(entry.note).trim()) {
        return entry.note;
      }
    }
  }
  return null;
}

/** Partner views own applications with customer + payout info */
router.get(
  "/get-applications",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const apps = await Application.find(partnerVisibleAppsFilter(req.user.sub))
        .populate("customerId", "firstName lastName email phone") // fetch linked user
        .lean();

      // fetch payouts separately and attach them
      const appsWithPayouts = await Promise.all(
        apps.map(async (app) => {
          // Mask internal statuses for Partner:
          // - LOGIN is shown as DOC_COMPLETE
          const maskedStatus =
            app.status === "LOGIN" ? "DOC_COMPLETE" : app.status;

          const payouts = await Payout.find(
            { application: app._id }, // ✅ use correct field name
            "amount status note createdAt"
          ).lean();

          return {
            ...app,
            status: maskedStatus,
            remarks: resolveAppRemarks(app),
            payouts,
          };
        })
      );

      res.json(appsWithPayouts);
    } catch (err) {
      console.error("Error fetching partner applications:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/** Partner views single application with customer + payout */
router.get(
  "/get-application/:id",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid application ID" });
      }

      // Find application belonging to logged-in partner
      const app = await Application.findOne({
        _id: id,
        partnerId: req.user.sub,
      })
        .populate("customerId", "firstName lastName email phone")
        .lean();

      if (!app) {
        return res
          .status(404)
          .json({ message: "Application not found or not accessible" });
      }

      // Mask internal statuses for Partner:
      // - LOGIN is shown as DOC_COMPLETE
      const maskedStatus =
        app.status === "LOGIN" ? "DOC_COMPLETE" : app.status;

      const appWithMaskedStatus = {
        ...app,
        status: maskedStatus,
      };

      // Get payouts for this application
      const payouts = await Payout.find({ application: app._id })
        .select("amount status note createdAt")
        .lean();

      return res.json({
        application: appWithMaskedStatus,
        payouts,
      });
    } catch (err) {
      console.error("Error fetching application:", err);
      return res.status(500).json({
        message: "Server error while fetching application",
        error: err.message,
      });
    }
  }
);

// Partner views their own application with docs (editable on frontend)                 ---------  for edit and update
router.get(
  "/applications/:applicationId",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const { applicationId } = req.params;

      const application = await Application.findOne({
        _id: applicationId,
        partnerId: req.user.sub,
      })
        .populate("customerId", "firstName lastName email phone")
        .populate("rmId", "firstName lastName email phone")
        .populate("docs.uploadedBy", "firstName lastName email")
        .lean();

      if (!application) {
        return res.status(404).json({
          message: "Application not found or not accessible",
        });
      }

      // Mask internal statuses for Partner:
      // - LOGIN is shown as DOC_COMPLETE
      const maskedStatus =
        application.status === "LOGIN" ? "DOC_COMPLETE" : application.status;

      return res.json({
        ...application,
        status: maskedStatus,
      });
    } catch (err) {
      console.error("Error fetching partner application:", err);
      return res
        .status(500)
        .json({ message: "Error fetching application details" });
    }
  }
);

router.get("/customers", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const partnerId = req.user.sub; // Partner logged in

    // Find all applications under this Partner (incl. REJECTED until auto-delete)
    const applications = await Application.find(partnerVisibleAppsFilter(partnerId))
      .populate("customerId", "employeeId firstName lastName email phone")
      .populate("rmId", "firstName lastName email phone")
      .lean();

    // Get all applicationIds for this partner
    const applicationIds = applications.map((app) => app._id);

    // Find all payouts for these applications
    const payouts = await Payout.find({
      application: { $in: applicationIds },
    }).lean();

    // Map payouts by applicationId for fast access
    const payoutMap = payouts.reduce((acc, payout) => {
      acc[payout.application.toString()] = payout.amount; // ✅ only amount
      return acc;
    }, {});

    // Map customers list with application summary + payout amount + documents
    const customers = applications.map((app) => ({
      customerId: app.customerId?._id,
      customerEmployeeId: app.customerId?.employeeId || null,
      customerName: app.customer?.firstName
        ? `${app.customer.firstName} ${app.customer.lastName || ""}`.trim()
        : `${app.customerId?.firstName ?? ""} ${app.customerId?.lastName ?? ""}`.trim(),
      contact: app.customerId?.phone || null,
      email: app.customerId?.email || null,
      loanType: app.loanType,
      loanAmount: app.customer?.loanAmount || null,
      approvedAmount: app.approvedLoanAmount || null,
      // Mask internal statuses for Partner:
      // - LOGIN is shown as DOC_COMPLETE
      status: app.status === "LOGIN" ? "DOC_COMPLETE" : app.status,
      payoutAmount: payoutMap[app._id.toString()] || 0, // ✅ only payout amount
      docs: app.docs || [], // ✅ Include documents for incomplete doc tracking
      remarks: resolveAppRemarks(app), // rejection remark from app.remarks or stageHistory
      rm: {
        rmId: app.rmId?._id,
        name: `${app.rmId?.firstName ?? ""} ${app.rmId?.lastName ?? ""}`.trim(),
        email: app.rmId?.email,
        phone: app.rmId?.phone,
      },
      applicationId: app._id,
      createdAt: app.createdAt,
    }));

    return res.json(customers);
  } catch (err) {
    console.error("Error fetching Partner customers:", err);
    return res
      .status(500)
      .json({ message: "Error fetching Partner customers" });
  }
});

// ✅ Get full loan application details (everything from schema)
router.get(
  "/customers/:customerId/applications/:applicationId",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub; // Partner logged in
      const { customerId, applicationId } = req.params;

      // Find the full application belonging to this Partner + Customer
      const application = await Application.findOne({
        _id: applicationId,
        partnerId,
        customerId,
      })
        .populate("customerId", "firstName lastName email phone") // 👤 Customer info
        .populate("partnerId", "firstName lastName email phone") // 👔 Partner info
        .populate("rmId", "firstName lastName email phone") // 🧑‍💼 RM info
        .populate("docs.uploadedBy", "firstName lastName email") // 📄 Who uploaded documents
        .lean();

      if (!application) {
        return res.status(404).json({
          message: "Application not found or not assigned to this Partner",
        });
      }

      return res.json(application);
    } catch (err) {
      console.error("Error fetching full Partner application details:", err);
      return res
        .status(500)
        .json({ message: "Error fetching Partner application details" });
    }
  }
);

router.get("/dashboard", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const partnerId = req.user.sub;
    const { year, month, start, end } = req.query;

    // ------------------
    // 1️⃣ Build filter for Applications (Fetch all for this period/partner)
    // ------------------
    const match = {
      ...partnerVisibleAppsFilter(new mongoose.Types.ObjectId(partnerId)),
    };

    // Note: We'll filter by date in-memory for some stats to allowed
    // Section 6 (Monthly Targets) to see the whole year's data if needed,
    // and Section 7 (Current Month Target) to be accurate.
    const applications = await Application.find(match).lean();

    // In-memory filter for the requested period (for top-level stats)
    const hasYearMonth = year && month;
    const hasRange = start && end;
    let periodStart = null;
    let periodEnd = null;

    if (hasYearMonth) {
      const parsedYear = parseInt(year, 10);
      const parsedMonth = parseInt(month, 10);
      periodStart = new Date(parsedYear, parsedMonth - 1, 1);
      periodEnd = new Date(parsedYear, parsedMonth, 1);
    } else if (hasRange) {
      periodStart = new Date(start);
      periodEnd = new Date(end);
    }

    const filteredApps = (periodStart && periodEnd)
      ? applications.filter(a => a.createdAt >= periodStart && a.createdAt < periodEnd)
      : applications;

    const totalFiles = filteredApps.length;
    const approvedFiles = filteredApps.filter(
      (a) => a.status === "APPROVED"
    ).length;
    const rejectedFiles = filteredApps.filter(
      (a) => a.status === "REJECTED"
    ).length;
    const docsIncomplete = filteredApps.filter(
      (a) => a.status === "DOC_INCOMPLETE"
    ).length;
    const inProcessFiles = filteredApps.filter((a) =>
      ["UNDER_REVIEW", "SUBMITTED", "DRAFT"].includes(a.status)
    ).length;

    // Total disbursed (also within the period)
    const disbursedApps = filteredApps.filter((a) => a.status === "DISBURSED");
    const totalDisburseAmount = disbursedApps.reduce(
      (sum, app) => sum + (app.approvedLoanAmount || 0),
      0
    );
    const partnerEarnCount = disbursedApps.length;

    // ------------------
    // 3️⃣ Payout calculation (for the requested period)
    // ------------------
    const payoutMatch = {
      partnerId: new mongoose.Types.ObjectId(partnerId),
      payOutStatus: "DONE",
    };
    if (periodStart && periodEnd) {
      payoutMatch.createdAt = { $gte: periodStart, $lt: periodEnd };
    }

    const payoutAgg = await Payout.aggregate([
      { $match: payoutMatch },
      { $group: { _id: null, totalPayout: { $sum: "$amount" } } },
    ]);
    const totalPayout = payoutAgg[0]?.totalPayout || 0;

    // ------------------
    // 3.1️⃣ Monthly Payout calculation (last 3 months)
    // ------------------
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-12

    // Calculate last 3 months payout breakdown
    // Get all payouts and group by month
    const monthlyPayoutAgg = await Payout.aggregate([
      {
        $match: {
          partnerId: new mongoose.Types.ObjectId(partnerId),
          payOutStatus: "DONE",
        },
      },
      {
        $project: {
          amount: 1,
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
        },
      },
      {
        $group: {
          _id: { year: "$year", month: "$month" },
          total: { $sum: "$amount" },
        },
      },
    ]);

    // Map monthly payouts to month names
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

    const monthlyPayouts = {};
    monthlyPayoutAgg.forEach((item) => {
      const monthName = monthNames[item._id.month - 1];
      monthlyPayouts[monthName] = item.total || 0;
    });

    // Build last 3 months array in chronological order (oldest to newest)
    // We need to match by both year and month, but for display we'll use month name
    // For last 3 months, we'll aggregate by year-month combination
    const last3MonthsPayouts = [];
    for (let i = 3; i >= 1; i--) {
      // Calculate which month we're looking for (i months ago)
      let targetMonth = currentMonth - i;
      let targetYear = currentYear;

      // Handle year rollover
      while (targetMonth <= 0) {
        targetMonth += 12;
        targetYear -= 1;
      }

      const monthName = monthNames[targetMonth - 1]; // monthNames is 0-indexed

      // Find matching payout for this year-month combination
      const matchingPayout = monthlyPayoutAgg.find(
        (p) => p._id.year === targetYear && p._id.month === targetMonth
      );

      last3MonthsPayouts.push({
        month: monthName,
        earning: matchingPayout ? matchingPayout.total : 0,
      });
    }

    // Calculate current month earning
    const currentMonthName = monthNames[currentMonth - 1];
    const currentMonthPayout = monthlyPayoutAgg.find(
      (p) => p._id.year === currentYear && p._id.month === currentMonth
    );
    const currentMonthEarning = currentMonthPayout ? currentMonthPayout.total : 0;

    // Build all years earnings array (for lifetime earnings breakdown)
    // Group by year and sum all months for each year
    const yearlyPayoutAgg = await Payout.aggregate([
      {
        $match: {
          partnerId: new mongoose.Types.ObjectId(partnerId),
          payOutStatus: "DONE",
        },
      },
      {
        $project: {
          amount: 1,
          year: { $year: "$createdAt" },
        },
      },
      {
        $group: {
          _id: { year: "$year" },
          total: { $sum: "$amount" },
        },
      },
      {
        $sort: { "_id.year": 1 }, // Sort by year ascending (oldest first)
      },
    ]);

    // Format yearly payouts
    const allYearsPayouts = yearlyPayoutAgg.map((item) => ({
      year: item._id.year.toString(),
      earning: item.total || 0,
    }));

    // ------------------
    // 4️⃣ Monthly target & achieved
    // ------------------
    const currentMonthForTarget = month ? parseInt(month) : currentMonth; // 1-12
    const currentYearForTarget = year ? parseInt(year) : currentYear;

    const targetDoc = await Target.findOne({
      assignedTo: new mongoose.Types.ObjectId(partnerId),
      role: ROLES.PARTNER,
      month: currentMonthForTarget,
      year: currentYearForTarget,
    }).lean();

    const achievedAgg = await Application.aggregate([
      {
        $match: {
          partnerId: new mongoose.Types.ObjectId(partnerId),
          status: "DISBURSED",
          $expr: {
            $and: [
              {
                $eq: [
                  { $month: { $ifNull: ["$disbursedDate", "$createdAt"] } },
                  currentMonthForTarget,
                ],
              },
              {
                $eq: [
                  { $year: { $ifNull: ["$disbursedDate", "$createdAt"] } },
                  currentYearForTarget,
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

    const targetValue = targetDoc
      ? Number(targetDoc.disbursementTarget || targetDoc.targetValue || 0)
      : 0;
    const fileTarget = targetDoc ? Number(targetDoc.fileCountTarget || 0) : 0;
    const achievedValue =
      achievedAgg.length > 0 ? Number(achievedAgg[0].total) : 0;

    // ------------------
    // 5️⃣ RM Details
    // ------------------
    const partner = await User.findById(partnerId).lean();
    let rm = null;
    if (partner?.rmId) {
      rm = await User.findById(partner.rmId).lean();
    }

    // ------------------
    // 6️⃣ Monthly performance (approved, rejected, inProcess, disbursed)
    // ------------------
    const months = [
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

    // ------------------
    // 6️⃣ Monthly target & achieved (File Count + Disbursement)
    // ------------------
    const monthlyTargets = {};
    for (let i = 0; i < 12; i++) {
      const monthNumber = i + 1;
      const monthStart = new Date(currentYearForTarget, monthNumber - 1, 1);
      const monthEnd = new Date(currentYearForTarget, monthNumber, 1);

      // Get target for the month (hybrid model: File Count + Disbursement)
      const targetDoc = await Target.findOne({
        assignedTo: new mongoose.Types.ObjectId(partnerId),
        role: ROLES.PARTNER,
        month: monthNumber,
        year: currentYearForTarget,
      }).lean();

      const fileCountTarget = targetDoc ? (targetDoc.fileCountTarget || 4) : 4;
      const disbursementTarget = targetDoc ? (targetDoc.disbursementTarget || targetDoc.targetValue || 2000000) : 2000000;

      // Calculate achieved for the month
      const monthRelevantApps = applications.filter((a) => {
        const appUpdatedAt = a.updatedAt || a.createdAt;
        return (
          a.status !== "DRAFT" &&
          appUpdatedAt >= monthStart &&
          appUpdatedAt < monthEnd
        );
      });

      const achievedFileCount = monthRelevantApps.length;
      const achievedDisbursement = monthRelevantApps
        .filter(a => a.status === "DISBURSED")
        .reduce(
          (sum, a) => sum + (parseFloat(a.approvedLoanAmount) || 0),
          0
        );

      monthlyTargets[months[i]] = {
        fileCountTarget,
        achievedFileCount,
        disbursementTarget,
        achievedDisbursement,
        target: disbursementTarget, // Legacy field for backward compatibility
        achieved: achievedDisbursement, // Legacy field for backward compatibility
      };
    }

    // ------------------
    // 7️⃣ Current Month Target (for dashboard display)
    // ------------------
    // Use the already declared currentMonth and currentYear from above
    // const currentMonth = new Date().getMonth() + 1; // Already declared at line 1563
    // const currentYear = new Date().getFullYear(); // Already declared at line 1562
    const currentMonthTarget = await Target.findOne({
      assignedTo: new mongoose.Types.ObjectId(partnerId),
      role: ROLES.PARTNER,
      month: currentMonth,
      year: currentYear,
    }).lean();

    const currentMonthStart = new Date(currentYear, currentMonth - 1, 1);
    const currentMonthEnd = new Date(currentYear, currentMonth, 1);

    // Get all non-draft applications for current month (for file count)
    const currentMonthRelevantApps = applications.filter((a) => {
      const appUpdatedAt = a.updatedAt || a.createdAt;
      return (
        a.status !== "DRAFT" &&
        appUpdatedAt >= currentMonthStart &&
        appUpdatedAt < currentMonthEnd
      );
    });

    const currentFileCountTarget = currentMonthTarget?.fileCountTarget || 4;
    const currentDisbursementTarget = currentMonthTarget?.disbursementTarget || currentMonthTarget?.targetValue || 2000000;

    const currentAchievedFileCount = currentMonthRelevantApps.length;
    const currentAchievedDisbursement = currentMonthRelevantApps
      .filter(a => a.status === "DISBURSED")
      .reduce(
        (sum, a) => sum + (parseFloat(a.approvedLoanAmount) || 0),
        0
      );

    // ------------------
    // 8️⃣ Incentive history (from Incentive collection)
    // ------------------
    const incentives = await Incentive.find({
      partnerId: partner._id,
    })
      .sort({ createdAt: -1 })
      .lean();

    const totalIncentivePaid = incentives
      .filter((inv) => inv.status === "PAID")
      .reduce((sum, inv) => sum + (inv.amount || 0), 0);

    const pendingIncentiveAmount = incentives
      .filter((inv) => inv.status === "PENDING")
      .reduce((sum, inv) => sum + (inv.amount || 0), 0);

    // ------------------
    // 8.1️⃣ Referral rewards (partner→partner): current month summary + preview
    // ------------------
    const refMonthStart = new Date(currentYear, currentMonth - 1, 1);
    const refMonthEnd = new Date(currentYear, currentMonth, 1);
    const referralRewardMatch = {
      referrerId: new mongoose.Types.ObjectId(partnerId),
      createdAt: { $gte: refMonthStart, $lt: refMonthEnd },
    };

    const referralRewardStatusAgg = await ReferralReward.aggregate([
      { $match: referralRewardMatch },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]);

    const referralRewardsByStatus = {
      PENDING: { count: 0, totalAmount: 0 },
      APPROVED: { count: 0, totalAmount: 0 },
      PAID: { count: 0, totalAmount: 0 },
      CANCELLED: { count: 0, totalAmount: 0 },
    };
    for (const row of referralRewardStatusAgg) {
      const key = row._id;
      if (referralRewardsByStatus[key]) {
        referralRewardsByStatus[key] = {
          count: row.count || 0,
          totalAmount: row.totalAmount || 0,
        };
      }
    }

    const referralRewardsPreviewRaw = await ReferralReward.find({
      referrerId: partnerId,
      createdAt: { $gte: refMonthStart, $lt: refMonthEnd },
    })
      .sort({ createdAt: -1 })
      .limit(8)
      .populate("referredUserId", "firstName lastName partnerCode")
      .populate("applicationId", "appNo loanType")
      .lean();

    const referralRewardsPreview = referralRewardsPreviewRaw.map((r) => {
      const u = r.referredUserId;
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(" ") || "—"
        : "—";
      const code = u?.partnerCode ? String(u.partnerCode).trim() : "";
      const downlineLabel = code ? `${name} · ${code}` : name;
      return {
        _id: r._id,
        amount: r.amount,
        status: r.status,
        eventType: r.eventType,
        createdAt: r.createdAt,
        downlineLabel,
        appNo: r.applicationId?.appNo || null,
      };
    });

    const referralRewardsMonthTotal = Object.values(referralRewardsByStatus).reduce(
      (s, x) => s + (Number(x.totalAmount) || 0),
      0
    );
    const referralRewardsPaidTotal =
      referralRewardsByStatus.PAID.totalAmount || 0;

    // ------------------
    // 9️⃣ Response
    // ------------------
    res.json({
      totalFiles,
      approvedFiles,
      rejectedFiles,
      inProcessFiles,
      docsIncomplete,
      totalDisburseAmount,
      totalPayout,
      partnerEarnCount,
      target: targetValue, // Legacy field
      achievedTarget: achievedValue, // Legacy field
      // Current month target (hybrid model)
      currentMonthTarget: {
        fileCountTarget: currentFileCountTarget,
        achievedFileCount: currentAchievedFileCount,
        disbursementTarget: currentDisbursementTarget,
        achievedDisbursement: currentAchievedDisbursement,
        fileTargetMet: currentAchievedFileCount >= currentFileCountTarget,
        disbursementTargetMet: currentAchievedDisbursement >= currentDisbursementTarget,
        targetAchieved: currentAchievedFileCount >= currentFileCountTarget &&
          currentAchievedDisbursement >= currentDisbursementTarget,
      },
      rm: rm
        ? {
          name: rm.firstName + " " + rm.lastName,
          contact: rm.phone,
          email: rm.email,
          employeeId: rm.employeeId,
        }
        : null,
      // monthlyPerformance,
      monthlyTargets,
      monthlyPayouts: last3MonthsPayouts, // Last 3 months payout breakdown
      allYearsPayouts, // All years payout breakdown for lifetime earnings
      currentMonthEarning, // Current month earning
      incentives,
      totalIncentivePaid,
      pendingIncentiveAmount,
      referralRewards: {
        month: currentMonth,
        year: currentYear,
        monthTotal: referralRewardsMonthTotal,
        paidTotal: referralRewardsPaidTotal,
        byStatus: referralRewardsByStatus,
        preview: referralRewardsPreview,
      },
    });
  } catch (err) {
    console.error("Partner dashboard error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ✅ Partner payout history (detailed list only for payouts)
router.get(
  "/payouts/history",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const { year, month } = req.query;

      const match = {
        partnerId: new mongoose.Types.ObjectId(partnerId),
        payOutStatus: "DONE",
      };

      if (year && !month) {
        const y = parseInt(year, 10);
        if (!isNaN(y)) {
          match.createdAt = {
            $gte: new Date(y, 0, 1),
            $lt: new Date(y + 1, 0, 1),
          };
        }
      }

      if (year && month) {
        const y = parseInt(year, 10);
        const m = parseInt(month, 10); // 1-12
        if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
          match.createdAt = {
            $gte: new Date(y, m - 1, 1),
            $lt: new Date(y, m, 1),
          };
        }
      }

      const payouts = await Payout.find(match)
        .populate("application", "appNo loanType approvedLoanAmount createdAt customer")
        .sort({ createdAt: -1 })
        .lean();

      const formatted = payouts.map((p) => ({
        id: p._id,
        amount: p.amount || 0,
        status: p.payOutStatus,
        notes: p.notes || "",
        createdAt: p.createdAt,
        application: p.application
          ? {
            appNo: p.application.appNo || "",
            loanType: p.application.loanType || "",
            approvedLoanAmount: p.application.approvedLoanAmount || 0,
            createdAt: p.application.createdAt,
            customer: p.application.customer,
          }
          : null,
      }));

      return res.json({ payouts: formatted });
    } catch (err) {
      console.error("Error fetching Partner payout history:", err);
      return res
        .status(500)
        .json({ message: "Error fetching Partner payout history" });
    }
  }
);

// router.get("/profile", auth, requireRole(ROLES.PARTNER), async (req, res) => {
//   try {
//     const partner = await User.findById(req.user.sub)
//       .select("-passwordHash")
//       .populate({
//         path: "rmId",
//         select: "firstName lastName employeeId email phone asmId",
//         populate: {
//           path: "asmId",
//           select: "firstName lastName employeeId email phone",
//         },
//       })
//       .lean();

//     if (!partner) {
//       return res.status(404).json({ message: "Partner not found" });
//     }

//     const BASE_URL = process.env.BACKEND_URL || "http://localhost:5000";

//     // rebuild docs with absolute URL
//     const docs = (partner.docs || []).map((doc) => ({
//       ...doc,
//       url: `${BASE_URL.replace(/\/$/, "")}/${doc.url.replace(/^\/+/, "")}`,
//     }));

//     // extract selfie as profilePic
//     const profilePic =
//       docs.find((doc) => doc.docType === "SELFIE")?.url || null;

//     res.json({
//       employeeId: partner.employeeId,
//       firstName: partner.firstName,
//       middleName: partner.middleName,
//       lastName: partner.lastName,
//       email: partner.email,
//       phone: partner.phone,
//       partnershipDate: partner.createdAt,
//       partnerType: partner.partnerType,
//       dob: partner.dob,
//       aadharNumber: partner.aadharNumber,
//       panNumber: partner.panNumber,
//       address: partner.region,
//       experience: partner.experience,
//       region: partner.region,
//       verification: partner.verification,
//       referralCode: partner.referralCode,
//       referralLink: `${
//         process.env.CLIENT_URL || "https://dhansourcecapital.com"
//       }/register?ref=${partner?.partnerCode}`,
//       status: partner.status,

//       // RM & ASM flattened
//       rmId: partner.rmId?._id || null,
//       rmName: partner.rmId
//         ? `${partner.rmId.firstName} ${partner.rmId.lastName}`
//         : null,
//       rmEmployeeId: partner.rmId?.employeeId || null,
//       rmEmail: partner.rmId?.email || null,
//       rmPhone: partner.rmId?.phone || null,
//       asmId: partner.rmId?.asmId?._id || null,
//       asmName: partner.rmId?.asmId
//         ? `${partner.rmId.asmId.firstName} ${partner.rmId.asmId.lastName}`
//         : null,
//       asmEmployeeId: partner.rmId?.asmId?.employeeId || null,
//       asmEmail: partner.rmId?.asmId?.email || null,
//       asmPhone: partner.rmId?.asmId?.phone || null,

//       // ✅ return docs + selfie separately
//       docs,
//       profilePic,
//     });
//   } catch (err) {
//     console.error("Error fetching Partner profile:", err);
//     res.status(500).json({ message: err.message });
//   }
// });

router.get("/profile", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const partner = await User.findById(req.user.sub)
      .select("-passwordHash")
      .populate({
        path: "rmId",
        select:
          "firstName lastName employeeId email phone asmId personalRsmId businessHomeRsmId",
        populate: [
          {
            path: "asmId",
            select: "firstName lastName employeeId email phone",
          },
          {
            path: "personalRsmId",
            select: "firstName lastName employeeId email phone asmId",
            populate: {
              path: "asmId",
              select: "firstName lastName employeeId email phone",
            },
          },
          {
            path: "businessHomeRsmId",
            select: "firstName lastName employeeId email phone asmId",
            populate: {
              path: "asmId",
              select: "firstName lastName employeeId email phone",
            },
          },
        ],
      })
      .lean();

    if (!partner) {
      return res.status(404).json({ message: "Partner not found" });
    }

    const pr = partner.rmId;
    const asmFromDoc = (a) => {
      if (!a) return null;
      return {
        id: a._id,
        employeeId: a.employeeId || null,
        name: `${a.firstName} ${a.lastName}`.trim(),
        email: a.email || null,
        phone: a.phone || null,
      };
    };
    const formatRsm = (rsm) => {
      if (!rsm) return null;
      return {
        id: rsm._id,
        employeeId: rsm.employeeId || null,
        name: `${rsm.firstName} ${rsm.lastName}`.trim(),
        email: rsm.email || null,
        phone: rsm.phone || null,
        asm: asmFromDoc(rsm.asmId),
      };
    };
    const personalRsmFmt = formatRsm(pr?.personalRsmId);
    const businessRsmFmt = formatRsm(pr?.businessHomeRsmId);
    const asmDirect = asmFromDoc(pr?.asmId);
    const resolvedAsm =
      personalRsmFmt?.asm ||
      businessRsmFmt?.asm ||
      asmDirect;

    // Do NOT modify URLs — they are already full AWS S3 URLs
    const docs = (partner.docs || []).map((doc) => ({
      ...doc,
      url: doc.url,
    }));

    const profilePic =
      docs.find((doc) => doc.docType === "SELFIE")?.url || null;

    /** Single public code for ?ref=, /invite?code=, and JSON (always prefer PT-… when present). */
    const partnerRefForShare = canonicalPartnerReferralCode(
      partner?.partnerCode,
      partner?.referralCode
    );

    if (
      partnerRefForShare &&
      /^PT-/i.test(partnerRefForShare) &&
      (String(partner.referralCode || "").trim() !== partnerRefForShare ||
        String(partner.partnerCode || "").trim() !== partnerRefForShare)
    ) {
      await User.updateOne(
        { _id: partner._id },
        { $set: { partnerCode: partnerRefForShare, referralCode: partnerRefForShare } }
      );
    }

    const displayPublicCode = partnerRefForShare || null;

    res.json({
      employeeId: partner.employeeId,
      firstName: partner.firstName,
      middleName: partner.middleName,
      lastName: partner.lastName,
      email: partner.email,
      phone: partner.phone,
      partnershipDate: partner.createdAt,
      partnerType: partner.partnerType,
      dob: partner.dob,
      aadharNumber: partner.aadharNumber,
      panNumber: partner.panNumber,
      address: partner.address,
      experience: partner.experience,
      region: partner.region,
      verification: partner.verification,
      partnerCode: displayPublicCode,
      referralCode: displayPublicCode,
      /** Google Play URL for partner app (env PARTNER_APP_PLAY_STORE_URL; placeholder until app is published) */
      playStoreUrl: getPartnerAppPlayStoreUrl(),
      /** Partner self-registration — same code as app invite; UTM for analytics */
      referralLink: partnerRefForShare
        ? appendPartnerShareUtm(
          `${getReferralWebBaseUrl()}/${PARTNER_REGISTRATION_PATH_SEGMENT}?ref=${encodeURIComponent(partnerRefForShare)}`,
          "web"
        )
        : appendPartnerShareUtm(
          `${getReferralWebBaseUrl()}/${PARTNER_REGISTRATION_PATH_SEGMENT}`,
          "web"
        ),
      /** App invite landing — same code as ?ref= (legacy DB had partnerCode vs referralCode split). */
      appInviteLink: partnerRefForShare
        ? appendPartnerShareUtm(
          `${getInviteBaseUrl()}/invite?code=${encodeURIComponent(partnerRefForShare)}`,
          "invite"
        )
        : null,
      status: partner.status,
      partnerLevel: partner.partnerLevel || "BRONZE",
      isPartnerOfTheMonth: partner.isPartnerOfTheMonth || false,

      // Bank/KYC Details
      bankName: partner.bankName || null,
      accountHolderName: partner.accountHolderName || null,
      accountNumber: partner.accountNumber || null,
      ifscCode: partner.ifscCode || null,
      registeredMobile: partner.registeredMobile || null,

      rmId: pr?._id || null,
      rmName: pr ? `${pr.firstName} ${pr.lastName}` : null,
      rmEmployeeId: pr?.employeeId || null,
      rmEmail: pr?.email || null,
      rmPhone: pr?.phone || null,

      // RSM lines (same shape as /rm/profile) — RSM is RM’s manager; ASM is RSM’s manager
      personalRsmId: personalRsmFmt?.id || null,
      personalRsmName: personalRsmFmt?.name || null,
      personalRsmEmployeeId: personalRsmFmt?.employeeId || null,
      personalRsmPhone: personalRsmFmt?.phone || null,
      personalRsmEmail: personalRsmFmt?.email || null,
      personalRsmAsmId: personalRsmFmt?.asm?.id || null,
      personalRsmAsmName: personalRsmFmt?.asm?.name || null,
      personalRsmAsmEmployeeId: personalRsmFmt?.asm?.employeeId || null,
      personalRsmAsmEmail: personalRsmFmt?.asm?.email || null,
      personalRsmAsmPhone: personalRsmFmt?.asm?.phone || null,

      businessHomeRsmId: businessRsmFmt?.id || null,
      businessHomeRsmName: businessRsmFmt?.name || null,
      businessHomeRsmEmployeeId: businessRsmFmt?.employeeId || null,
      businessHomeRsmPhone: businessRsmFmt?.phone || null,
      businessHomeRsmEmail: businessRsmFmt?.email || null,
      businessHomeRsmAsmId: businessRsmFmt?.asm?.id || null,
      businessHomeRsmAsmName: businessRsmFmt?.asm?.name || null,
      businessHomeRsmAsmEmployeeId: businessRsmFmt?.asm?.employeeId || null,
      businessHomeRsmAsmEmail: businessRsmFmt?.asm?.email || null,
      businessHomeRsmAsmPhone: businessRsmFmt?.asm?.phone || null,

      // Canonical ASM (first available from RSM chain, else RM’s asmId)
      asmId: resolvedAsm?.id || null,
      asmName: resolvedAsm?.name || null,
      asmEmployeeId: resolvedAsm?.employeeId || null,
      asmEmail: resolvedAsm?.email || null,
      asmPhone: resolvedAsm?.phone || null,

      reportingHierarchy: {
        partner: {
          id: partner._id,
          employeeId: partner.employeeId || null,
          name: `${partner.firstName} ${partner.lastName}`.trim(),
        },
        rm: pr
          ? {
            id: pr._id,
            employeeId: pr.employeeId || null,
            name: `${pr.firstName} ${pr.lastName}`.trim(),
            email: pr.email || null,
            phone: pr.phone || null,
          }
          : null,
        personalRsm: personalRsmFmt,
        businessHomeRsm: businessRsmFmt,
        asm: resolvedAsm,
      },

      docs,
      profilePic,
    });
  } catch (err) {
    console.error("Error fetching Partner profile:", err);
    res.status(500).json({ message: err.message });
  }
});

router.patch(
  "/profile/update",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const {
        firstName,
        middleName,
        lastName,
        currentEmail,
        currentPassword,
        phone,
        email,
        dob,
        address,
        experience,
        region,
        bankName,
        accountNumber,
        ifscCode,
        accountHolderName,
      } = req.body;

      const partnerId = req.user.sub;

      const updateData = {
        firstName,
        middleName,
        lastName,
        dob,
        address,
        experience,
        region,
        bankName,
        accountNumber,
        ifscCode,
        accountHolderName,
      };

      if (phone) {
        const normalizedPhone = String(phone).replace(/\D/g, "").slice(-10);
        const existingPhoneUser = await User.findOne({
          phone: normalizedPhone,
          _id: { $ne: partnerId },
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
          _id: { $ne: partnerId },
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

      const updatedPartner = await User.findOneAndUpdate(
        { _id: partnerId, role: ROLES.PARTNER },
        { $set: updateData },
        { new: true, runValidators: true, projection: "-passwordHash" }
      );

      if (!updatedPartner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      const profileObj = updatedPartner?.toObject
        ? updatedPartner.toObject()
        : updatedPartner;

      res.json({
        message: "Partner profile updated successfully",
        partner: profileObj,
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
      res.status(500).json({ message: err.message || "Failed to update partner profile" });
    }
  }
);

router.patch(
  "/profile/avatar",
  auth,
  requireRole(ROLES.PARTNER),
  upload.single("avatar"),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      if (!req.file?.location) {
        return res.status(400).json({ message: "Avatar image is required" });
      }
      if (!String(req.file.mimetype || "").startsWith("image/")) {
        return res.status(400).json({ message: "Only image files are allowed for avatar" });
      }

      const partner = await User.findOne({ _id: partnerId, role: ROLES.PARTNER });
      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      const nextDocs = Array.isArray(partner.docs)
        ? partner.docs.filter((d) => String(d.docType || "").toUpperCase() !== "SELFIE")
        : [];

      nextDocs.push({
        docType: "SELFIE",
        url: req.file.location,
        uploadedBy: partnerId,
        status: "PENDING",
        remarks: "",
        uploadedAt: new Date(),
      });

      partner.docs = nextDocs;
      await partner.save();

      return res.json({
        message: "Avatar updated successfully",
        profilePic: req.file.location,
        partner,
      });
    } catch (err) {
      console.error("Error updating partner avatar:", err);
      return res.status(500).json({ message: err.message || "Failed to update avatar" });
    }
  }
);



// router.get("/banners", auth, async (req, res) => {
//   try {
//     const banners = await Banner.find().sort({ createdAt: -1 });

//     const bannersWithUrl = banners.map((b) => ({
//       _id: b._id,
//       title: b.title,
//       description: b.description,
//       imageUrl: b.imageUrl,  // always S3 URL from MongoDB
//     }));

//     res.json({ banners: bannersWithUrl });
//   } catch (err) {
//     console.error("Error fetching banners:", err);
//     res.status(500).json({ message: err.message });
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



// Universal analytics/dashboard API with user profile
router.get(
  "/:id/analytics",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid user ID" });
      }

      // Find the user
      const user = await User.findById(id).lean(); // use lean() to get plain object
      if (!user) return res.status(404).json({ message: "User not found" });

      // Helper: sum disbursed amounts based on match
      const sumDisbursedBy = async (match) => {
        const agg = await Application.aggregate([
          { $match: { ...match, status: "DISBURSED" } },
          { $group: { _id: null, total: { $sum: "$product.amount" } } },
        ]);
        return agg.length > 0 ? agg[0].total : 0;
      };

      // Base response
      const base = {
        userId: id,
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
      let assignedTarget = user.target || 0;
      let performance = "0.00";
      let scope = user.role;

      if (user.role === ROLES.ASM) {
        const rms = await User.find({ asmId: id, role: ROLES.RM }).select(
          "_id"
        );
        const rmIds = rms.map((x) => x._id);

        const partners = await User.find({
          rmId: { $in: rmIds },
          role: ROLES.PARTNER,
        }).select("_id");
        const partnerIds = partners.map((x) => x._id);

        const totalCustomers = await User.countDocuments({
          partnerId: { $in: partnerIds },
          role: ROLES.CUSTOMER,
        });

        totalDisbursed = await sumDisbursedBy({ asmId: user._id });
        performance =
          assignedTarget > 0
            ? ((totalDisbursed / assignedTarget) * 100).toFixed(2)
            : "0.00";

        totals = {
          rms: rmIds.length,
          partners: partnerIds.length,
          customers: totalCustomers,
        };
      }

      if (user.role === ROLES.RM) {
        const partners = await User.find({
          rmId: id,
          role: ROLES.PARTNER,
        }).select("_id");
        const partnerIds = partners.map((x) => x._id);

        const totalCustomers = await User.countDocuments({
          partnerId: { $in: partnerIds },
          role: ROLES.CUSTOMER,
        });

        totalDisbursed = await sumDisbursedBy({ rmId: user._id });
        totals = { partners: partnerIds.length, customers: totalCustomers };
      }

      if (user.role === ROLES.PARTNER) {
        const totalCustomers = await User.countDocuments({
          partnerId: id,
          role: ROLES.CUSTOMER,
        });

        totalDisbursed = await sumDisbursedBy({ partnerId: user._id });
        totals = { customers: totalCustomers };
      }

      if (user.role === ROLES.CUSTOMER) {
        totalDisbursed = await sumDisbursedBy({ customerId: user._id });
        totals = {};
      }

      // Send response with user profile + analytics
      return res.json({
        profile: base,
        analytics: {
          scope,
          totals,
          assignedTarget: user.role === ROLES.ASM ? assignedTarget : undefined,
          totalDisbursed,
          performance: user.role === ROLES.ASM ? `${performance}%` : undefined,
        },
      });
    } catch (err) {
      console.error("Universal analytics error:", err);
      res.status(500).json({ message: "Failed to fetch analytics" });
    }
  }
);

// PATCH /partner/bank-details
router.patch(
  "/bank-details",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const {
        bankName,
        accountHolderName,
        accountNumber,
        ifscCode,
        registeredMobile,
      } = req.body;

      // Build update object with only provided fields
      const updateData = {};

      if (bankName !== undefined) updateData.bankName = bankName;
      if (accountHolderName !== undefined) updateData.accountHolderName = accountHolderName;
      if (accountNumber !== undefined) updateData.accountNumber = accountNumber;
      if (ifscCode !== undefined) updateData.ifscCode = ifscCode;
      if (registeredMobile !== undefined) updateData.registeredMobile = registeredMobile;

      const updated = await User.findOneAndUpdate(
        { _id: req.user.sub, role: ROLES.PARTNER },
        {
          $set: updateData,
        },
        { new: true, runValidators: true, projection: "-passwordHash" }
      );

      if (!updated)
        return res.status(404).json({ message: "Partner not found" });

      res.json({
        message: "Bank details updated successfully",
        bankDetails: updated,
      });
    } catch (err) {
      console.error("Error updating bank details:", err);
      res.status(500).json({ message: err.message });
    }
  }
);

// ==================== PARTNER PAYOUT & INCENTIVE HISTORY ====================

// 1) CURRENT-MONTH PAYOUT SUMMARY
// GET /api/partner/payouts/current
router.get(
  "/payouts/current",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const now = new Date();
      const month = now.getMonth(); // 0-11
      const year = now.getFullYear();

      const monthStart = new Date(year, month, 1);
      const monthEnd = new Date(year, month + 1, 1);

      const payouts = await Payout.find({
        partnerId,
        createdAt: { $gte: monthStart, $lt: monthEnd },
      })
        .populate("application", "appNo loanType loanAmount status")
        .select("amount payOutStatus note createdAt application")
        .sort({ createdAt: -1 })
        .lean();

      const totalPayoutThisMonth = payouts.reduce(
        (sum, p) => sum + (Number(p.amount) || 0),
        0
      );

      return res.json({
        month: month + 1,
        year,
        totalPayoutThisMonth,
        payouts,
      });
    } catch (err) {
      console.error("Error fetching current month payouts:", err);
      return res.status(500).json({ message: "Error fetching payouts" });
    }
  }
);

// 2) CURRENT-MONTH INCENTIVE SUMMARY
// GET /api/partner/incentives/current
router.get(
  "/incentives/current",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const now = new Date();
      const month = now.getMonth() + 1; // 1-12
      const year = now.getFullYear();

      const incentives = await Incentive.find({
        partnerId,
        month,
        year,
      })
        .select(
          "amount status paidAt notes fileCountTarget achievedFileCount disbursementTarget achievedDisbursement month year"
        )
        .sort({ createdAt: -1 })
        .lean();

      const totalIncentiveThisMonth = incentives.reduce(
        (sum, i) => sum + (Number(i.amount) || 0),
        0
      );

      return res.json({
        month,
        year,
        totalIncentiveThisMonth,
        incentives,
      });
    } catch (err) {
      console.error("Error fetching current month incentives:", err);
      return res.status(500).json({ message: "Error fetching incentives" });
    }
  }
);

// 3) PAYOUT HISTORY (MONTH/YEAR)
// GET /api/partner/payouts/history?month=MM&year=YYYY
router.get(
  "/payouts/history",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      let { month, year } = req.query;

      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      month = month ? Number(month) : currentMonth;
      year = year ? Number(year) : currentYear;

      if (Number.isNaN(month) || month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month. Use 1-12." });
      }
      if (Number.isNaN(year) || year < 2000) {
        return res.status(400).json({ message: "Invalid year." });
      }

      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 1);

      const payouts = await Payout.find({
        partnerId,
        createdAt: { $gte: monthStart, $lt: monthEnd },
      })
        .populate("application", "appNo loanType loanAmount status customer")
        .select("amount payOutStatus note createdAt application")
        .sort({ createdAt: -1 })
        .lean();

      const totalPayout = payouts.reduce(
        (sum, p) => sum + (Number(p.amount) || 0),
        0
      );

      return res.json({
        month,
        year,
        totalPayout,
        payouts,
      });
    } catch (err) {
      console.error("Error fetching payout history:", err);
      return res.status(500).json({ message: "Error fetching payout history" });
    }
  }
);

// 4) INCENTIVE HISTORY (MONTH/YEAR)
// GET /api/partner/incentives/history?month=MM&year=YYYY
router.get(
  "/incentives/history",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      let { month, year } = req.query;

      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      month = month ? Number(month) : currentMonth;
      year = year ? Number(year) : currentYear;

      if (Number.isNaN(month) || month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month. Use 1-12." });
      }
      if (Number.isNaN(year) || year < 2000) {
        return res.status(400).json({ message: "Invalid year." });
      }

      const incentives = await Incentive.find({
        partnerId,
        month,
        year,
      })
        .select(
          "amount status paidAt notes fileCountTarget achievedFileCount disbursementTarget achievedDisbursement month year"
        )
        .sort({ createdAt: -1 })
        .lean();

      const totalIncentive = incentives.reduce(
        (sum, i) => sum + (Number(i.amount) || 0),
        0
      );

      return res.json({
        month,
        year,
        totalIncentive,
        incentives,
      });
    } catch (err) {
      console.error("Error fetching incentive history:", err);
      return res
        .status(500)
        .json({ message: "Error fetching incentive history" });
    }
  }
);

// REFERRAL REWARDS — partner→partner (you earn as upline when downline’s loan disburses)
// GET /api/partner/referral-rewards/history?month=&year=&status=
router.get(
  "/referral-rewards/history",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      let { month, year, status } = req.query;

      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      month = month ? Number(month) : currentMonth;
      year = year ? Number(year) : currentYear;

      if (Number.isNaN(month) || month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month. Use 1-12." });
      }
      if (Number.isNaN(year) || year < 2000) {
        return res.status(400).json({ message: "Invalid year." });
      }

      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 1);

      const filter = {
        referrerId: partnerId,
        createdAt: { $gte: monthStart, $lt: monthEnd },
      };
      if (
        status &&
        ["PENDING", "APPROVED", "PAID", "CANCELLED"].includes(String(status))
      ) {
        filter.status = status;
      }

      const rewards = await ReferralReward.find(filter)
        .populate(
          "referredUserId",
          "firstName lastName partnerCode employeeId"
        )
        .populate(
          "applicationId",
          "appNo loanType approvedLoanAmount status"
        )
        .sort({ createdAt: -1 })
        .lean();

      const totalAmount = rewards.reduce(
        (s, r) => s + (Number(r.amount) || 0),
        0
      );
      const paidTotal = rewards
        .filter((r) => r.status === "PAID")
        .reduce((s, r) => s + (Number(r.amount) || 0), 0);

      return res.json({
        month,
        year,
        totalAmount,
        paidTotal,
        rewards,
      });
    } catch (err) {
      console.error("Error fetching referral reward history:", err);
      return res
        .status(500)
        .json({ message: "Error fetching referral rewards" });
    }
  }
);

// ✅ Upload document for an application
router.post(
  "/applications/:id/documents",
  auth,
  requireRole(ROLES.PARTNER),
  (req, res, next) => {
    // Log request details for debugging
    console.log('Upload request received:', {
      method: req.method,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      hasBody: !!req.body,
      bodyKeys: Object.keys(req.body || {}),
    });
    next();
  },
  upload.single("file"),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const { id } = req.params;
      const { docType } = req.query;

      console.log('Document upload request:', {
        partnerId,
        applicationId: id,
        docType,
        hasFile: !!req.file,
        fileInfo: req.file ? {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
        } : null,
        contentType: req.headers['content-type'],
      });

      if (!docType) {
        return res.status(400).json({ message: "docType is required" });
      }

      if (!req.file) {
        console.error('No file received in request');
        return res.status(400).json({
          message: "File is required",
          receivedFields: Object.keys(req.body || {}),
          contentType: req.headers['content-type'],
        });
      }

      const violSingle = oversizeSingleDocViolation(req.file, docType);
      if (violSingle) {
        await deleteS3ObjectsForUploadedFiles([req.file]);
        return res.status(400).json({ message: formatOversizeMessage(violSingle) });
      }

      // Find application belonging to this partner
      const application = await Application.findOne({
        _id: id,
        partnerId,
      });

      if (!application) {
        return res.status(404).json({
          message: "Application not found or not accessible",
        });
      }

      // Add or update document
      const docIndex = application.docs.findIndex(
        (doc) => doc.docType?.toUpperCase() === docType.toUpperCase()
      );

      const now = new Date();
      const isUpdate = docIndex >= 0;
      const previousStatus = isUpdate ? application.docs[docIndex].status : null;
      const previousDoc = isUpdate ? application.docs[docIndex] : null;

      // When partner uploads/re-uploads, always set to UPDATED to indicate:
      // - Partner has uploaded/updated the document
      // - RM verification is pending
      let newStatus = "UPDATED"; // All partner uploads show as UPDATED (RM verification pending)

      const newDoc = {
        docType: docType.toUpperCase(),
        url: req.file.location || req.file.path,
        uploadedBy: partnerId,
        status: newStatus,
        uploadedAt: isUpdate && previousDoc?.uploadedAt ? previousDoc.uploadedAt : now, // Keep original upload date if exists
        updatedAt: now, // Always update this timestamp
        remarks: isUpdate && previousStatus === "REJECTED" ? "" : (previousDoc?.remarks || ""), // Clear remarks if re-uploading rejected doc
        verifiedAt: isUpdate && previousStatus === "VERIFIED" ? previousDoc.verifiedAt : null, // Keep if was verified
        rejectedAt: isUpdate && previousStatus === "REJECTED" ? null : previousDoc?.rejectedAt, // Clear if re-uploading rejected
        verifiedBy: isUpdate && previousStatus === "VERIFIED" ? previousDoc.verifiedBy : null,
        rejectedBy: isUpdate && previousStatus === "REJECTED" ? null : previousDoc?.rejectedBy, // Clear if re-uploading rejected
      };

      if (docIndex >= 0) {
        application.docs[docIndex] = newDoc;
      } else {
        application.docs.push(newDoc);
      }

      // If partner is uploading documents for the first time, move workflow to DOC_INCOMPLETE.
      // This is required so that RM can transition to DOC_COMPLETE after verifying docs.
      if (application.status === "SUBMITTED") {
        try {
          application.transition(
            "DOC_INCOMPLETE",
            partnerId,
            "Documents uploaded - verification pending"
          );
        } catch (transitionErr) {
          console.error(
            "Status transition DOC_INCOMPLETE failed:",
            transitionErr.message
          );
          // Fallback: keep status consistent
          application.status = "DOC_INCOMPLETE";
        }
      }

      // If application was DOC_INCOMPLETE and partner is re-uploading, keep status as DOC_INCOMPLETE
      // (RM will review and change status accordingly)
      // If document was UPDATED and partner re-uploads, it stays UPDATED for RM review

      await application.save();

      console.log('Document uploaded successfully:', {
        docType: newDoc.docType,
        status: newDoc.status,
        url: newDoc.url,
      });

      // Send response immediately (don't wait for email)
      res.json({
        message: "Document uploaded successfully. Status set to UPDATED - RM verification pending.",
        document: newDoc,
        isUpdate: isUpdate,
        previousStatus: previousStatus,
      });

      // Send notification email to RM asynchronously (non-blocking)
      setImmediate(async () => {
        try {
          const rm = await User.findById(application.rmId).lean();
          if (rm && rm.email) {
            await sendMail({
              to: rm.email,
              subject: `Document ${isUpdate ? 'Updated' : 'Uploaded'} - ${docType} - Verification Pending`,
              html: `
                <p>Dear ${rm.firstName || "RM"},</p>
                <p>The document <strong>${docType}</strong> for application <strong>${application.appNo}</strong> has been ${isUpdate ? 'updated' : 'uploaded'} by the partner.</p>
                <p><b>Status:</b> UPDATED (Partner has uploaded - RM verification pending)</p>
                ${isUpdate && previousStatus === "REJECTED" ? `<p><b>Note:</b> This document was previously rejected and has been re-uploaded. Please review.</p>` : ''}
                <p>Please review and verify the document in the application management system.</p>
                <br/>
                <p>Thank you,<br/>DhanSource Capital</p>
              `,
            });
          }
        } catch (mailErr) {
          console.error("Failed to send email notification to RM:", mailErr.message);
          // Don't fail the request if email fails
        }
      });
    } catch (err) {
      console.error("Error uploading document:", err);
      console.error("Error stack:", err.stack);

      // Handle multer errors specifically
      if (err instanceof multer.MulterError || err.code === 'LIMIT_FILE_SIZE') {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            message: "File too large. Maximum size is 20MB"
          });
        }
        return res.status(400).json({
          message: `Upload error: ${err.message}`
        });
      }

      res.status(500).json({
        message: err.message || "Internal server error",
        error: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      });
    }
  },
  // Error handling middleware for multer
  (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      console.error('Multer error:', err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          message: "File too large. Maximum size is 20MB"
        });
      }
      return res.status(400).json({
        message: `Upload error: ${err.message}`
      });
    }
    if (err) {
      console.error('Upload middleware error:', err);
      return res.status(400).json({
        message: err.message || "File upload error"
      });
    }
    next();
  }
);

// ✅ Update employment info for an application
router.put(
  "/applications/:id/employment-info",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const { id } = req.params;
      const { companyName, currentExperience, designation, monthlySalary } = req.body;

      // Find application belonging to this partner
      const application = await Application.findOne({
        _id: id,
        partnerId,
      });

      if (!application) {
        return res.status(404).json({
          message: "Application not found or not accessible",
        });
      }

      // Update employment info
      if (!application.employmentInfo) {
        application.employmentInfo = {};
      }

      if (companyName) application.employmentInfo.companyName = companyName;
      if (currentExperience) application.employmentInfo.currentExperience = currentExperience;
      if (designation) application.employmentInfo.designation = designation;
      if (monthlySalary) application.employmentInfo.monthlySalary = monthlySalary;

      await application.save();

      res.json({
        message: "Employment info updated successfully",
        employmentInfo: application.employmentInfo,
      });
    } catch (err) {
      console.error("Error updating employment info:", err);
      res.status(500).json({ message: err.message });
    }
  }
);

// ✅ Get incomplete applications by loan type
router.get(
  "/applications/incomplete/:loanType",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const { loanType } = req.params;

      const applications = await Application.find({
        partnerId,
        loanType: loanType.toUpperCase(),
        status: "DOC_INCOMPLETE",
        deletedAt: null,
      })
        .populate("customerId", "firstName lastName email phone")
        .lean();

      const formatted = applications.map((app) => ({
        applicationId: app._id,
        customerId: app.customerId?._id,
        customerName: `${app.customerId?.firstName || ""} ${app.customerId?.lastName || ""
          }`.trim(),
        contact: app.customerId?.phone || null,
        email: app.customerId?.email || null,
        loanType: app.loanType,
        status: app.status,
        docs: app.docs || [],
        createdAt: app.createdAt,
      }));

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching incomplete applications:", err);
      res.status(500).json({ message: err.message });
    }
  }
);

// Partner requests account deletion (email + admin visibility)
router.post(
  "/delete-account-request",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const { reason } = req.body || {};

      const partner = await User.findById(partnerId).lean();
      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      // Prevent duplicate pending requests
      const existing = await DeleteAccountRequest.findOne({
        user: partnerId,
        status: "PENDING",
      });

      if (existing) {
        return res.status(400).json({
          message: "You already have a pending delete account request.",
        });
      }

      const requestDoc = await DeleteAccountRequest.create({
        user: partnerId,
        role: partner.role,
        reason: reason || "",
        status: "PENDING",
        source: "PORTAL",
      });

      // Fire-and-forget email to admin/support
      setImmediate(async () => {
        try {
          await sendDeleteAccountRequestEmail(partner, reason || "", "PORTAL");
        } catch (err) {
          console.error("Failed to send delete account request email:", err.message);
        }
      });

      return res.status(201).json({
        message:
          "Delete account request submitted successfully. Our team will review and process it shortly.",
        requestId: requestDoc._id,
      });
    } catch (err) {
      console.error("Error creating delete account request:", err);
      return res.status(500).json({
        message: "Server error while creating delete account request",
        error: err.message,
      });
    }
  }
);

// Partner: current delete-account request status (for settings UI)
router.get(
  "/delete-account-request/status",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;

      const pending = await DeleteAccountRequest.findOne({
        user: partnerId,
        status: "PENDING",
      })
        .sort({ createdAt: -1 })
        .lean();

      if (pending) {
        return res.json({
          hasRequest: true,
          status: "PENDING",
          requestId: pending._id,
          reason: pending.reason || "",
          submittedAt: pending.createdAt,
          processedAt: null,
        });
      }

      const latest = await DeleteAccountRequest.findOne({ user: partnerId })
        .sort({ updatedAt: -1 })
        .lean();

      if (!latest) {
        return res.json({ hasRequest: false, status: null });
      }

      return res.json({
        hasRequest: true,
        status: latest.status,
        requestId: latest._id,
        reason: latest.reason || "",
        submittedAt: latest.createdAt,
        processedAt: latest.processedAt || null,
      });
    } catch (err) {
      console.error("Error fetching delete account request status:", err);
      return res.status(500).json({
        message: "Server error while fetching delete account status",
        error: err.message,
      });
    }
  }
);

// ==================== PARTNER TARGET VIEW (Partner) ====================

// GET /api/partner/my-target
// Partner gets their own target
router.get("/my-target", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const partnerId = req.user.sub;
    const { year, month } = req.query;

    const currentDate = new Date();
    const targetMonth = month ? Number(month) : currentDate.getMonth() + 1;
    const targetYear = year ? Number(year) : currentDate.getFullYear();

    // Get target for this partner
    const target = await Target.findOne({
      assignedTo: new mongoose.Types.ObjectId(partnerId),
      role: ROLES.PARTNER,
      month: targetMonth,
      year: targetYear,
    }).lean();

    const startDate = new Date(targetYear, targetMonth - 1, 1);
    const endDate = new Date(targetYear, targetMonth, 1);

    // Fetch all active applications for this partner
    const partnerApps = await Application.find({
      partnerId: new mongoose.Types.ObjectId(partnerId),
      status: { $ne: "DRAFT" }
    }).lean();

    // Filter file submissions by date they were submitted (to SUBMITTED or first stage transition)
    const fileApps = partnerApps.filter(app => {
      const submitStage = app.stageHistory?.find(s => s.to === "SUBMITTED");
      const submitDate = submitStage ? new Date(submitStage.at) : new Date(app.createdAt);
      return submitDate >= startDate && submitDate < endDate;
    });

    // Filter disbursed applications by exact date they transitioned to DISBURSED
    const disbursedApps = partnerApps.filter(app => {
      if (app.status !== "DISBURSED") return false;
      const disburseStage = app.stageHistory?.find(s => s.to === "DISBURSED");
      const disburseDate = disburseStage ? new Date(disburseStage.at) : new Date(app.updatedAt);
      return disburseDate >= startDate && disburseDate < endDate;
    });

    const fileCountTarget = target?.fileCountTarget || 4;
    const disbursementTarget = target?.disbursementTarget || 2000000;

    const achievedFileCount = fileApps.length;
    const achievedDisbursement = disbursedApps
      .reduce((sum, app) => sum + (parseFloat(app.approvedLoanAmount) || 0), 0);

    // Check if targets are met and exceeded
    const fileTargetMet = achievedFileCount >= fileCountTarget;
    const disbursementTargetMet = achievedDisbursement >= disbursementTarget;
    const targetAchieved = fileTargetMet && disbursementTargetMet;
    const fileTargetExceeded = achievedFileCount > fileCountTarget;
    const disbursementTargetExceeded = achievedDisbursement > disbursementTarget;
    const targetExceeded = fileTargetExceeded || disbursementTargetExceeded;

    // Calculate percentages
    const fileAchievementPercentage = fileCountTarget > 0
      ? (achievedFileCount / fileCountTarget) * 100
      : 0;
    const disbursementAchievementPercentage = disbursementTarget > 0
      ? (achievedDisbursement / disbursementTarget) * 100
      : 0;

    res.json({
      partnerId,
      month: targetMonth,
      year: targetYear,
      fileCountTarget,
      achievedFileCount,
      disbursementTarget,
      achievedDisbursement,
      fileTargetMet,
      disbursementTargetMet,
      targetAchieved,
      fileTargetExceeded,
      disbursementTargetExceeded,
      targetExceeded,
      fileAchievementPercentage: fileAchievementPercentage.toFixed(2),
      disbursementAchievementPercentage: disbursementAchievementPercentage.toFixed(2),
      hasTarget: !!target,
    });
  } catch (err) {
    console.error("Error fetching partner target:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─── Wallet / Withdrawals (Partner → ASM → Admin) ───────────────────────────

router.get(
  "/wallet/balance",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const balance = await getPartnerWalletBalance(req.user.sub);
      return res.json({ success: true, data: balance });
    } catch (err) {
      console.error("wallet/balance error:", err);
      return res.status(500).json({ message: "Failed to load wallet balance" });
    }
  }
);

router.get(
  "/withdrawals",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const list = await WithdrawalRequest.find({ partnerId: req.user.sub })
        .sort({ createdAt: -1 })
        .lean();
      return res.json({ success: true, data: list });
    } catch (err) {
      console.error("partner withdrawals list error:", err);
      return res.status(500).json({ message: "Failed to load withdrawals" });
    }
  }
);

router.post(
  "/withdrawals",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const partnerId = req.user.sub;
      const amount = Number(req.body?.amount);
      const note = String(req.body?.note || "").trim();

      if (!Number.isFinite(amount) || amount < 500) {
        return res.status(400).json({ message: "Enter a valid withdraw amount (min ₹500)." });
      }

      const balance = await getPartnerWalletBalance(partnerId);
      if (amount > balance.available + 0.0001) {
        return res.status(400).json({
          message: `Insufficient available balance. Available: ₹${balance.available.toLocaleString("en-IN")}`,
          available: balance.available,
        });
      }

      const partner = await User.findById(partnerId).select("asmId firstName lastName").lean();
      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }
      if (!partner.asmId) {
        return res.status(400).json({
          message: "Your account has no ASM assigned yet. Contact support before withdrawing.",
        });
      }

      const doc = await WithdrawalRequest.create({
        partnerId,
        asmId: partner.asmId,
        amount,
        note,
        status: "PENDING_ASM",
      });

      try {
        await createNotification(partner.asmId.toString(), {
          type: "payout",
          title: "New withdraw request",
          message: `${partner.firstName || "Partner"} requested ₹${amount.toLocaleString("en-IN")} withdrawal.`,
          category: "withdrawal",
          priority: "normal",
          data: { withdrawalId: String(doc._id) },
        });
      } catch (nErr) {
        console.warn("withdraw notify ASM failed:", nErr?.message);
      }

      return res.status(201).json({
        success: true,
        message: "Withdraw request submitted. Awaiting ASM approval.",
        data: doc,
      });
    } catch (err) {
      console.error("partner create withdrawal error:", err);
      return res.status(500).json({ message: "Failed to create withdraw request" });
    }
  }
);

export default router;
