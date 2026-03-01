import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { Application } from "../models/Application.js";
import { User } from "../models/User.js";
import argon2 from "argon2";
import { upload } from "../middleware/upload.js"; // the multer config above;
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { Banner } from "../models/Banner.js";
import { Payout } from "../models/Payout.js";
import { partnerUpload } from "../middleware/profileUpload.js";
import mongoose from "mongoose";
import { makePartnerCode } from "../utils/codes.js";
import { sendMail } from "../utils/sendMail.js";
import { sendPartnerRegistrationEmail, sendLoanApplicationEmail } from "../utils/emailService.js";
import { Target } from "../models/Target.js";
import { createNotification, createNotificationsForUsers } from "../utils/notificationService.js";

const validateApplicationPayload = ({
  customer = {},
  product = {},
  loanType,
  references = [],
  coApplicant,
}) => {
  const errors = [];

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

const router = Router();

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
        rmCode,
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

      let assignedRmId = null;
      let status = "PENDING";

      if (rmCode) {
        const rm = await User.findOne({ rmCode });
        if (rm) {
          assignedRmId = rm._id;
          status = "ACTIVE";
        } else {
          const superAdmin = await User.findOne({ role: ROLES.SUPER_ADMIN });
          if (superAdmin) assignedRmId = superAdmin._id;
        }
      } else {
        const superAdmin = await User.findOne({ role: ROLES.SUPER_ADMIN });
        if (superAdmin) assignedRmId = superAdmin._id;
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
        rmId: assignedRmId,
        status,
        docs,
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

      // 🔔 Create notification for assigned RM (if exists)
      if (assignedRmId) {
        try {
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

          // Emit socket event to RM
          if (global.io) {
            global.io.to(`rm_${assignedRmId.toString()}`).emit("newPartnerRegistered", {
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
            console.log("✅ Socket event emitted to RM for new partner registration");
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
        message: "Partner signed up successfully and targets redistributed",
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

      if (partnerReferralCode) {
        const referralPartner = await User.findOne({
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

      // Map uploaded docs
      const docTypes = Array.isArray(req.body.docTypes)
        ? req.body.docTypes
        : req.body.docTypes
        ? [req.body.docTypes]
        : [];

      const newDocs = req.files.map((file, index) => {
        if (!file.location) {
          throw new Error("S3 upload failed: missing file location");
        }
        return {
          docType: docTypes[index] || "UNKNOWN",
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

      // Check for existing application
      let existingApp = await Application.findOne({
        customerId: customerUser._id,
        deletedAt: null,
      });

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
        // Update existing application - replace/re-add documents
        const docsMap = new Map();

        // Keep existing docs first
        for (const d of existingApp.docs) docsMap.set(d.docType.toUpperCase(), d);
        
        // Replace with new docs (re-uploaded documents replace old ones)
        for (const nd of newDocs) {
          const existingDoc = docsMap.get(nd.docType.toUpperCase());
          if (existingDoc) {
            // Replace existing document - update URL and reset status to PENDING
            existingDoc.url = nd.url;
            existingDoc.status = "PENDING"; // Reset status when re-uploaded
            existingDoc.remarks = ""; // Clear remarks when re-uploaded
            existingDoc.uploadedBy = userId;
          } else {
            // New document
            docsMap.set(nd.docType.toUpperCase(), nd);
          }
        }

        existingApp.docs = Array.from(docsMap.values());
        existingApp.customer = { ...existingApp.customer, ...customerData };
        existingApp.employmentInfo = employmentInfo;
        existingApp.businessInfo = businessInfo;
        existingApp.propertyInfo = propertyInfo;
        existingApp.coApplicant = coApplicant;
        existingApp.references = refs;
        existingApp.partnerId = assignedPartnerId;
        existingApp.rmId = assignedRmId;
        // Keep DOC_INCOMPLETE status if it was DOC_INCOMPLETE, otherwise set to DRAFT
        if (existingApp.status !== "DOC_INCOMPLETE") {
          existingApp.status = "DRAFT";
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
            customerId: customerUser._id,
            loanType,
            customer: customerData,
            docs: newDocs,
            references: refs,
            employmentInfo,
            businessInfo,
            propertyInfo,
            coApplicant,
            status: "DRAFT",
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

      // Map uploaded docs
      const docTypes = Array.isArray(req.body.docTypes)
        ? req.body.docTypes
        : req.body.docTypes
        ? [req.body.docTypes]
        : [];

      const newDocs = req.files.map((file, index) => {
        if (!file.location) {
          throw new Error("S3 upload failed: missing file location");
        }
        return {
          docType: docTypes[index] || "UNKNOWN",
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

      // Check for existing application
      let existingApp = await Application.findOne({
        customerId: customerUser._id,
        deletedAt: null,
      });

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
        // Update existing application - replace/re-add documents
        const docsMap = new Map();

        // Keep existing docs first
        for (const d of existingApp.docs) docsMap.set(d.docType.toUpperCase(), d);
        
        // Replace with new docs (re-uploaded documents replace old ones)
        for (const nd of newDocs) {
          const existingDoc = docsMap.get(nd.docType.toUpperCase());
          if (existingDoc) {
            // Replace existing document - update URL and reset status to PENDING
            existingDoc.url = nd.url;
            existingDoc.status = "PENDING"; // Reset status when re-uploaded
            existingDoc.remarks = ""; // Clear remarks when re-uploaded
            existingDoc.uploadedBy = userId;
          } else {
            // New document
            docsMap.set(nd.docType.toUpperCase(), nd);
          }
        }

        existingApp.docs = Array.from(docsMap.values());
        existingApp.customer = { ...existingApp.customer, ...customerData };
        existingApp.employmentInfo = employmentInfo;
        existingApp.businessInfo = businessInfo;
        existingApp.propertyInfo = propertyInfo;
        existingApp.coApplicant = coApplicant;
        existingApp.references = refs;
        existingApp.partnerId = assignedPartnerId;
        existingApp.rmId = assignedRmId;
        // Keep DOC_INCOMPLETE status if it was DOC_INCOMPLETE, otherwise set to DRAFT
        if (existingApp.status !== "DOC_INCOMPLETE") {
          existingApp.status = "DRAFT";
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
            customerId: customerUser._id,
            loanType,
            customer: customerData,
            docs: newDocs,
            references: refs,
            employmentInfo,
            businessInfo,
            propertyInfo,
            coApplicant,
            status: "DRAFT",
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

/** Partner submits application => DRAFT -> SUBMITTED */
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
      app.transition("SUBMITTED", req.user.sub, "Partner submitted");
      await app.save();

      // Send email notification to customer about submission
      setImmediate(async () => {
        try {
          if (app.customerId && app.customerId.email) {
            const { sendApplicationStatusEmail } = await import("../utils/emailService.js");
            await sendApplicationStatusEmail(
              {
                firstName: app.customer?.firstName || app.customerId.firstName || "Customer",
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

      res.json({ message: "Submitted", status: app.status });
    } catch (e) {
      res.status(400).json({ message: e.message });
    }
  }
);

/** Partner views own applications with customer + payout info */
router.get(
  "/get-applications",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const apps = await Application.find({ 
        partnerId: req.user.sub,
        deletedAt: null 
      })
        .populate("customerId", "firstName lastName email phone") // fetch linked user
        .lean();

      // fetch payouts separately and attach them
      const appsWithPayouts = await Promise.all(
        apps.map(async (app) => {
          const payouts = await Payout.find(
            { application: app._id }, // ✅ use correct field name
            "amount status note createdAt"
          ).lean();

          return { ...app, payouts };
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

      // Get payouts for this application
      const payouts = await Payout.find({ application: app._id })
        .select("amount status note createdAt")
        .lean();

      return res.json({
        application: app,
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

      return res.json(application);
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

    // Find all applications under this Partner
    const applications = await Application.find({ 
      partnerId,
      deletedAt: null 
    })
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
      customerName: `${app.customerId?.firstName ?? ""} ${
        app.customerId?.lastName ?? ""
      }`.trim(),
      contact: app.customerId?.phone || null,
      email: app.customerId?.email || null,
      loanType: app.loanType,
      loanAmount: app.customer?.loanAmount || null,
      approvedAmount: app.approvedLoanAmount || null,
      status: app.status,
      payoutAmount: payoutMap[app._id.toString()] || 0, // ✅ only payout amount
      docs: app.docs || [], // ✅ Include documents for incomplete doc tracking
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
    // 1️⃣ Build filter for Applications
    // ------------------
    const match = {
      partnerId: new mongoose.Types.ObjectId(partnerId),
      deletedAt: null,
    };

    const hasYearMonth = year && month;
    const hasRange = start && end;

    if (hasYearMonth) {
      const parsedYear = parseInt(year, 10);
      const parsedMonth = parseInt(month, 10);
      const startDate = new Date(parsedYear, parsedMonth - 1, 1);
      const endDate = new Date(parsedYear, parsedMonth, 1);
      match.createdAt = { $gte: startDate, $lt: endDate };
    } else if (hasRange) {
      match.createdAt = { $gte: new Date(start), $lte: new Date(end) };
    }

    // ------------------
    // 2️⃣ Fetch Applications
    // ------------------
    const applications = await Application.find(match).lean();

    const totalFiles = applications.length;
    const approvedFiles = applications.filter(
      (a) => a.status === "APPROVED"
    ).length;
    const rejectedFiles = applications.filter(
      (a) => a.status === "REJECTED"
    ).length;
    const docsIncomplete = applications.filter(
      (a) => a.status === "DOC_INCOMPLETE"
    ).length;
    const inProcessFiles = applications.filter((a) =>
      ["UNDER_REVIEW", "SUBMITTED", "DRAFT"].includes(a.status)
    ).length;

    // Total disbursed
    const disbursedApps = applications.filter((a) => a.status === "DISBURSED");
    const totalDisburseAmount = disbursedApps.reduce(
      (sum, app) => sum + (app.approvedLoanAmount || 0),
      0
    );
    const partnerEarnCount = disbursedApps.length;

    // ------------------
    // 3️⃣ Payout calculation
    // ------------------
    const payoutMatch = {
      partnerId: new mongoose.Types.ObjectId(partnerId),
      payOutStatus: "DONE",
    };
    if (match.createdAt) payoutMatch.createdAt = match.createdAt;

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

    const targetValue = targetDoc ? Number(targetDoc.targetValue) : 0;
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
    // 6️⃣ Monthly target & achieved
    // ------------------
    const monthlyTargets = {};
    for (let i = 0; i < 12; i++) {
      const monthNumber = i + 1;

      // Get target for the month
      const targetDoc = await Target.findOne({
        assignedTo: new mongoose.Types.ObjectId(partnerId),
        role: ROLES.PARTNER,
        month: monthNumber,
        year: currentYearForTarget,
      }).lean();

      const targetValue = targetDoc ? Number(targetDoc.targetValue) : 0;

      // Calculate achieved target for the month
      const achieved = applications
        .filter((a) => {
          const appMonth = new Date(a.createdAt).getMonth() + 1;
          const appYear = new Date(a.createdAt).getFullYear();
          return (
            a.status === "DISBURSED" &&
            appMonth === monthNumber &&
            appYear === currentYearForTarget
          );
        })
        .reduce((sum, a) => sum + (a.approvedLoanAmount || 0), 0);

      monthlyTargets[months[i]] = { target: targetValue, achieved };
    }

    // ------------------
    // 7️⃣ Response
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
      target: targetValue,
      achievedTarget: achievedValue,
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
    });
  } catch (err) {
    console.error("Partner dashboard error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

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
//         process.env.CLIENT_URL || "https://trustlinefintech.com"
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
        select: "firstName lastName employeeId email phone asmId",
        populate: {
          path: "asmId",
          select: "firstName lastName employeeId email phone",
        },
      })
      .lean();

    if (!partner) {
      return res.status(404).json({ message: "Partner not found" });
    }

    // Do NOT modify URLs — they are already full AWS S3 URLs
    const docs = (partner.docs || []).map((doc) => ({
      ...doc,
      url: doc.url,
    }));

    const profilePic =
      docs.find((doc) => doc.docType === "SELFIE")?.url || null;

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
      referralCode: partner.referralCode,
      referralLink: `${
        process.env.CLIENT_URL || "https://trustlinefintech.com"
      }/LoginPage?ref=${partner?.partnerCode}`,
      status: partner.status,

      // Bank/KYC Details
      bankName: partner.bankName || null,
      accountHolderName: partner.accountHolderName || null,
      accountNumber: partner.accountNumber || null,
      ifscCode: partner.ifscCode || null,
      registeredMobile: partner.registeredMobile || null,

      rmId: partner.rmId?._id || null,
      rmName: partner.rmId
        ? `${partner.rmId.firstName} ${partner.rmId.lastName}`
        : null,
      rmEmployeeId: partner.rmId?.employeeId || null,
      rmEmail: partner.rmId?.email || null,
      rmPhone: partner.rmId?.phone || null,
      asmId: partner.rmId?.asmId?._id || null,
      asmName: partner.rmId?.asmId
        ? `${partner.rmId.asmId.firstName} ${partner.rmId.asmId.lastName}`
        : null,
      asmEmployeeId: partner.rmId?.asmId?.employeeId || null,
      asmEmail: partner.rmId?.asmId?.email || null,
      asmPhone: partner.rmId?.asmId?.phone || null,

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
        lastName,
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

      const updatedPartner = await User.findOneAndUpdate(
        { _id: req.user.sub, role: ROLES.PARTNER },
        {
          $set: {
            firstName,
            lastName,
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
          },
        },
        { new: true, runValidators: true, projection: "-passwordHash" }
      );

      if (!updatedPartner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      res.json({
        message: "Partner profile updated successfully",
        partner: updatedPartner,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
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
                <p>Thank you,<br/>Trustline Fintech</p>
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
        customerName: `${app.customerId?.firstName || ""} ${
          app.customerId?.lastName || ""
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

export default router;
