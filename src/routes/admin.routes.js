import { Router } from "express";
import argon2 from "argon2";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { User } from "../models/User.js";
import { makeRmCode, makeAsmCode } from "../utils/codes.js";
import { Application } from "../models/Application.js";
import { Payout } from "../models/Payout.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { Target } from "../models/Target.js";
import { bannerUpload } from "../middleware/bannerUpload.js";
import { Banner } from "../models/Banner.js";
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
//             <p>Regards,<br/>Trustline Fintech</p>
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

router.post(
  "/create-asm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { firstName, lastName, phone, email, dob, region, password } =
        req.body || {};

      if (!firstName || !lastName || !email || !phone) {
        return res.status(400).json({ message: "name and email required" });
      }

      const exists = await User.findOne({ email: email.toLowerCase() });
      if (exists) {
        return res.status(409).json({ message: "Email already in use" });
      }

      const rawPassword =
        password || `Asm@${Math.random().toString(36).slice(2, 10)}`;

      const asm = await User.create({
        firstName,
        lastName,
        phone,
        email: email.toLowerCase(),
        passwordHash: await argon2.hash(rawPassword),
        role: ROLES.ASM,
        employeeId: await generateEmployeeId("ASM"),
        asmCode: makeAsmCode(),
        dob,
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

      // 🔹 STEP 2: Redistribute targets if already assigned
      const now = new Date();
      const month = now.getMonth() + 1; // current month
      const year = now.getFullYear();

      // Get all ASM targets for this admin
      const allAsms = await User.find({
        role: ROLES.ASM,
        adminId: req.user.sub,
      }).lean();
      const asmTargets = await Target.find({
        role: ROLES.ASM,
        month,
        year,
        assignedBy: req.user.sub,
      });

      if (asmTargets.length) {
        // Calculate total ASM target from DB
        const totalTarget = asmTargets.reduce(
          (sum, t) => sum + t.targetValue,
          0
        );

        // Recalculate equal share
        const perAsmTarget = totalTarget / allAsms.length;

        for (let a of allAsms) {
          let target = await Target.findOne({
            assignedTo: a._id,
            role: ROLES.ASM,
            month,
            year,
          });

          if (target) {
            target.targetValue = perAsmTarget;
            await target.save();
          } else {
            target = await Target.create({
              assignedBy: req.user.sub,
              assignedTo: a._id,
              role: ROLES.ASM,
              month,
              year,
              targetValue: perAsmTarget,
            });
          }

          // 🔹 Redistribute to RMs
          const rms = await User.find({ role: ROLES.RM, asmId: a._id }).lean();
          if (rms.length) {
            const perRmTarget = perAsmTarget / rms.length;

            for (let rm of rms) {
              let rmT = await Target.findOne({
                assignedTo: rm._id,
                role: ROLES.RM,
                month,
                year,
              });
              if (rmT) {
                rmT.targetValue = perRmTarget;
                await rmT.save();
              } else {
                rmT = await Target.create({
                  assignedBy: req.user.sub,
                  assignedTo: rm._id,
                  role: ROLES.RM,
                  month,
                  year,
                  targetValue: perRmTarget,
                });
              }

              // 🔹 Redistribute to Partners
              const partners = await User.find({
                role: ROLES.PARTNER,
                rmId: rm._id,
              }).lean();
              if (partners.length) {
                const perPartnerTarget = perRmTarget / partners.length;

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
                    pT = await Target.create({
                      assignedBy: req.user.sub,
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
          }
        }
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
      return res.status(500).json({ message: "Internal Server Error" });
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
        region,
        password,
        asmId,
      } = req.body || {};

      if (!firstName || !lastName || !email || !phone || !asmId) {
        return res.status(400).json({
          message: "First name, last name, email, phone, and asmId required",
        });
      }

      // Check if email already exists
      const exists = await User.findOne({ email: email.toLowerCase() });
      if (exists)
        return res.status(409).json({ message: "Email already in use" });

      // Check if ASM exists
      const asm = await User.findOne({ _id: asmId, role: ROLES.ASM });
      if (!asm) return res.status(404).json({ message: "ASM not found" });

      const rawPassword =
        password || `Rm@${Math.random().toString(36).slice(2, 10)}`;

      // Create RM
      const rm = await User.create({
        employeeId: await generateEmployeeId("RM"),
        firstName,
        lastName,
        phone,
        region: asm.region, // inherit region from ASM
        email: email.toLowerCase(),
        passwordHash: await argon2.hash(rawPassword),
        role: ROLES.RM,
        rmCode: makeRmCode(),
        asmId: asm._id, // link to ASM
        dob,
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

      // 🔹 STEP 2: Redistribute ASM’s target among all RMs
      const now = new Date();
      const month = now.getMonth() + 1; // current month
      const year = now.getFullYear();

      // Find ASM target for this month/year
      const asmTargetDoc = await Target.findOne({
        assignedTo: asm._id,
        role: ROLES.ASM,
        month,
        year,
      });

      if (asmTargetDoc) {
        // Get all RMs under this ASM
        const rms = await User.find({ role: ROLES.RM, asmId: asm._id }).lean();
        const perRmTarget = asmTargetDoc.targetValue / rms.length;

        for (let r of rms) {
          let rmT = await Target.findOne({
            assignedTo: r._id,
            role: ROLES.RM,
            month,
            year,
          });

          if (rmT) {
            rmT.targetValue = perRmTarget; // redistribute equally
            await rmT.save();
          } else {
            rmT = await Target.create({
              assignedBy: asmTargetDoc.assignedBy,
              assignedTo: r._id,
              role: ROLES.RM,
              month,
              year,
              targetValue: perRmTarget,
            });
          }

          // 🔹 Distribute RM’s target to Partners
          const partners = await User.find({
            role: ROLES.PARTNER,
            rmId: r._id,
          }).lean();
          if (partners.length) {
            const perPartnerTarget = perRmTarget / partners.length;

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
                pT = await Target.create({
                  assignedBy: asmTargetDoc.assignedBy,
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
      }

      return res.status(201).json({
        message: "RM created and targets redistributed",
        id: rm._id,
        rmCode: rm.rmCode,
        employeeId: rm.employeeId,
        assignedAsm: {
          id: asm._id,
          name: `${asm.firstName} ${asm.lastName}`,
          region: asm.region,
        },
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
        .lean();

      // Flatten asm details into same object
      const formatted = list.map((rm) => {
        const asm = rm.asmId;

        return {
          ...rm,
          asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
          asmEmployeeId: asm ? asm.employeeId : null,
          asmId: asm ? asm._id : null, // use _id, not asmId
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Error fetching RMs" });
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
      const list = await User.find({ role: ROLES.PARTNER })
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

      // Partners currently under Admin (rmId = admin._id)
      const partners = await User.find({
        role: ROLES.PARTNER,
        rmId: admin._id, // explicitly under Admin
      })
        .select("-passwordHash -__v")
        .lean();

      // Map partners and keep stored doc URLs (S3 URLs already absolute)
      const formatted = partners.map((p) => {
        return {
          ...p,
          rmId: admin._id,
          rmName: `${admin.firstName} ${admin.lastName}`,
          rmEmployeeId: admin.employeeId,
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
        rmId: admin._id, // currently under Admin
      });
      if (!partner)
        return res
          .status(404)
          .json({ message: "Partner not found or not under Admin" });

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
              <p>Thanks,<br/>Trustline Fintech Team</p>
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

      // Users count
      const totalASM = await User.countDocuments({ role: ROLES.ASM });
      const totalRM = await User.countDocuments({ role: ROLES.RM });
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
        totalASM,
        totalRM,
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
  "/assign-rms-to-asm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { oldAsmId, newAsmId } = req.body;

      console.log(oldAsmId);

      if (!oldAsmId || !newAsmId) {
        return res.status(400).json({ message: "Both ASM IDs are required" });
      }

      // 1️⃣ Reassign all RMs from old ASM to new ASM
      const rms = await User.find({ role: ROLES.RM, asmId: oldAsmId }, "_id");
      const rmIds = rms.map((rm) => rm._id);

      await User.updateMany(
        { role: ROLES.RM, asmId: oldAsmId },
        { $set: { asmId: newAsmId } }
      );

      // 2️⃣ Reassign Partners under those RMs
      const partners = await User.find(
        { role: ROLES.PARTNER, rmId: { $in: rmIds } },
        "_id"
      );
      const partnerIds = partners.map((p) => p._id);

      await User.updateMany(
        { role: ROLES.PARTNER, rmId: { $in: rmIds } },
        { $set: { asmId: newAsmId } }
      );

      // 3️⃣ Reassign Customers under those Partners
      if (partnerIds.length > 0) {
        await User.updateMany(
          { partnerId: { $in: partnerIds } },
          { $set: { asmId: newAsmId } }
        );
      }

      // 4️⃣ Deactivate the old ASM
      const oldAsm = await User.findOneAndUpdate(
        { _id: oldAsmId, role: ROLES.ASM },
        { $set: { status: "SUSPENDED" } },
        { new: true }
      );

      // 4️⃣ Deactivate the old ASM
      // 5️⃣ Fetch new RM details (no update required)
      const newAsm = await User.findById(newAsmId);
      if (!newAsm || newAsm.role !== ROLES.ASM) {
        return res
          .status(404)
          .json({ message: "New ASM not found or invalid" });
      }

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
              <p>Regards,<br/>Trustline Fintech</p>
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
              <p>Regards,<br/>Trustline Fintech</p>
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
      });
    } catch (error) {
      console.error("Error in assign-rms-to-asm:", error);
      res.status(500).json({ message: error.message });
    }
  }
);

router.post(
  "/activate-asm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { asmId } = req.body;

      if (!asmId) {
        return res.status(400).json({ message: "asmId is required" });
      }

      const asm = await User.findByIdAndUpdate(
        asmId,
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
            <p>We are pleased to inform you that your ASM account has been <b>activated</b>.</p>
            <p><b>Employee ID:</b> ${asm.employeeId}</p>
            <p><b>ASM Code:</b> ${asm.asmCode}</p>
            <p>You can now log in using your registered email and password.</p>
            <br/>
            <p>Regards,<br/>Trustline Fintech</p>
          `,
        });
      } catch (mailErr) {
        console.error("Failed to send activation email:", mailErr.message);
        // Continue response even if email fails
      }

      res.json({
        message: "ASM activated successfully",
        asm,
      });
    } catch (error) {
      console.error("Error activating ASM:", error);
      res.status(500).json({ message: error.message });
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

router.post(
  "/assign-partners-rm",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { oldRmId, newRmId } = req.body;

      if (!oldRmId || !newRmId) {
        return res.status(400).json({ message: "Both RM IDs are required" });
      }

      // 1️⃣ Find all partners under old RM
      const partners = await User.find(
        { role: ROLES.PARTNER, rmId: oldRmId },
        "_id"
      );
      const partnerIds = partners.map((p) => p._id);

      // 2️⃣ Reassign all Partners to new RM
      await User.updateMany(
        { role: ROLES.PARTNER, rmId: oldRmId },
        { $set: { rmId: newRmId } }
      );

      // 3️⃣ Reassign all Customers of those Partners to new RM
      if (partnerIds.length > 0) {
        await User.updateMany(
          { partnerId: { $in: partnerIds } },
          { $set: { rmId: newRmId } }
        );
      }

      // 4️⃣ Deactivate the old RM and fetch details
      const oldRm = await User.findOneAndUpdate(
        { _id: oldRmId, role: ROLES.RM },
        { $set: { status: "SUSPENDED" } },
        { new: true }
      );

      // 5️⃣ Fetch new RM details (no update required)
      const newRm = await User.findById(newRmId);
      if (!newRm || newRm.role !== ROLES.RM) {
        return res.status(404).json({ message: "New RM not found or invalid" });
      }

      if (oldRm) {
        // 📧 Send deactivation mail
        try {
          await sendMail({
            to: oldRm.email,
            subject: "Your RM Account Has Been Deactivated",
            html: `
              <p>Dear ${oldRm.firstName} ${oldRm.lastName},</p>
              <p>Your RM account has been <b>deactivated</b>. All your Partners and their Customers have been reassigned to another RM.</p>
              <p><b>Employee ID:</b> ${oldRm.employeeId}</p>
              <p><b>RM Code:</b> ${oldRm.rmCode}</p>
              <p>If you believe this action was incorrect, please contact support immediately.</p>
              <br/>
              <p>Regards,<br/>Trustline Fintech</p>
            `,
          });
          console.log("📧 Deactivation mail sent to:", oldRm.email);
        } catch (mailErr) {
          console.error(
            "❌ Failed to send deactivation email:",
            mailErr.message
          );
        }
      }

      if (newRm) {
        try {
          await sendMail({
            to: newRm.email,
            subject: "You Have Been Assigned New Partners & Customers",
            html: `
              <p>Dear ${newRm.firstName} ${newRm.lastName},</p>
              <p>You have been assigned new <b>Partners</b> and their <b>Customers</b>.</p>
              <p><b>Employee ID:</b> ${newRm.employeeId}</p>
              <p><b>RM Code:</b> ${newRm.rmCode}</p>
              <p>Please check your dashboard for details of the reassigned accounts.</p>
              <br/>
              <p>Regards,<br/>Trustline Fintech</p>
            `,
          });
          console.log("📧 Assignment mail sent to:", newRm.email);
        } catch (mailErr) {
          console.error("❌ Failed to send assignment email:", mailErr.message);
        }
      }

      res.json({
        message:
          "All Partners and their Customers reassigned to new RM, old RM deactivated and notified",
      });
    } catch (error) {
      console.error("Error in assign-partners-rm:", error);
      res.status(500).json({ message: error.message });
    }
  }
);

router.post(
  "/rm/activate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { rmId } = req.body;

      if (!rmId) {
        return res.status(400).json({ message: "rmId is required" });
      }

      const rm = await User.findByIdAndUpdate(
        rmId,
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
            <p>Regards,<br/>Trustline Fintech</p>
          `,
        });
        console.log("📧 Activation mail sent to:", rm.email);
      } catch (mailErr) {
        console.error("❌ Failed to send activation email:", mailErr.message);
      }

      res.json({
        message: "RM activated successfully and notified via email",
        rm,
      });
    } catch (error) {
      console.error("Error in /rm/activate:", error);
      res.status(500).json({ message: error.message });
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
  "/deactivate-partner",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
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

router.post(
  "/partner/activate",
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
            <p>Regards,<br/>Trustline Fintech</p>
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
        email,
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

      res.json({
        message: "Profile updated successfully",
        profile: updatedAdmin,
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

router.post(
  "/target/assign-asm-bulk",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      let { month, year, totalTarget } = req.body;
      if (!month || !year || !totalTarget) {
        return res
          .status(400)
          .json({ message: "Month, year, and totalTarget are required" });
      }

      totalTarget = Number(totalTarget);
      year = Number(year);

      // Month mapping
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
      if (typeof month === "string") month = monthMap[month];
      if (!month || month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month" });
      }

      const assignerId = req.user.sub;

      // Get all ASMs under this Admin
      const asms = await User.find({
        role: ROLES.ASM,
        adminId: assignerId,
      }).lean();

      if (!asms.length) {
        return res.status(404).json({ message: "No ASMs found" });
      }

      const assignments = [];
      const asmTarget = Number((totalTarget / asms.length).toFixed(2));

      for (let asm of asms) {
        // 🔹 Assign target to ASM
        let target = await Target.findOne({
          assignedTo: asm._id,
          role: ROLES.ASM,
          month,
          year,
        });

        let finalAsmTarget = asmTarget;

        if (target) {
          target.targetValue = Number(
            (target.targetValue + asmTarget).toFixed(2)
          ); // cumulative
          target.assignedBy = assignerId;
          await target.save();
          finalAsmTarget = target.targetValue;
        } else {
          target = await Target.create({
            assignedBy: assignerId,
            assignedTo: asm._id,
            role: ROLES.ASM,
            month,
            year,
            targetValue: asmTarget,
          });
        }
        assignments.push(target);

        // 🔹 Distribute ASM target among RMs
        const rms = await User.find({ role: ROLES.RM, asmId: asm._id }).lean();
        if (rms.length) {
          const perRmTarget = Number((asmTarget / rms.length).toFixed(2));

          for (let rm of rms) {
            let rmT = await Target.findOne({
              assignedTo: rm._id,
              role: ROLES.RM,
              month,
              year,
            });

            if (rmT) {
              rmT.targetValue = perRmTarget; // overwrite
              rmT.assignedBy = assignerId;
              await rmT.save();
            } else {
              rmT = await Target.create({
                assignedBy: assignerId,
                assignedTo: rm._id,
                role: ROLES.RM,
                month,
                year,
                targetValue: perRmTarget,
              });
            }
            assignments.push(rmT);

            // 🔹 Distribute RM target among Partners
            const partners = await User.find({
              role: ROLES.PARTNER,
              rmId: rm._id,
            }).lean();
            if (partners.length) {
              const perPartnerTarget = Number(
                (perRmTarget / partners.length).toFixed(2)
              );
              for (let p of partners) {
                let pT = await Target.findOne({
                  assignedTo: p._id,
                  role: ROLES.PARTNER,
                  month,
                  year,
                });

                if (pT) {
                  pT.targetValue = perPartnerTarget; // overwrite
                  pT.assignedBy = assignerId;
                  await pT.save();
                } else {
                  pT = await Target.create({
                    assignedBy: assignerId,
                    assignedTo: p._id,
                    role: ROLES.PARTNER,
                    month,
                    year,
                    targetValue: perPartnerTarget,
                  });
                }
                assignments.push(pT);
              }
            }
          }
        }
      }

      res.status(201).json({
        message: "Bulk hierarchical target assigned successfully",
        totalTarget,
        month,
        year,
        assignments,
      });
    } catch (err) {
      console.error("Bulk hierarchical target error:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

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

router.post(
  "/target/assign-bulk",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      let { month, year, totalTarget } = req.body;
      if (!month || !year || !totalTarget)
        return res
          .status(400)
          .json({ message: "Month, year, totalTarget required" });

      totalTarget = Number(totalTarget);
      year = Number(year);

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
      if (typeof month === "string") month = monthMap[month];
      if (!month || month < 1 || month > 12)
        return res.status(400).json({ message: "Invalid month" });

      const assignerId = req.user.sub;

      // Get all ASMs under this admin
      const asms = await User.find({
        role: ROLES.ASM,
        adminId: assignerId,
      }).lean();
      if (!asms.length)
        return res.status(404).json({ message: "No ASMs found" });

      const assignments = [];
      const asmTarget = Number((totalTarget / asms.length).toFixed(2));

      for (let asm of asms) {
        let target = await Target.findOne({
          assignedTo: asm._id,
          role: ROLES.ASM,
          month,
          year,
        });

        if (target) {
          // Add new increment
          target.targetValue = Number(
            (target.targetValue + asmTarget).toFixed(2)
          );
          target.assignedBy = assignerId;
          await target.save();
        } else {
          target = await Target.create({
            assignedBy: assignerId,
            assignedTo: asm._id,
            role: ROLES.ASM,
            month,
            year,
            targetValue: asmTarget,
          });
        }
        assignments.push(target);

        // Get RMs under ASM
        const rms = await User.find({ role: ROLES.RM, asmId: asm._id }).lean();
        if (rms.length) {
          const perRmTarget = Number((asmTarget / rms.length).toFixed(2));

          for (let rm of rms) {
            let rmT = await Target.findOne({
              assignedTo: rm._id,
              role: ROLES.RM,
              month,
              year,
            });
            if (rmT) {
              rmT.targetValue = Number(
                (rmT.targetValue + perRmTarget).toFixed(2)
              );
              rmT.assignedBy = assignerId;
              await rmT.save();
            } else {
              rmT = await Target.create({
                assignedBy: assignerId,
                assignedTo: rm._id,
                role: ROLES.RM,
                month,
                year,
                targetValue: perRmTarget,
              });
            }
            assignments.push(rmT);

            // Get Partners under RM
            const partners = await User.find({
              role: ROLES.PARTNER,
              rmId: rm._id,
            }).lean();
            if (partners.length) {
              const perPartnerTarget = Number(
                (perRmTarget / partners.length).toFixed(2)
              );

              for (let p of partners) {
                let pT = await Target.findOne({
                  assignedTo: p._id,
                  role: ROLES.PARTNER,
                  month,
                  year,
                });
                if (pT) {
                  pT.targetValue = Number(
                    (pT.targetValue + perPartnerTarget).toFixed(2)
                  );
                  pT.assignedBy = assignerId;
                  await pT.save();
                } else {
                  pT = await Target.create({
                    assignedBy: assignerId,
                    assignedTo: p._id,
                    role: ROLES.PARTNER,
                    month,
                    year,
                    targetValue: perPartnerTarget,
                  });
                }
                assignments.push(pT);
              }
            }
          }
        }
      }

      res.status(201).json({
        message: "Bulk hierarchical target assigned successfully",
        totalTarget,
        month,
        year,
        assignments,
      });
    } catch (err) {
      console.error("Bulk hierarchical target error:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

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

      // Helper: Sum disbursed amounts
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
          targetValue: t ? Number(t.targetValue) : 0,
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
        const partners = await User.find({ rmId: id, role: ROLES.PARTNER })
          .select("_id")
          .lean();
        const partnerIds = partners.map((x) => x._id);

        const customers = await Application.distinct("customerId", {
          partnerId: { $in: partnerIds },
        });

        totalDisbursed = await sumDisbursedBy({ rmId: user._id });
        assignedTargetValue = await getAssignedTarget(user._id, ROLES.RM, {
          rmId: user._id,
        });

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

      if (user.role === ROLES.CUSTOMER) {
        totalDisbursed = await sumDisbursedBy({ customerId: user._id });
        assignedTargetValue = 0;
        performance = undefined;
        totals = {};
      }

      // Response
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

export default router;
