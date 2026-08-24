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
  formatOversizeMessage,
  deleteS3ObjectsForUploadedFiles,
  normalizeDocTypeForLimits,
} from "../utils/docUploadLimits.js";
import { findCustomerApplyBlocker } from "../utils/loanReapplyPolicy.js";

const router = Router();
/** Partner views own applications (with status & docs) */
// router.get("/get-applications", auth, requireRole(ROLES.CUSTOMER), async (req, res) => {
//   const list = await Application.find({ customerId: req.user.sub }).lean();
//   res.json(list);
// });

async function resolveDefaultCompanyPartner() {
  if (process.env.DEFAULT_COMPANY_PARTNER_CODE) {
    const p = await User.findOne({ partnerCode: process.env.DEFAULT_COMPANY_PARTNER_CODE, role: ROLES.PARTNER });
    if (p) return p;
  }
  const sanjay = await User.findOne({ role: ROLES.PARTNER, firstName: /sanjay/i });
  if (sanjay) return sanjay;
  return await User.findOne({ role: ROLES.PARTNER, status: "ACTIVE" });
}

router.post(
  "/create-applications",
  auth,
  requireRole(ROLES.PARTNER, ROLES.CUSTOMER),
  upload.array("docs", 20), // max 10 files
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

      // ✅ Get RM & ASM
      let rm = null;
      let asm = null;
      if (req.user.role === ROLES.PARTNER) {
        rm = await User.findById(partner.rmId);
        if (rm?.asmId) {
          asm = await User.findById(rm.asmId);
        }
      }

      // Parse input JSON
      const { customer, product, loanType, references } = JSON.parse(
        req.body.data || "{}"
      );

      if (!customer?.firstName || !customer?.email || !customer?.phone) {
        return res
          .status(400)
          .json({ message: "customer.firstName, email, phone required" });
      }

      if (
        !loanType ||
        !Application.schema.path("loanType").enumValues.includes(loanType)
      ) {
        return res.status(400).json({ message: "Valid loanType is required" });
      }

      // Check if customer exists
      const existingUser = await User.findOne({
        $or: [
          { email: customer.email.toLowerCase() },
          { phone: customer.phone },
          ...(customer.appNo ? [{ appNo: customer.appNo }] : []),
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

      if (customerUser) {
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

      // Create customer if not exists
      let tempPassword;
      if (!customerUser) {
        tempPassword =
          customer.password || `Cus@${Math.random().toString(36).slice(2, 10)}`;
        
        let targetPartnerId = req.user.role === ROLES.PARTNER ? userId : undefined;
        let targetRmId = req.user.role === ROLES.PARTNER ? partner?.rmId : undefined;

        if (!targetPartnerId && req.user.role === ROLES.CUSTOMER) {
          const defPartner = await resolveDefaultCompanyPartner();
          if (defPartner) {
            targetPartnerId = defPartner._id;
            targetRmId = defPartner.rmId;
          }
        }

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
              lastName: customer.lastName || "",
              email: customer.email.toLowerCase(),
              phone: customer.phone,
              password: customer.password,
              passwordHash: await argon2.hash(customer.password || tempPassword),
              role: ROLES.CUSTOMER,
              status: "ACTIVE",
              partnerId: targetPartnerId,
              rmId: targetRmId,
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

      if (customerUser && req.user.role === ROLES.PARTNER) {
        const linkPatch = {};
        if (!customerUser.partnerId) linkPatch.partnerId = userId;
        if (!customerUser.rmId && partner?.rmId) linkPatch.rmId = partner.rmId;
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

      const docs = req.files.map((file, index) => ({
        docType: normalizeDocTypeForLimits(docTypes[index] || "UNKNOWN"),
        url: (() => {
          if (!file.location) {
            throw new Error("S3 upload failed: missing file location");
          }
          return file.location;
        })(),
        uploadedBy: userId,
        status: "PENDING",
      }));

      // Prepare conditional sections
      let employmentInfo = null;
      let businessInfo = null;
      let propertyInfo = null;

      if (["PERSONAL", "HOME_LOAN_SALARIED"].includes(loanType)) {
        employmentInfo = {
          companyName: product.companyName,
          designation: product.designation,
          companyAddress: product.currentAddress,
          monthlySalary: product.monthlySalary,
          totalExperience: product.totalExperience,
          currentExperience: product.currentExperience,
        };
      }

      if (["BUSINESS", "HOME_LOAN_SELF_EMPLOYED"].includes(loanType)) {
        businessInfo = {
          shopName: product.shopName,
          gstNumber: product.gstNumber,
          annualTurnoverInINR: product.annualTurnoverInINR,
          shopAddress: product.shopAddress,
        };
      }

      if (
        ["HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED"].includes(loanType)
      ) {
        propertyInfo = {
          propertyType: product.propertyType,
        };
      }

      // Map references
      const refs = Array.isArray(references)
        ? references
        : references
        ? [references]
        : [];

      // Determine Partner & RM
      let appPartnerId = req.user.role === ROLES.PARTNER ? userId : customerUser.partnerId;
      let appRmId = req.user.role === ROLES.PARTNER ? partner?.rmId : customerUser.rmId;

      if (!appPartnerId && req.user.role === ROLES.CUSTOMER) {
        const defPartner = await resolveDefaultCompanyPartner();
        if (defPartner) {
          appPartnerId = defPartner._id;
          appRmId = defPartner.rmId;
          await User.updateOne({ _id: customerUser._id }, { $set: { partnerId: appPartnerId, rmId: appRmId } });
        }
      }

      // Resolve RSM and ASM based on RM & loanType
      let assignedRsmId = null;
      let assignedAsmId = req.user.role === ROLES.PARTNER ? (partner?.asmId || null) : null;
      if (appRmId) {
        const rmDoc = await User.findById(appRmId).select("personalRsmId businessHomeRsmId asmId").lean();
        if (rmDoc) {
          if (loanType === "PERSONAL") {
            assignedRsmId = rmDoc.personalRsmId || null;
          } else {
            assignedRsmId = rmDoc.businessHomeRsmId || null;
          }
          if (assignedRsmId && !assignedAsmId) {
            const rsmDoc = await User.findById(assignedRsmId).select("asmId").lean();
            if (rsmDoc?.asmId) assignedAsmId = rsmDoc.asmId;
          }
          if (!assignedAsmId && rmDoc.asmId) {
            assignedAsmId = rmDoc.asmId;
          }
        }
      }

      // Create Application
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
            partnerId: appPartnerId || null,
            rmId: appRmId || null,
            rsmId: assignedRsmId || null,
            asmId: assignedAsmId || null,
            customerId: customerUser._id,
            loanType,
            customer: {
              firstName: customer.firstName,
              middleName: customer.middleName || "",
              lastName: customer.lastName || "",
              email: customer.email,
              phone: customer.phone,
              mothersName: customer.mothersName || "",
              panNumber: customer.panNumber || "",
              dateOfBirth: customer.dateOfBirth,
              gender: customer.gender,
              maritalStatus: customer.maritalStatus,
              currentAddress: product.currentAddress,
              permanentAddress: product.permanentAddress || product.currentAddress,
              loanAmount: customer.loanAmount
                ? Number(customer.loanAmount)
                : undefined,
              partnerId: appPartnerId || null,
              rmId: appRmId || null,
              rsmId: assignedRsmId || null,
              asmId: assignedAsmId || null,
            },
            docs,
            references: refs,
            employmentInfo,
            businessInfo,
            propertyInfo,
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
          } else {
            // Other errors, throw immediately
            throw createError;
          }
        }
      }

      res.status(201).json({
        message: "Application + Customer created",
        id: app._id,
        appNo: app.appNo,
        status: app.status,
        customerLogin: {
          email: customerUser.email,
          password: customer.password ? customer.password : tempPassword,
        },
      });
    } catch (err) {
      console.error(err);
      // Convert MongoDB duplicate-key (E11000) into a clean UI message
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

// router.get(
//   "/get-applications",
//   auth,
//   requireRole("CUSTOMER"),
//   async (req, res) => {
//     try {
//       const customerId = req.user.sub;

//       if (!customerId) {
//         return res.status(400).json({ message: "Missing customer ID" });
//       }

//       // Fetch all applications for this customer and populate partner (User)
//       const applications = await Application.find({ customerId })
//         .populate({
//           path: "partnerId",
//           model: "User", // 👈 force populate from User collection
//           select: "employeeId firstName lastName email phone",
//         })
//         .lean();

//       if (!applications.length) return res.json([]);

//       const result = applications.map((app) => {
//         const lastStage =
//           app.stageHistory && app.stageHistory.length > 0
//             ? app.stageHistory[app.stageHistory.length - 1]
//             : null;

//         return {
//           appNo: app.appNo || "",
//           loanType: app.loanType || "",
//           appliedLoanAmount: app.customer?.loanAmount || 0,
//           approvedLoanAmount: app.approvedLoanAmount || null,
//           status: app.status || "",
//           remarks: lastStage?.note || null,
//           lastUpdateDate: lastStage?.at || null,
//           formFillingDate: app.createdAt || null,
//           customer: {
//             firstName: app.customer?.firstName || "",
//             middleName: app.customer?.middleName || "",
//             lastName: app.customer?.lastName || "",
//             email: app.customer?.email || "",
//             phone: app.customer?.phone || "",
//           },
//           partner: app.partnerId
//             ? {
//                 _id: app.partnerId._id,
//                 employeeId: app.partnerId.employeeId || "",
//                 firstName: app.partnerId.firstName || "",
//                 lastName: app.partnerId.lastName || "",
//                 email: app.partnerId.email || "",
//                 phone: app.partnerId.phone || "",
//               }
//             : null,
//         };
//       });

//       return res.json(result);
//     } catch (err) {
//       console.error("Customer applications error:", err.stack);
//       return res
//         .status(500)
//         .json({ message: "Failed to fetch applications", error: err.message });
//     }
//   }
// );

router.get(
  "/get-applications",
  auth,
  requireRole("CUSTOMER"),
  async (req, res) => {
    try {
      const customerId = req.user.sub;

      if (!customerId) {
        return res.status(400).json({ message: "Missing customer ID" });
      }

      // Fetch all applications for this customer and populate partner + RM
      const applications = await Application.find({ customerId })
        .populate({
          path: "partnerId",
          model: "User",
          select: "employeeId firstName lastName email phone",
        })
        .populate({
          path: "rmId", // 👈 must exist in Application schema
          model: "User",
          select: "employeeId firstName lastName email phone",
        })
        .lean();

      if (!applications.length) return res.json([]);

      const result = applications.map((app) => {
        const lastStage =
          app.stageHistory && app.stageHistory.length > 0
            ? app.stageHistory[app.stageHistory.length - 1]
            : null;

        // Mask internal statuses: LOGIN is shown as DOC_COMPLETE to customer
        const maskedStatus =
          app.status === "LOGIN" ? "DOC_COMPLETE" : app.status;

        return {
          appNo: app.appNo || "",
          loanType: app.loanType || "",
          appliedLoanAmount: app.customer?.loanAmount || 0,
          approvedLoanAmount: app.approvedLoanAmount || null,
          status: maskedStatus || "",
          remarks: lastStage?.note || null,
          lastUpdateDate: lastStage?.at || null,
          formFillingDate: app.createdAt || null,
          customer: {
            firstName: app.customer?.firstName || "",
            middleName: app.customer?.middleName || "",
            lastName: app.customer?.lastName || "",
            email: app.customer?.email || "",
            phone: app.customer?.phone || "",
          },
          partner: app.partnerId
            ? {
                _id: app.partnerId._id,
                employeeId: app.partnerId.employeeId || "",
                firstName: app.partnerId.firstName || "",
                lastName: app.partnerId.lastName || "",
                email: app.partnerId.email || "",
                phone: app.partnerId.phone || "",
              }
            : null,
          rm: app.rmId
            ? {
                _id: app.rmId._id,
                employeeId: app.rmId.employeeId || "",
                firstName: app.rmId.firstName || "",
                lastName: app.rmId.lastName || "",
                email: app.rmId.email || "",
                phone: app.rmId.phone || "",
              }
            : null,
        };
      });

      return res.json(result);
    } catch (err) {
      console.error("Customer applications error:", err.stack);
      return res
        .status(500)
        .json({ message: "Failed to fetch applications", error: err.message });
    }
  }
);

/** ✅ Get Customer Profile */

router.get("/profile", auth, requireRole(ROLES.CUSTOMER), async (req, res) => {
  try {
    const customer = await User.findById(req.user.sub)
      .select("-passwordHash")
      .populate({
        path: "partnerId", // assuming customer has partnerId field
        select: "firstName lastName email phone rmId",
      })
      .populate({
        path: "partnerId.rmId", // RM under Partner
        select: "firstName lastName email phone asmId region",
      })
      .populate({
        path: "partnerId.rmId.asmId", // ASM under RM
        select: "firstName lastName email phone region",
      })
      .lean();

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json({
      customerId: customer._id,
      firstName: customer.firstName,
      middleName: customer.middleName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      mothersName: customer.mothersName,
      panNumber: customer.panNumber,
      dateOfBirth: customer.dateOfBirth,
      gender: customer.gender,
      maritalStatus: customer.maritalStatus,
      status: customer.status,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,

      // Mapping hierarchy
      mappedUnder: {
        partner: customer.partnerId
          ? {
              id: customer.partnerId._id,
              name: `${customer.partnerId.firstName} ${customer.partnerId.lastName}`,
              email: customer.partnerId.email,
              phone: customer.partnerId.phone,
            }
          : null,
        rm: customer.partnerId?.rmId
          ? {
              id: customer.partnerId.rmId._id,
              name: `${customer.partnerId.rmId.firstName} ${customer.partnerId.rmId.lastName}`,
              email: customer.partnerId.rmId.email,
              phone: customer.partnerId.rmId.phone,
              region: customer.partnerId.rmId.region,
            }
          : null,
        asm: customer.partnerId?.rmId?.asmId
          ? {
              id: customer.partnerId.rmId.asmId._id,
              name: `${customer.partnerId.rmId.asmId.firstName} ${customer.partnerId.rmId.asmId.lastName}`,
              email: customer.partnerId.rmId.asmId.email,
              phone: customer.partnerId.rmId.asmId.phone,
              region: customer.partnerId.rmId.asmId.region,
            }
          : null,
      },
    });
  } catch (err) {
    console.error("Error fetching customer profile:", err);
    res.status(500).json({ message: "Something went wrong" });
  }
});

/** ✅ Update Customer Profile */
router.patch(
  "/profile/update",
  auth,
  requireRole(ROLES.CUSTOMER),
  async (req, res) => {
    try {
      const allowedFields = [
        "firstName",
        "middleName",
        "lastName",
        "email",
        "phone",
        "mothersName",
        "panNumber",
        "dateOfBirth",
        "gender",
        "maritalStatus",
      ];

      const updates = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          if (field === "email") {
            const emailLc = String(req.body.email).toLowerCase().trim();
            const duplicate = await User.findOne({
              email: emailLc,
              _id: { $ne: req.user.sub },
            });
            if (duplicate) {
              return res.status(409).json({ message: "Email already in use by another account" });
            }
            updates.email = emailLc;
          } else {
            updates[field] = req.body[field];
          }
        }
      }

      const updatedCustomer = await User.findByIdAndUpdate(
        req.user.sub,
        { $set: updates },
        { new: true, runValidators: true }
      ).select(
        "firstName middleName lastName email phone mothersName panNumber dob gender maritalStatus status updatedAt"
      );

      if (!updatedCustomer) {
        return res.status(404).json({ message: "Customer not found" });
      }

      res.json({
        message: "Profile updated successfully",
        customer: updatedCustomer,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Something went wrong" });
    }
  }
);

export default router;
