import { Router } from "express";
import argon2 from "argon2";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { User } from "../models/User.js";
import { makeRmCode } from "../utils/codes.js";
import { Payout } from "../models/Payout.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { Target } from "../models/Target.js";
import mongoose from "mongoose";
import { Application } from "../models/Application.js";
import { sendMail } from "../utils/sendMail.js";
import { sendUserAccountEmail } from "../utils/emailService.js";

const router = Router();

router.post("/create-rm", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { firstName, lastName, phone, dob, region, email, password } =
      req.body || {};
    const asmId = req.user.sub; // ASM id from token

    if (!firstName || !lastName || !email || !phone)
      return res.status(400).json({ message: "name and email required" });

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists)
      return res.status(409).json({ message: "Email already in use" });

    const rawPassword =
      password || `Rm@${Math.random().toString(36).slice(2, 10)}`;

    const rm = await User.create({
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
      asmId, // 🔥 save parent ASM link
    });

    // 📧 Send mail to RM after creation using professional email service
    try {
      const asmUser = await User.findById(asmId);
      const emailSent = await sendUserAccountEmail(
        rm, 
        "RM", 
        password ? null : rawPassword,
        asmUser ? { firstName: asmUser.firstName, lastName: asmUser.lastName } : null
      );
      if (emailSent) {
        console.log(`✅ RM creation email sent to: ${rm.email}`);
      }
    } catch (mailErr) {
      console.error("❌ Failed to send RM creation email:", mailErr.message);
    }

    // 🔹 STEP 2: Redistribute ASM target among all RMs
    const now = new Date();
    const month = now.getMonth() + 1; // current month
    const year = now.getFullYear();

    const asmTargetDoc = await Target.findOne({
      assignedTo: asmId,
      role: ROLES.ASM,
      month,
      year,
    });

    if (asmTargetDoc) {
      // Get all RMs under this ASM
      const rms = await User.find({ role: ROLES.RM, asmId }).lean();
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
      tempPassword: password ? undefined : rawPassword,
    });
  } catch (err) {
    console.error("Error creating RM:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.get("/get-rm", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    const list = await User.find({ role: ROLES.RM, asmId })
      .select("-passwordHash -__v")
      .populate({
        path: "asmId",
        select: "firstName lastName employeeId",
      })
      .lean();

    const formatted = list.map((rm) => {
      const asm = rm.asmId;
      delete rm.asmId;

      return {
        ...rm,
        asmId: asm ? asm._id : null,
        asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
        asmEmployeeId: asm ? asm.employeeId : null,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching RMs:", err);
    res.status(500).json({ message: "Error fetching RMs" });
  }
});

// Get partners (ASM)
router.get("/get-partners", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub; // ✅ logged-in ASM ID

    // Fetch only partners whose RM belongs to this ASM
    const list = await User.find({ role: ROLES.PARTNER })
      .select("-passwordHash -__v")
      .populate({
        path: "rmId", // populate RM details
        match: { asmId }, // ✅ filter only RMs under this ASM
        select: "firstName lastName employeeId asmId",
        populate: {
          path: "asmId",
          select: "firstName lastName employeeId",
        },
      })
      .lean();

    // Filter out partners without matching RMs
    const filtered = list.filter((partner) => partner.rmId);

    const formatted = filtered.map((partner) => {
      const rm = partner.rmId;
      const asm = rm?.asmId;
      const BASE_URL = process.env.BACKEND_URL || "http://localhost:5000";
      // ✅ safely fetch profile pic
      let profilePicUrl = null;
      if (Array.isArray(partner.docs)) {
        const selfieDoc = partner.docs.find((doc) => doc.docType === "SELFIE");
        if (selfieDoc?.url) {
          // normalize path and prepend BASE_URL only if needed
          const cleanPath = selfieDoc.url
            .replace(/\\/g, "/")
            .replace(/^\/+/, "");
          profilePicUrl = selfieDoc.url.startsWith("http")
            ? selfieDoc.url
            : `${BASE_URL.replace(/\/$/, "")}/${cleanPath}`;
        }
      }

      return {
        ...partner,
        rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,
        rmEmployeeId: rm ? rm.employeeId : null,
        rmId: rm ? rm._id : null,
        asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
        asmEmployeeId: asm ? asm.employeeId : null,
        asmId: asm ? asm._id : null,
        profilePic: profilePicUrl,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching ASM partners:", err);
    res.status(500).json({ message: "Error fetching ASM partners" });
  }
});

router.get("/get-customers", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub; // logged-in ASM userId

    const applications = await Application.find()
      .populate({
        path: "customerId", // populate User document for employeeId
        select: "employeeId _id firstName lastName",
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
      .select("appNo loanType approvedLoanAmount status createdAt customer") // include embedded customer
      .lean();

    // Filter out applications where RM didn't match (other ASMs)
    const filtered = applications.filter((app) => app.rmId);

    const formatted = filtered.map((app) => {
      const customer = app.customerId || {}; // populated user document
      const partner = app.partnerId || {};
      const rm = app.rmId || {};
      const asm = rm.asmId || {};

      return {
        appNo: app.appNo,
        loanType: app.loanType,
        loanAmount: app.loanAmount || 0,
        disburseAmount: app.approvedLoanAmount || 0,
        status: app.status,
        applicationDate: app.createdAt,

        // ✅ Customer info
        customerId: customer._id || null,
        userName: customer.firstName
          ? `${customer.firstName} ${customer.lastName}`
          : null,
        employeeId: customer.employeeId || null,
        email: customer.email || null,
        phone: customer.phone || null,

        // Partner info
        partnerName: partner.firstName
          ? `${partner.firstName} ${partner.lastName}`
          : null,
        partnerEmployeeId: partner.employeeId || null,

        // RM info
        rmName: rm.firstName ? `${rm.firstName} ${rm.lastName}` : null,
        rmEmployeeId: rm.employeeId || null,

        // ASM info
        asmName: asm.firstName ? `${asm.firstName} ${asm.lastName}` : null,
        asmEmployeeId: asm.employeeId || null,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching ASM applications:", err);
    res.status(500).json({ message: "Error fetching ASM applications" });
  }
});

// Get partners under a specific RM (ASM restricted)
router.get(
  "/rm/:rmId/get-partners",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      const asmId = req.user.sub;
      const { rmId } = req.params;

      const partners = await User.find({ role: ROLES.PARTNER, rmId })
        .select("-passwordHash -__v")
        .populate({
          path: "rmId",
          select: "firstName lastName employeeId asmId",
          populate: {
            path: "asmId",
            select: "firstName lastName employeeId",
          },
        })
        .lean();

      const formatted = partners.map((partner) => {
        const rm = partner.rmId;
        const asm = rm?.asmId;
        delete partner.rmId;

        return {
          ...partner,
          rmId: rm ? rm._id : null,
          rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,
          rmEmployeeId: rm ? rm.employeeId : null,
          asmId: asm ? asm._id : null,
          asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
          asmEmployeeId: asm ? asm.employeeId : null,
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching partners under RM:", err);
      res.status(500).json({ message: "Error fetching partners" });
    }
  }
);

// GET /api/asm-applications
router.get(
  "/get-applications",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      const asmId = req.user.sub; // logged-in ASM

      const applications = await Application.find()
        .populate({
          path: "customerId",
          select: "employeeId firstName lastName email phone",
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

      // Filter for ASM’s applications
      const filtered = applications.filter(
        (app) => app.rmId?.asmId?._id.toString() === asmId
      );

      // Format response for table
      const formatted = filtered.map((app) => {
        const customer = app.customer || {};
        const customerUser = app.customerId || {};

        return {
          username: customer.firstName
            ? `${customer.firstName} ${customer.lastName}`
            : null,
          userId: customerUser.employeeId || null,
          phone:
            customer.phone || customerUser.phone || customerUser.email || "-",
          applicationDate: app.createdAt,
          loanType: app.loanType,
          loanAmount: customer.loanAmount || 0,
          approvalAmount: app.approvedLoanAmount || 0,
          status: app.status,
          actionId: app._id, // you can use this for "View/Edit"
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching ASM applications:", err);
      res.status(500).json({ message: "Error fetching ASM applications" });
    }
  }
);

router.get("/dashboard", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    // ASM profile
    const asm = await User.findOne({ _id: asmId, role: ROLES.ASM }).lean();
    if (!asm) return res.status(404).json({ message: "ASM not found" });

    // All RMs under ASM
    const rms = await User.find({ asmId, role: ROLES.RM }).lean();
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
      rmId: { $in: rmIds },
    });
    const totalCustomers = customers.length;

    const inProcessApplications = await Application.countDocuments({
      rmId: { $in: rmIds },
      status: { $in: ["UNDER_REVIEW"] },
    });

    const revenueAgg = await Application.aggregate([
      {
        $match: {
          rmId: { $in: rmIds.map((id) => new mongoose.Types.ObjectId(id)) },
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

    // 12-Month Target (only ASM’s own target set by Admin)
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const monthlyTarget = await Target.aggregate([
      {
        $match: {
          assignedTo: new mongoose.Types.ObjectId(asmId), // ASM’s own target
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

    // 12-Month Achieved (RMs + Partners performance)
    const monthlyAchieved = await Application.aggregate([
      {
        $match: {
          rmId: { $in: rmIds.map((id) => new mongoose.Types.ObjectId(id)) },
          status: "DISBURSED",
          createdAt: { $gte: startOfYear },
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

    const targets = Array.from({ length: 12 }, (_, i) => {
      const month = i + 1;
      const t =
        monthlyTarget.find((m) => m._id.month === month)?.totalTarget || 0;
      const a =
        monthlyAchieved.find((m) => m._id.month === month)?.totalAchieved || 0;
      return { month: monthNames[i], target: t, achieved: a };
    });

    // Top Performers (RMs under this ASM)
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
      },
      targets,
      topPerformers,
    });
  } catch (error) {
    console.error("Error in ASM dashboard:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get(
  "/partner/:partnerId/get-customers",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      const asmId = req.user.sub; // ASM ID from token
      const { partnerId } = req.params;

      // 1. Verify that Partner belongs to an RM under this ASM
      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
      })
        .populate({
          path: "rmId",
          select: "firstName lastName employeeId asmId",
        })
        .lean();

      if (
        !partner ||
        !partner.rmId ||
        String(partner.rmId.asmId) !== String(asmId)
      ) {
        return res
          .status(404)
          .json({ message: "Partner not found under your ASM hierarchy" });
      }

      // 2. Fetch Customers under this Partner
      const customers = await User.find({ role: ROLES.CUSTOMER, partnerId })
        .select("-passwordHash -__v")
        .lean();

      // 3. Response formatting
      const formatted = customers.map((cust) => ({
        ...cust,
        partnerName: `${partner.firstName} ${partner.lastName}`,
        partnerEmployeeId: partner.employeeId,
        rmName: `${partner.rmId.firstName} ${partner.rmId.lastName}`,
        rmEmployeeId: partner.rmId.employeeId,
      }));

      res.json({
        asmId,
        rm: {
          id: partner.rmId._id,
          name: `${partner.rmId.firstName} ${partner.rmId.lastName}`,
          employeeId: partner.rmId.employeeId,
        },
        partner: {
          id: partner._id,
          name: `${partner.firstName} ${partner.lastName}`,
          employeeId: partner.employeeId,
        },
        customers: formatted,
      });
    } catch (err) {
      console.error("Error fetching customers under Partner:", err);
      res.status(500).json({ message: "Error fetching customers" });
    }
  }
);

router.post(
  "/assign-partners-rm",
  auth,
  requireRole(ROLES.ASM),
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

      // 2️⃣ Reassign partners from old RM to new RM
      await User.updateMany(
        { role: ROLES.PARTNER, rmId: oldRmId },
        { $set: { rmId: newRmId } }
      );

      // 3️⃣ Reassign customers under those partners to new RM
      if (partnerIds.length > 0) {
        await User.updateMany(
          { partnerId: { $in: partnerIds } },
          { $set: { rmId: newRmId } }
        );
      }

      // 4️⃣ Deactivate the old RM and get updated document
      const oldRm = await User.findOneAndUpdate(
        { _id: oldRmId, role: ROLES.RM },
        { $set: { status: "SUSPENDED" } },
        { new: true }
      );

      const newRm = await User.findById(newRmId);
      if (!newRm || newRm.role !== ROLES.RM) {
        return res.status(404).json({ message: "New RM not found or invalid" });
      }

      // 5️⃣ Send deactivation email
      if (oldRm) {
        try {
          await sendMail({
            to: oldRm.email,
            subject: "Your RM Account Has Been Deactivated",
            html: `
              <p>Dear ${oldRm.firstName} ${oldRm.lastName},</p>
              <p>Your RM account has been <b>deactivated</b> by your ASM.</p>
              <p>All your partners and their customers have been reassigned to another RM.</p>
              <br/>
              <p>If you think this is a mistake, please contact support immediately.</p>
              <br/>
              <p>Regards,<br/>Trustline Fintech</p>
            `,
          });
          console.log("📧 Deactivation mail sent to:", oldRm.email);
        } catch (mailErr) {
          console.error(
            "❌ Failed to send RM deactivation email:",
            mailErr.message
          );
        }
      }

      if (newRm) {
        try {
          await sendMail({
            to: newRm.email,
            subject: "You Have Been Assigned New RM Responsibilities",
            html: `
              <p>Dear ${newRm.firstName} ${newRm.lastName},</p>
              <p>You have been assigned new partners and their customers from another RM who has been deactivated.</p>
              <p>Please review your dashboard to manage your newly assigned team and customers.</p>
              <br/>
              <p>If you think this assignment is incorrect, please contact support immediately.</p>
              <br/>
              <p>Regards,<br/>Trustline Fintech</p>
            `,
          });
          console.log("📧 Assignment mail sent to:", newRm.email);
        } catch (mailErr) {
          console.error(
            "❌ Failed to send RM assignment email:",
            mailErr.message
          );
        }
      }

      res.json({
        message:
          "All Partners reassigned, customers under those partners moved to new RM, and old RM deactivated (mail sent)",
      });
    } catch (error) {
      console.error("Error in /assign-partners-rm:", error);
      res.status(500).json({ message: error.message });
    }
  }
);

// router.post(
//   "/assign-customers-partner",
//   auth,
//   requireRole(ROLES.ASM),
//   async (req, res) => {
//     try {
//       const { oldPartnerId, newPartnerId } = req.body;

//       if (!oldPartnerId) {
//         return res.status(400).json({ message: "oldPartnerId is required" });
//       }

//       const oldId = new mongoose.Types.ObjectId(oldPartnerId);
//       const newId = newPartnerId
//         ? new mongoose.Types.ObjectId(newPartnerId)
//         : null;

//       // 1️⃣ Validate old partner
//       const oldPartner = await User.findById(oldId);
//       if (!oldPartner || oldPartner.role !== ROLES.PARTNER) {
//         return res
//           .status(404)
//           .json({ message: "Old partner not found or not a partner" });
//       }

//       // 2️⃣ Validate new partner if provided
//       if (newId) {
//         const newPartner = await User.findById(newId);
//         if (!newPartner || newPartner.role !== ROLES.PARTNER) {
//           return res
//             .status(404)
//             .json({ message: "New partner not found or not a partner" });
//         }
//       }

//       // 3️⃣ Find all customers under old partner
//       const customers = await User.find({
//         partnerId: oldId,
//         role: ROLES.CUSTOMER,
//       }).select("_id");

//       const customerIds = customers.map((c) => c._id);
//       console.log(`Found ${customerIds.length} customers under old partner`);

//       // 4️⃣ Reassign customers in Users collection
//       if (customerIds.length > 0) {
//         const updateUsers = await User.updateMany(
//           { _id: { $in: customerIds } },
//           {
//             $set: { partnerId: newId, status: newId ? "ACTIVE" : "UNASSIGNED" },
//           }
//         );
//         console.log(
//           `Updated ${updateUsers.modifiedCount} customers in Users collection`
//         );
//       }

//       // 5️⃣ Reassign in Applications collection
//       // Make sure we update all Applications where old partner is assigned
//       const updateApps = await Application.updateMany(
//         { partnerId: oldId },
//         { $set: { partnerId: newId } }
//       );
//       console.log(
//         `Updated ${updateApps.modifiedCount} applications in Applications collection`
//       );

//       // 6️⃣ Deactivate old partner
//       const deactivatedPartner = await User.findByIdAndUpdate(
//         oldId,
//         { $set: { status: "SUSPENDED", updatedAt: new Date() } },
//         { new: true }
//       );
//       console.log(`Partner ${oldId} deactivated`);

//       // 7️⃣ Send email
//       try {
//         await sendMail({
//           to: deactivatedPartner.email,
//           subject: "Your Partner Account Has Been Deactivated",
//           html: `
//           <p>Dear ${deactivatedPartner.firstName} ${
//             deactivatedPartner.lastName
//           },</p>
//           <p>Your Partner account has been <b>deactivated</b>.</p>
//           ${
//             newId
//               ? `<p>All your customers (${customerIds.length}) have been reassigned to another Partner.</p>`
//               : `<p>All your customers (${customerIds.length}) are now UNASSIGNED.</p>`
//           }
//           <p>If you believe this is an error, contact support immediately.</p>
//         `,
//         });
//         console.log("Deactivation email sent");
//       } catch (err) {
//         console.error("Failed to send email:", err.message);
//       }

//       return res.json({
//         message: newId
//           ? `Successfully reassigned ${customerIds.length} customers and updated ${updateApps.modifiedCount} applications. Old partner deactivated.`
//           : `Old partner deactivated and ${customerIds.length} customers marked UNASSIGNED. Updated ${updateApps.modifiedCount} applications.`,
//         customersAffected: customerIds.length,
//         applicationsUpdated: updateApps.modifiedCount,
//         deactivatedPartner: {
//           id: deactivatedPartner._id,
//           name: `${deactivatedPartner.firstName} ${deactivatedPartner.lastName}`,
//           email: deactivatedPartner.email,
//         },
//       });
//     } catch (error) {
//       console.error("Error in /assign-customer-to-partner:", error);
//       res
//         .status(500)
//         .json({ message: "Internal server error", error: error.message });
//     }
//   }
// );

router.post(
  "/deactivate-partner",
  auth,
  requireRole(ROLES.ASM),
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

router.post("/rm/activate", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { rmId } = req.body;

    if (!rmId) {
      return res.status(400).json({ message: "rmId is required" });
    }

    // Activate RM and get updated document
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
          <p><b>Employee ID:</b> ${rm.employeeId}<br/>
             <b>RM Code:</b> ${rm.rmCode}<br/>
             <b>Email:</b> ${rm.email}</p>
          <p>You can now log in and continue managing your Partners and their Customers as usual.</p>
          <br/>
          <p>Regards,<br/>Trustline Fintech</p>
        `,
      });
      console.log("📧 RM activation mail sent to:", rm.email);
    } catch (mailErr) {
      console.error("❌ Failed to send RM activation email:", mailErr.message);
    }

    res.json({
      message: "RM activated successfully and notified via email",
      rm,
    });
  } catch (error) {
    console.error("Error in /rm/activate:", error);
    res.status(500).json({ message: error.message });
  }
});

router.post(
  "/partner/activate",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      const { partnerId } = req.body;

      if (!partnerId) {
        return res.status(400).json({ message: "partnerId is required" });
      }

      // Activate partner and get updated document
      const partner = await User.findOneAndUpdate(
        { _id: partnerId, role: ROLES.PARTNER },
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
            <p><b>Partner ID:</b> ${partner.partnerCode || "-"}<br/>
               <b>Email:</b> ${partner.email}</p>
            <p>You can now log in and continue managing your Customers as usual.</p>
            <br/>
            <p>Regards,<br/>Trustline Fintech</p>
          `,
        });
        console.log("📧 Partner activation mail sent to:", partner.email);
      } catch (mailErr) {
        console.error(
          "❌ Failed to send Partner activation email:",
          mailErr.message
        );
      }

      res.json({
        message: "Partner activated successfully and notified via email",
        partner,
      });
    } catch (error) {
      console.error("Error activating partner:", error);
      res.status(500).json({ message: error.message });
    }
  }
);

// GET /asm/top-performer-rm-list
router.get("/top-performer", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    const topRM = await Payout.aggregate([
      { $match: { asmId } },
      { $group: { _id: "$rmId", totalRevenue: { $sum: "$amount" } } },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 },
    ]);

    if (!topRM.length) {
      return res.json({ message: "No top performer yet" });
    }

    const rm = await User.findById(topRM[0]._id).select(
      "firstName lastName email rating"
    );
    res.json({
      id: rm._id,
      name: `${rm.firstName} ${rm.lastName}`,
      rating: rm.rating,
      revenue: topRM[0].totalRevenue,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching top performer" });
  }
});

// ================== ASSIGN TARGET TO  single RM ==================
// POST /target/assign-rm
router.post(
  "/target/assign-rm",
  auth,
  requireRole(ROLES.ASM), // only ASM can assign RM targets
  async (req, res) => {
    try {
      const { rmId, month, year, targetValue } = req.body;

      if (!rmId || !month || !year || !targetValue) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      if (month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month value" });
      }

      let target = await Target.findOne({
        assignedTo: rmId,
        assignedBy: req.user._id || req.user.id,
        month,
        year,
        role: ROLES.RM,
      });

      if (target) {
        target.targetValue = targetValue;
        await target.save();
        return res.json({ message: "Monthly target updated for RM", target });
      }

      target = await Target.create({
        assignedBy: req.user._id || req.user.id,
        assignedTo: rmId,
        role: ROLES.RM,
        month,
        year,
        targetValue,
      });

      res.status(201).json({
        message: "Monthly target assigned to RM successfully",
        target,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.post(
  "/target/assign-rm-bulk",
  auth,
  requireRole(ROLES.ASM), // Only ASM can do this
  async (req, res) => {
    try {
      let { month, year, totalTarget } = req.body;

      if (!month || !year || !totalTarget) {
        return res
          .status(400)
          .json({ message: "Month, year, and totalTarget are required" });
      }

      // Convert totalTarget and year to numbers
      totalTarget = Number(totalTarget);
      year = Number(year);

      // Map month names to numbers
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

      // Validate month number
      if (!month || month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month value" });
      }

      const asmId = req.user.sub; // logged-in ASM ID

      // Get all RMs under this ASM
      const rms = await User.find({
        role: ROLES.RM,
        asmId: asmId,
      }).lean();

      if (!rms.length) {
        return res.status(404).json({ message: "No RMs found under this ASM" });
      }

      const perRmTarget = Math.floor(totalTarget / rms.length);
      const bulkAssignments = [];

      for (let rm of rms) {
        let target = await Target.findOne({
          assignedTo: rm._id,
          month,
          year,
          role: ROLES.RM,
        });

        if (target) {
          target.targetValue = perRmTarget;
          target.assignedBy = asmId;
          await target.save();
          bulkAssignments.push(target);
        } else {
          const newTarget = await Target.create({
            assignedBy: asmId,
            assignedTo: rm._id,
            role: ROLES.RM,
            month,
            year,
            targetValue: perRmTarget,
          });
          bulkAssignments.push(newTarget);
        }
      }

      res.status(201).json({
        message: "Bulk target assigned successfully to all RMs under this ASM",
        totalTarget,
        perRmTarget,
        month,
        year,
        assignments: bulkAssignments,
      });
    } catch (err) {
      console.error("Assign RM bulk error:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// ================== GET RM TARGETS (yearly + previous year comparison) ==================
router.get(
  "/target/rm/:rmId/:year",
  auth,
  requireRole(ROLES.ASM), // ASM can check RM targets
  async (req, res) => {
    try {
      const { rmId, year } = req.params;
      const numericYear = Number(year);
      const prevYear = numericYear - 1;

      // fetch all RM targets of current year
      const currentTargets = await Target.find({
        assignedTo: rmId,
        year: numericYear,
        role: ROLES.RM,
      });

      // fetch all RM targets of previous year
      const previousTargets = await Target.find({
        assignedTo: rmId,
        year: prevYear,
        role: ROLES.RM,
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

      res.json({ rmId, year: numericYear, targets: result });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// ✅ Update RM data (ASM only)
// PATCH /rm/:rmId
router.post("/update/:rmId", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { rmId } = req.params;
    const { firstName, lastName, phone, email } = req.body;

    const rm = await User.findOneAndUpdate(
      { _id: rmId, role: ROLES.RM },
      { $set: { firstName, lastName, phone, email } },
      { new: true, runValidators: true, projection: "-passwordHash" }
    );

    if (!rm) return res.status(404).json({ message: "RM not found" });

    res.json({ message: "RM updated successfully", rm });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// ✅ Delete RM (ASM only)
// DELETE /rm/:rmId
router.delete(
  "/delete/:rmId",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      const { rmId } = req.params;

      // Check if RM exists
      const rm = await User.findOne({ _id: rmId, role: ROLES.RM });
      if (!rm) return res.status(404).json({ message: "RM not found" });

      // Optionally reassign partners under this RM before deleting
      await User.updateMany(
        { role: ROLES.PARTNER, rmId },
        { $unset: { rmId: "" } } // remove rmId link
      );

      // Delete the RM
      await User.findByIdAndDelete(rmId);

      res.json({ message: "RM deleted successfully" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  }
);

// GET /asm/profile
router.get("/profile", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub; // ASM id from token

    const asm = await User.findOne({ _id: asmId, role: ROLES.ASM })
      .select("-passwordHash")
      .lean();

    if (!asm) {
      return res.status(404).json({ message: "ASM not found" });
    }

    res.json({
      profile: {
        fullName: `${asm.firstName} ${asm.lastName}`,
        employeeId: asm.employeeId,
        email: asm.email,
        phone: asm.phone,
        dob: asm.dob,
        address: asm.address, // e.g., A-204, Sunrise Apartments...
        JoiningDate: asm.createdAt,
        userType: asm.role,
        verification: asm.status,
        referralCode: asm.asmCode,
        experience: asm.experience,
        region: asm.region,
        bankName: asm.bankName,
        accountNumber: asm.accountNumber,
        ifscCode: asm.ifscCode,
        accountHolderName: asm.accountHolderName,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// PATCH /asm/profile/update
router.patch(
  "/profile/update",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      const asmId = req.user.sub; // ASM id from token

      // pick only editable fields
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

      // remove undefined fields (so we don't overwrite with null accidentally)
      Object.keys(updateData).forEach(
        (key) => updateData[key] === undefined && delete updateData[key]
      );

      const updatedAsm = await User.findOneAndUpdate(
        { _id: asmId, role: ROLES.ASM },
        { $set: updateData },
        { new: true, runValidators: true, projection: "-passwordHash" }
      );

      if (!updatedAsm)
        return res.status(404).json({ message: "ASM not found" });

      res.json({
        message: "Profile updated successfully",
        profile: updatedAsm,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  }
);

// Universal analytics/dashboard API with user profile
router.get("/:id/analytics", auth, requireRole(ROLES.ASM), async (req, res) => {
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
  "/customers/:customerId/applications/:applicationId",
  auth,
  requireRole(ROLES.ASM), // ✅ Only ASM can access
  async (req, res) => {
    try {
      const asmId = req.user.sub; // ASM logged in
      const { customerId, applicationId } = req.params;

      // 1. Find all RMs under this ASM
      const rms = await User.find({ managerId: asmId, role: ROLES.RM }).select(
        "_id"
      );
      const rmIds = rms.map((rm) => rm._id);

      // 2. Find the full application belonging to this ASM's RMs + Customer
      const application = await Application.findOne({
        _id: applicationId,
        rmId: { $in: rmIds },
        customerId,
      })
        .populate("customerId", "firstName lastName email phone") // 👤 User-level info
        .populate("partnerId", "firstName lastName email phone") // 👔 Partner info
        .populate("rmId", "firstName lastName email phone") // 🧑‍💼 RM info
        .populate("docs.uploadedBy", "firstName lastName email") // 📄 Who uploaded documents
        .lean();

      if (!application) {
        return res.status(404).json({
          message: "Application not found or not assigned under this ASM",
        });
      }

      return res.json(application);
    } catch (err) {
      console.error("Error fetching full application details (ASM):", err);
      return res
        .status(500)
        .json({ message: "Error fetching application details" });
    }
  }
);

router.get(
  "/applications/:id/docs/:docType/download",
  auth,
  requireRole(ROLES.ASM), // ✅ Only ASM allowed
  async (req, res) => {
    try {
      const asmId = req.user.sub;
      const { id, docType } = req.params;

      // 1. Find all RMs under this ASM
      const rms = await User.find({ managerId: asmId, role: ROLES.RM }).select(
        "_id"
      );
      const rmIds = rms.map((rm) => rm._id);

      // 2. Check if application belongs to one of those RMs
      const app = await Application.findOne({
        _id: id,
        rmId: { $in: rmIds },
      }).lean();

      if (!app) {
        return res.status(404).json({
          message: "Application not found or not assigned under this ASM",
        });
      }

      // 3. Find document
      const doc = app.docs.find(
        (d) => d.docType.toUpperCase() === docType.toUpperCase()
      );
      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }

      // 4. Resolve file path
      const filePath = path.resolve(process.cwd(), doc.url);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "File not found" });
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return res.status(404).json({ message: "Path is not a file" });
      }

      // 5. Detect MIME type
      const fileExtension = path.extname(filePath);
      const filename = `${docType}${fileExtension}`;
      const contentType =
        mime.lookup(fileExtension) || "application/octet-stream";

      // 6. Set headers for download
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

      // 7. Stream file
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      fileStream.on("error", (err) => {
        console.error("File stream error:", err);
        if (!res.headersSent) {
          res.status(500).json({ message: "Error reading file" });
        }
      });
    } catch (err) {
      console.error("Download error (ASM):", err);
      if (!res.headersSent) {
        res.status(500).json({ message: "Error downloading document" });
      }
    }
  }
);

router.get(
  "/applications/:id/docs/download-all",
  auth,
  requireRole(ROLES.ASM), // ✅ Only ASM
  async (req, res) => {
    try {
      const { id } = req.params;
      const asmId = req.user.sub;

      // 1. Find all RMs under this ASM
      const rms = await User.find({ managerId: asmId, role: ROLES.RM }).select(
        "_id"
      );
      const rmIds = rms.map((rm) => rm._id);

      // 2. Find application under those RMs
      const app = await Application.findOne({
        _id: id,
        rmId: { $in: rmIds },
      }).lean();

      if (!app) {
        return res
          .status(404)
          .json({ message: "Application not found under this ASM" });
      }

      if (!app.docs || app.docs.length === 0) {
        return res
          .status(404)
          .json({ message: "No documents found for this application" });
      }

      // 3. Create ZIP filename based on application
      const zipFilename = `${app.appNo || `APP-${id.slice(-6)}`}_Documents.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${zipFilename}"`
      );
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

      // 4. Create archive
      const archive = archiver("zip", { zlib: { level: 9 } });

      archive.on("error", (err) => {
        console.error("Archive error:", err);
        if (!res.headersSent) {
          res.status(500).json({ message: "Error creating archive" });
        }
      });

      archive.pipe(res);

      let filesAdded = 0;
      const errors = [];

      // 5. Process docs
      for (let i = 0; i < app.docs.length; i++) {
        const doc = app.docs[i];
        try {
          const filePath = path.resolve(process.cwd(), doc.url);

          if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
              const fileExtension = path.extname(doc.url);
              const cleanFilename = `${doc.docType}${fileExtension}`;
              archive.file(filePath, { name: cleanFilename });
              filesAdded++;
            } else {
              errors.push(`${doc.docType}: Path exists but not a file`);
            }
          } else {
            errors.push(`${doc.docType}: File not found at ${doc.url}`);
          }
        } catch (error) {
          errors.push(`${doc.docType}: ${error.message}`);
        }
      }

      if (filesAdded === 0) {
        archive.destroy();
        return res.status(404).json({
          message: "No valid documents found to download",
          errors,
          totalDocs: app.docs.length,
        });
      }

      // 6. Add summary file if errors exist
      if (errors.length > 0) {
        const summaryContent = [
          `Download Summary for Application: ${app.appNo}`,
          `Generated: ${new Date().toLocaleString()}`,
          "",
          `Total Documents: ${app.docs.length}`,
          `Successfully Downloaded: ${filesAdded}`,
          `Failed Downloads: ${errors.length}`,
          "",
          "Failed Downloads:",
          ...errors.map((error, idx) => `${idx + 1}. ${error}`),
          "",
          "Note: Only successfully found documents are included in this ZIP file.",
        ].join("\n");

        archive.append(summaryContent, { name: "DOWNLOAD_SUMMARY.txt" });
      }

      await archive.finalize();
    } catch (err) {
      console.error("Download all docs error (ASM):", err);
      if (!res.headersSent) {
        res.status(500).json({ message: "Error creating document archive" });
      }
    }
  }
);

export default router;
