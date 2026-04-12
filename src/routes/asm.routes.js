import { Router } from "express";
import argon2 from "argon2";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES, RSM_TYPES } from "../config/roles.js";
import { User } from "../models/User.js";
import { makeRmCode } from "../utils/codes.js";
import { Payout } from "../models/Payout.js";
import { generateEmployeeId } from "../utils/generateEmployeeId.js";
import { Target } from "../models/Target.js";
import { Incentive } from "../models/Incentive.js";
import mongoose from "mongoose";
import { Application } from "../models/Application.js";
import { sendMail } from "../utils/sendMail.js";
import { sendUserAccountEmail } from "../utils/emailService.js";
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
import { emitTargetUpdatedForDoc, emitTargetUpdatesForDocs } from "../utils/targetSocketEmitter.js";

const router = Router();

// NOTE: ASM can NO LONGER create RM directly.
// ASM should create RSM, and RSM will create RM.
// This route has been removed to enforce the hierarchy: ADMIN → ASM → RSM → RM

// Create RSM (ASM only) - moved from /api/rsm/create-rsm
router.post(
  "/create-rsm",
  auth,
  requireRole(ROLES.ASM),
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
        rsmType,
      } = req.body || {};
      const asmId = req.user.sub;

      if (!firstName || !lastName || !email || !phone || !rsmType) {
        return res.status(400).json({
          message:
            "firstName, lastName, email, phone and rsmType are required",
        });
      }

      if (!Object.values(RSM_TYPES).includes(rsmType)) {
        return res.status(400).json({
          message: `Invalid rsmType. Allowed: ${Object.values(RSM_TYPES).join(
            ", "
          )}`,
        });
      }

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
        region,
        asmId,
        rsmType,
      });

      // Send credentials email
      try {
        const asmUser = await User.findById(asmId);
        const emailSent = await sendUserAccountEmail(
          rsm,
          "RSM",
          password ? null : rawPassword,
          asmUser
            ? { firstName: asmUser.firstName, lastName: asmUser.lastName }
            : null
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

      return res.status(201).json({
        message: "RSM created successfully",
        id: rsm._id,
        employeeId: rsm.employeeId,
        rsmType: rsm.rsmType,
        asmId: rsm.asmId,
        tempPassword: password ? undefined : rawPassword,
      });
    } catch (err) {
      console.error("Create RSM Error (ASM):", err);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  }
);

// GET /api/asm/get-rsms
// ASM gets all RSMs under them
router.get("/get-rsms", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    const rsms = await User.find({ asmId, role: ROLES.RSM })
      .select("-passwordHash -__v")
      .lean();

    const formatted = rsms.map((rsm) => ({
      ...rsm,
      asmId: rsm.asmId || null,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching RSMs:", err);
    res.status(500).json({ message: "Error fetching RSMs" });
  }
});

router.get("/get-rm", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    // Get RSMs under this ASM first
    const rsms = await User.find({ role: ROLES.RSM, asmId }).select("_id").lean();
    const rsmIds = rsms.map(r => r._id);

    // Get RMs that are under these RSMs (via personalRsmId OR businessHomeRsmId)
    const list = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    })
      .select("-passwordHash -__v")
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
        asmId: asm ? asm._id : null,
        asmName: asm ? `${asm.firstName} ${asm.lastName}` : null,
        asmEmployeeId: asm ? asm.employeeId : null,
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
    console.error("Error fetching RMs:", err);
    res.status(500).json({ message: "Error fetching RMs" });
  }
});

// Get partners (ASM)
router.get("/get-partners", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub; // ✅ logged-in ASM ID

    // Fetch only partners whose RM belongs to this ASM
    const list = await User.find({
      role: ROLES.PARTNER,
      status: { $ne: "PENDING" },
    })
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
    const asmId = req.user.sub;

    // Build hierarchy: ASM → RSMs → RMs → Partners
    const rsms = await User.find({ asmId, role: ROLES.RSM }).select("_id").lean();
    const rsmIds = rsms.map((r) => r._id);
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } },
      ],
    }).select("_id").lean();
    const rmIds = rms.map((r) => r._id);
    const partnersList = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).select("_id firstName lastName employeeId").lean();
    const partnerIds = partnersList.map((p) => p._id);

    const applications = await Application.find({
      $or: [
        { asmId },
        { rsmId: { $in: rsmIds } },
        { rmId: { $in: rmIds } },
        { partnerId: { $in: partnerIds } },
      ],
    })
      .populate("customerId", "employeeId _id firstName lastName email phone")
      .populate("partnerId", "firstName lastName employeeId")
      .populate("rmId", "firstName lastName employeeId")
      .select("appNo loanType approvedLoanAmount status createdAt customer")
      .sort({ createdAt: -1 })
      .lean();

    // Attach payout info
    const appIds = applications.map((a) => a._id);
    const payouts = await Payout.find({ application: { $in: appIds } })
      .select("application amount payOutStatus")
      .lean();
    const payoutMap = {};
    payouts.forEach((p) => {
      payoutMap[p.application.toString()] = p;
    });

    const formatted = applications.map((app) => {
      const customer = app.customerId || {};
      const partner = app.partnerId || {};
      const rm = app.rmId || {};
      const payout = payoutMap[app._id.toString()];

      return {
        appNo: app.appNo,
        loanType: app.loanType,
        loanAmount: app.loanAmount || 0,
        disburseAmount: app.approvedLoanAmount || 0,
        status: app.status,
        applicationDate: app.createdAt,
        payOutStatus: payout?.payOutStatus || "PENDING",
        payoutAmount: payout?.amount || 0,
        customerId: customer._id || null,
        userName: customer.firstName
          ? `${customer.firstName} ${customer.lastName}`
          : null,
        employeeId: customer.employeeId || null,
        email: customer.email || null,
        phone: customer.phone || null,
        partnerName: partner.firstName
          ? `${partner.firstName} ${partner.lastName}`
          : null,
        partnerEmployeeId: partner.employeeId || null,
        rmName: rm.firstName ? `${rm.firstName} ${rm.lastName}` : null,
        rmEmployeeId: rm.employeeId || null,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching ASM customers:", err);
    res.status(500).json({ message: "Error fetching ASM customers" });
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

      const partners = await User.find({
        role: ROLES.PARTNER,
        rmId,
        status: { $ne: "PENDING" },
      })
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

// GET /api/asm/get-all-partners
// ASM gets all partners under their hierarchy
router.get(
  "/get-all-partners",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      const asmId = req.user.sub;

      // Get all RSMs under this ASM
      const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
      const rsmIds = rsms.map((rsm) => rsm._id);

      // Get all RMs under these RSMs
      const rms = await User.find({
        role: ROLES.RM,
        $or: [
          { personalRsmId: { $in: rsmIds } },
          { businessHomeRsmId: { $in: rsmIds } }
        ]
      }).lean();
      const rmIds = rms.map((rm) => rm._id);

      // Get all partners under these RMs
      const partners = await User.find({
        role: ROLES.PARTNER,
        rmId: { $in: rmIds },
        status: { $ne: "PENDING" },
      })
        .select("-passwordHash -__v")
        .populate({
          path: "rmId",
          select: "firstName lastName employeeId",
        })
        .lean();

      const formatted = partners.map((partner) => {
        const rm = partner.rmId;
        return {
          ...partner,
          rmId: rm ? rm._id : null,
          rmName: rm ? `${rm.firstName} ${rm.lastName}` : null,
          rmEmployeeId: rm ? rm.employeeId : null,
        };
      });

      res.json(formatted);
    } catch (err) {
      console.error("Error fetching all partners under ASM:", err);
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
      const asmId = req.user.sub;

      // Build hierarchy: ASM → RSMs → RMs → Partners
      const _rsms = await User.find({ asmId, role: ROLES.RSM }).select("_id").lean();
      const _rsmIds = _rsms.map((r) => r._id);
      const _rms = await User.find({
        role: ROLES.RM,
        $or: [
          { personalRsmId: { $in: _rsmIds } },
          { businessHomeRsmId: { $in: _rsmIds } },
        ],
      }).select("_id").lean();
      const _rmIds = _rms.map((r) => r._id);
      const _partners = await User.find({
        rmId: { $in: _rmIds },
        role: ROLES.PARTNER,
      }).select("_id").lean();
      const _partnerIds = _partners.map((p) => p._id);

      const applications = await Application.find({
        $or: [
          { asmId },
          { rsmId: { $in: _rsmIds } },
          { rmId: { $in: _rmIds } },
          { partnerId: { $in: _partnerIds } },
        ],
      })
        .populate("customerId", "employeeId firstName lastName email phone")
        .populate("partnerId", "firstName lastName employeeId")
        .select("appNo loanType approvedLoanAmount status createdAt customer")
        .sort({ createdAt: -1 })
        .lean();

      // Attach payout info (status + amount only)
      const _appIds = applications.map((a) => a._id);
      const _payouts = await Payout.find({ application: { $in: _appIds } })
        .select("application amount payOutStatus")
        .lean();
      const _payoutMap = {};
      _payouts.forEach((p) => {
        _payoutMap[p.application.toString()] = p;
      });

      const formatted = applications.map((app) => {
        const customer = app.customer || {};
        const customerUser = app.customerId || {};
        const payout = _payoutMap[app._id.toString()];

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
          payOutStatus: payout?.payOutStatus || "PENDING",
          payoutAmount: payout?.amount || 0,
          actionId: app._id,
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

    // ✅ NEW HIERARCHY: ASM → RSM → RM → Partner
    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);

    // Get all RMs under these RSMs (via personalRsmId OR businessHomeRsmId)
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // All partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).lean();
    const partnerIds = partners.map((p) => p._id);

    // Totals
    const totalRSMs = rsms.length;
    const totalRMs = rms.length;
    const totalPartners = partners.length;
    const activePartners = await User.countDocuments({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
      status: "ACTIVE",
    });

    const customers = await Application.distinct("customerId", {
      $or: [
        { rsmId: { $in: rsmIds } },
        { rmId: { $in: rmIds } }
      ]
    });
    const totalCustomers = customers.length;

    // In-process applications (under review by RSM)
    const inProcessApplications = await Application.countDocuments({
      rsmId: { $in: rsmIds },
      status: { $in: ["UNDER_REVIEW", "APPROVED", "AGREEMENT"] },
    });

    // Revenue from disbursed loans (via RSM or RM)
    const revenueAgg = await Application.aggregate([
      {
        $match: {
          $or: [
            { rsmId: { $in: rsmIds.map((id) => new mongoose.Types.ObjectId(id)) } },
            { rmId: { $in: rmIds.map((id) => new mongoose.Types.ObjectId(id)) } }
          ],
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

    // Current Month Target (ASM's hierarchical target)
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // Get ASM's current month target (hierarchical - sum of RSM targets)
    const asmTarget = await Target.findOne({
      assignedTo: new mongoose.Types.ObjectId(asmId),
      role: ROLES.ASM,
      month: currentMonth,
      year: currentYear,
    }).lean();

    // Calculate current month achievements (disbursed applications)
    const currentMonthStart = new Date(currentYear, currentMonth - 1, 1);
    const currentMonthEnd = new Date(currentYear, currentMonth, 1);

    const currentMonthDisbursed = await Application.aggregate([
      {
        $match: {
          $or: [
            { rsmId: { $in: rsmIds.map((id) => new mongoose.Types.ObjectId(id)) } },
            { rmId: { $in: rmIds.map((id) => new mongoose.Types.ObjectId(id)) } }
          ],
          status: "DISBURSED",
          updatedAt: {
            $gte: currentMonthStart,
            $lt: currentMonthEnd,
          },
        },
      },
      {
        $group: {
          _id: null,
          totalDisbursement: { $sum: { $toDouble: "$approvedLoanAmount" } },
          totalFiles: { $sum: 1 },
        },
      },
    ]);

    const currentMonthAchievedDisbursement = currentMonthDisbursed[0]?.totalDisbursement || 0;
    const currentMonthAchievedFileCount = currentMonthDisbursed[0]?.totalFiles || 0;

    // 12-Month Target (ASM's hierarchical targets)
    const startOfYear = new Date(currentYear, 0, 1);

    const monthlyTarget = await Target.find({
      assignedTo: new mongoose.Types.ObjectId(asmId),
      role: ROLES.ASM,
      year: currentYear,
    }).lean();

    // 12-Month Achieved (via RSMs → RMs → Partners)
    const monthlyAchieved = await Application.aggregate([
      {
        $match: {
          $or: [
            { rsmId: { $in: rsmIds.map((id) => new mongoose.Types.ObjectId(id)) } },
            { rmId: { $in: rmIds.map((id) => new mongoose.Types.ObjectId(id)) } }
          ],
          status: { $ne: "DRAFT" },
          updatedAt: { $gte: startOfYear },
        },
      },
      {
        $group: {
          _id: { month: { $month: "$updatedAt" } },
          totalAchieved: {
            $sum: {
              $cond: [{ $eq: ["$status", "DISBURSED"] }, { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } }, 0]
            }
          },
          totalFiles: { $sum: 1 },
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
      const targetDoc = monthlyTarget.find((t) => t.month === month);
      const t = targetDoc?.disbursementTarget || 0;
      const a =
        monthlyAchieved.find((m) => m._id.month === month)?.totalAchieved || 0;
      return {
        month: monthNames[i],
        target: t,
        achieved: a,
        fileCountTarget: targetDoc?.fileCountTarget || 0,
        achievedFileCount: monthlyAchieved.find((m) => m._id.month === month)?.totalFiles || 0,
      };
    });

    // Top Performers - RSMs (under this ASM)
    const topRSMs = await Application.aggregate([
      {
        $match: {
          rsmId: { $in: rsmIds.map((id) => new mongoose.Types.ObjectId(id)) },
          status: "DISBURSED",
        },
      },
      {
        $group: {
          _id: "$rsmId",
          totalRevenue: { $sum: { $ifNull: ["$approvedLoanAmount", 0] } },
          totalDisbursedApps: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 },
    ]);

    const topRSMPerformers = await Promise.all(
      topRSMs.map(async (tr) => {
        const rsm = await User.findById(tr._id).select(
          "firstName lastName email rsmType"
        );
        return {
          id: rsm._id,
          name: `${rsm.firstName} ${rsm.lastName}`,
          email: rsm.email,
          rsmType: rsm.rsmType,
          totalRevenue: tr.totalRevenue,
          totalDisbursedApps: tr.totalDisbursedApps,
        };
      })
    );

    // Top Performers - RMs (under RSMs)
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

    const topRMPerformers = await Promise.all(
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
        totalRSMs,
        totalRMs,
        totalPartners,
        activePartners,
        totalCustomers,
        totalRevenue,
        avgRating,
        inProcessApplications,
      },
      // Current month target and achievement
      currentMonthTarget: {
        fileCountTarget: asmTarget?.fileCountTarget || 0,
        disbursementTarget: asmTarget?.disbursementTarget || 0,
        achievedFileCount: currentMonthAchievedFileCount,
        achievedDisbursement: currentMonthAchievedDisbursement,
        fileTargetMet: currentMonthAchievedFileCount >= (asmTarget?.fileCountTarget || 0),
        disbursementTargetMet: currentMonthAchievedDisbursement >= (asmTarget?.disbursementTarget || 0),
        targetAchieved: currentMonthAchievedFileCount >= (asmTarget?.fileCountTarget || 0) &&
          currentMonthAchievedDisbursement >= (asmTarget?.disbursementTarget || 0),
      },
      targets, // 12-month breakdown
      topRSMPerformers,
      topRMPerformers,
    });
  } catch (error) {
    console.error("Error in ASM dashboard:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/asm/rsm/:rsmId/analytics
// ASM views analytics for a specific RSM
router.get("/rsm/:rsmId/analytics", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;
    const { rsmId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(rsmId)) {
      return res.status(400).json({ message: "Invalid RSM ID" });
    }

    // Verify RSM exists and belongs to this ASM
    // Check both direct asmId match and also verify through relationship
    const rsm = await User.findOne({
      _id: rsmId,
      role: ROLES.RSM
    }).lean();

    if (!rsm) {
      return res.status(404).json({ message: "RSM not found" });
    }

    // Verify RSM belongs to this ASM (check asmId field)
    // If asmId is not set, set it now for future queries (backward compatibility)
    if (!rsm.asmId) {
      // RSM doesn't have asmId set, update it now
      await User.updateOne({ _id: rsmId }, { asmId: asmId });
      rsm.asmId = asmId;
    } else if (rsm.asmId.toString() !== asmId.toString()) {
      // RSM has asmId but it doesn't match - deny access
      return res.status(403).json({
        message: "Access denied. RSM does not belong to this ASM."
      });
    }

    // Get all RMs under this RSM
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: rsmId },
        { businessHomeRsmId: rsmId }
      ]
    }).select("_id").lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).select("_id").lean();
    const partnerIds = partners.map((p) => p._id);

    // Applications assigned to this RSM or its RMs/Partners
    const totalApplications = await Application.countDocuments({
      $or: [
        { rsmId: rsmId },
        { rmId: { $in: rmIds } },
        { partnerId: { $in: partnerIds } }
      ]
    });

    const disbursedApplications = await Application.countDocuments({
      $or: [
        { rsmId: rsmId, status: "DISBURSED" },
        { rmId: { $in: rmIds }, status: "DISBURSED" },
        { partnerId: { $in: partnerIds }, status: "DISBURSED" }
      ]
    });

    const inProcessApplications = await Application.countDocuments({
      $or: [
        { rsmId: rsmId, status: { $in: ["UNDER_REVIEW", "APPROVED", "AGREEMENT"] } },
        { rmId: { $in: rmIds }, status: { $in: ["UNDER_REVIEW", "APPROVED", "AGREEMENT"] } },
        { partnerId: { $in: partnerIds }, status: { $in: ["UNDER_REVIEW", "APPROVED", "AGREEMENT"] } }
      ]
    });

    // Revenue from disbursed loans (from RSM, RMs, and Partners)
    const revenueAgg = await Application.aggregate([
      {
        $match: {
          $or: [
            { rsmId: new mongoose.Types.ObjectId(rsmId) },
            { rmId: { $in: rmIds.map(id => new mongoose.Types.ObjectId(id)) } },
            { partnerId: { $in: partnerIds.map(id => new mongoose.Types.ObjectId(id)) } }
          ],
          status: "DISBURSED",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } } },
        },
      },
    ]);
    const totalRevenue = revenueAgg.length > 0 ? Number(revenueAgg[0].total) : 0;

    // Get current month target and achievement
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const targetDoc = await Target.findOne({
      assignedTo: rsmId,
      role: ROLES.RSM,
      month: currentMonth,
      year: currentYear,
    }).lean();

    // Get target value - prefer disbursementTarget, fallback to targetValue
    const targetValue = targetDoc ? Number(targetDoc.disbursementTarget || targetDoc.targetValue || 0) : 0;

    // Calculate achieved value for current month
    const currentMonthAchievedAgg = await Application.aggregate([
      {
        $match: {
          $or: [
            { rsmId: new mongoose.Types.ObjectId(rsmId) },
            { rmId: { $in: rmIds.map(id => new mongoose.Types.ObjectId(id)) } },
            { partnerId: { $in: partnerIds.map(id => new mongoose.Types.ObjectId(id)) } }
          ],
          status: "DISBURSED",
          $expr: {
            $and: [
              { $eq: [{ $month: { $ifNull: ["$disbursedDate", "$createdAt"] } }, currentMonth] },
              { $eq: [{ $year: { $ifNull: ["$disbursedDate", "$createdAt"] } }, currentYear] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } } },
        },
      },
    ]);
    const achievedValue = currentMonthAchievedAgg.length > 0 ? Number(currentMonthAchievedAgg[0].total) : 0;

    // Monthly performance
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const monthlyAchieved = await Application.aggregate([
      {
        $match: {
          $or: [
            { rsmId: new mongoose.Types.ObjectId(rsmId) },
            { rmId: { $in: rmIds.map(id => new mongoose.Types.ObjectId(id)) } },
            { partnerId: { $in: partnerIds.map(id => new mongoose.Types.ObjectId(id)) } }
          ],
          status: "DISBURSED",
          createdAt: { $gte: startOfYear },
        },
      },
      {
        $group: {
          _id: { month: { $month: "$createdAt" } },
          totalAchieved: { $sum: { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } } },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.month": 1 } },
    ]);

    // Get customer count
    const customers = await Application.distinct("customerId", {
      $or: [
        { rsmId: new mongoose.Types.ObjectId(rsmId) },
        { rmId: { $in: rmIds.map(id => new mongoose.Types.ObjectId(id)) } },
        { partnerId: { $in: partnerIds.map(id => new mongoose.Types.ObjectId(id)) } }
      ]
    });

    res.json({
      profile: {
        userId: rsm._id,
        name: `${rsm.firstName} ${rsm.lastName}`,
        email: rsm.email,
        phone: rsm.phone || "N/A",
        employeeId: rsm.employeeId || "N/A",
        status: rsm.status || "ACTIVE",
      },
      analytics: {
        scope: ROLES.RSM,
        totals: {
          rms: rmIds.length,
          totalRMs: rmIds.length,
          partners: partnerIds.length,
          totalPartners: partnerIds.length,
          totalApplications,
          disbursedApplications,
          inProcessApplications,
          customers: customers.length,
        },
        assignedTarget: {
          month: now.toLocaleString('default', { month: 'long' }),
          year: currentYear,
          targetValue,
          achievedValue,
        },
        totalDisbursed: totalRevenue, // Overall total disbursed
        performance: targetValue > 0 ? `${((totalRevenue / targetValue) * 100).toFixed(2)}%` : "0.00%",
        monthlyPerformance: monthlyAchieved,
      },
    });
  } catch (error) {
    console.error("Error fetching RSM analytics:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/asm/rsm/:rsmId/follow-up
// ASM takes follow-up from RSM
router.post("/rsm/:rsmId/follow-up", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;
    const { rsmId } = req.params;
    const { status, remarks } = req.body;

    // Verify RSM belongs to this ASM
    const rsm = await User.findOne({ _id: rsmId, asmId, role: ROLES.RSM });
    if (!rsm) {
      return res.status(404).json({ message: "RSM not found or not under this ASM" });
    }

    if (!status || !["Connected", "Ringing", "Switch Off", "Not Reachable"].includes(status)) {
      return res.status(400).json({ message: "Valid status is required" });
    }

    const FollowUp = (await import("../models/followUp.js")).FollowUp;
    const followUp = new FollowUp({
      targetId: rsmId,
      followUpType: "RSM",
      status,
      remarks: remarks || "",
      lastCall: new Date(),
      updatedBy: asmId,
    });

    await followUp.save();

    res.json({
      message: "Follow-up recorded successfully",
      followUp: {
        ...followUp.toObject(),
        lastCall: followUp.lastCall.toISOString(),
      },
    });
  } catch (error) {
    console.error("Error recording RSM follow-up:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/asm/rsms/follow-ups
// ASM gets all RSM follow-ups
router.get("/rsms/follow-ups", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);

    const FollowUp = (await import("../models/followUp.js")).FollowUp;

    // Get latest follow-up for each RSM
    const followUps = await FollowUp.find({
      targetId: { $in: rsmIds },
      followUpType: "RSM",
    })
      .sort({ lastCall: -1 })
      .populate("targetId", "firstName lastName employeeId email phone")
      .populate("updatedBy", "firstName lastName employeeId")
      .lean();

    // Group by RSM and get latest
    const rsmFollowUpsMap = {};
    followUps.forEach((fu) => {
      const rsmId = fu.targetId._id.toString();
      if (!rsmFollowUpsMap[rsmId] || new Date(fu.lastCall) > new Date(rsmFollowUpsMap[rsmId].lastCall)) {
        rsmFollowUpsMap[rsmId] = fu;
      }
    });

    // Format response
    const formatted = rsms.map((rsm) => {
      const followUp = rsmFollowUpsMap[rsm._id.toString()];
      return {
        rsm: {
          id: rsm._id,
          name: `${rsm.firstName} ${rsm.lastName}`,
          email: rsm.email,
          phone: rsm.phone,
          employeeId: rsm.employeeId,
          rsmType: rsm.rsmType,
        },
        followUp: followUp
          ? {
            status: followUp.status,
            remarks: followUp.remarks,
            lastCall: followUp.lastCall,
            updatedBy: followUp.updatedBy
              ? {
                name: `${followUp.updatedBy.firstName} ${followUp.updatedBy.lastName}`,
                employeeId: followUp.updatedBy.employeeId,
              }
              : null,
          }
          : null,
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error("Error fetching RSM follow-ups:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ==================== PAYOUT MANAGEMENT (ASM) ====================

// GET /api/asm/disbursed-applications
// ASM gets all disbursed applications for payout management
router.get("/disbursed-applications", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);

    // Get all RMs under these RSMs
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get all partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).lean();
    const partnerIds = partners.map((p) => p._id);

    // Get all disbursed applications
    const applications = await Application.find({
      status: "DISBURSED",
      $or: [
        { rsmId: { $in: rsmIds } },
        { rmId: { $in: rmIds } },
        { partnerId: { $in: partnerIds } }
      ]
    })
      .populate("customerId", "firstName lastName email phone employeeId")
      .populate("partnerId", "firstName lastName email phone employeeId")
      .populate("rmId", "firstName lastName employeeId")
      .populate("rsmId", "firstName lastName employeeId")
      .select("appNo loanType approvedLoanAmount status createdAt customer")
      .sort({ createdAt: -1 })
      .lean();

    // Get payouts for these applications
    const appIds = applications.map((app) => app._id);
    const payouts = await Payout.find({ application: { $in: appIds } })
      .populate("partnerId", "firstName lastName email")
      .lean();

    // Map payouts by application
    const payoutMap = {};
    payouts.forEach((p) => {
      const appId = p.application.toString();
      if (!payoutMap[appId]) {
        payoutMap[appId] = [];
      }
      payoutMap[appId].push(p);
    });

    // Format response
    const formatted = applications.map((app) => {
      const customer = app.customer || {};
      return {
        _id: app._id,
        appNo: app.appNo,
        customerName: app.customerId
          ? `${app.customerId.firstName || ""} ${app.customerId.lastName || ""}`.trim()
          : "N/A",
        customerId: app.customerId?.employeeId || app.customerId?._id || "N/A",
        partnerName: app.partnerId
          ? `${app.partnerId.firstName || ""} ${app.partnerId.lastName || ""}`.trim()
          : null,
        partnerId: app.partnerId?._id || null,
        partnerEmployeeId: app.partnerId?.employeeId || null,
        rmName: app.rmId
          ? `${app.rmId.firstName || ""} ${app.rmId.lastName || ""}`.trim()
          : "N/A",
        rsmName: app.rsmId
          ? `${app.rsmId.firstName || ""} ${app.rsmId.lastName || ""}`.trim()
          : null,
        loanType: app.loanType || "-",
        loanAmount: customer.loanAmount || app.requestedAmount || 0,
        approvedLoanAmount: app.approvedLoanAmount || 0,
        disbursedDate: app.updatedAt || app.createdAt,
        payouts: payoutMap[app._id.toString()] || [],
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error("Error fetching disbursed applications:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/asm/payouts
// ASM gets all payouts (pending and done)
router.get("/payouts", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;
    const { status } = req.query; // PENDING or DONE

    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);

    // Get all RMs under these RSMs
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get all partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).lean();
    const partnerIds = partners.map((p) => p._id);

    // Build filter
    const filter = { partnerId: { $in: partnerIds } };
    if (status && ["PENDING", "DONE"].includes(status)) {
      filter.payOutStatus = status;
    }

    // Get payouts
    const payouts = await Payout.find(filter)
      .populate("application", "appNo loanType approvedLoanAmount status customer")
      .populate("partnerId", "firstName lastName email phone employeeId")
      .populate("addedBy", "firstName lastName employeeId")
      .sort({ createdAt: -1 })
      .lean();

    // Format response
    const formatted = payouts.map((payout) => {
      const app = payout.application || {};
      const customer = app.customer || {};
      return {
        _id: payout._id,
        applicationId: payout.application?._id || null,
        appNo: app.appNo || "N/A",
        customerName: customer.firstName && customer.lastName
          ? `${customer.firstName} ${customer.lastName}`
          : "N/A",
        partnerName: payout.partnerId
          ? `${payout.partnerId.firstName || ""} ${payout.partnerId.lastName || ""}`.trim()
          : "N/A",
        partnerId: payout.partnerId?._id || null,
        partnerEmployeeId: payout.partnerId?.employeeId || null,
        loanType: app.loanType || "-",
        approvedLoanAmount: app.approvedLoanAmount || 0,
        payoutAmount: payout.amount || 0,
        payoutPercentage: app.approvedLoanAmount
          ? ((payout.amount / app.approvedLoanAmount) * 100).toFixed(2)
          : "0",
        payOutStatus: payout.payOutStatus || "PENDING",
        note: payout.note || "",
        addedBy: payout.addedBy
          ? `${payout.addedBy.firstName || ""} ${payout.addedBy.lastName || ""}`.trim()
          : "N/A",
        createdAt: payout.createdAt,
        updatedAt: payout.updatedAt,
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error("Error fetching payouts:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/asm/payouts/approve
// ASM approves a payout (changes status from PENDING to DONE)
router.post("/payouts/approve", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { payoutId } = req.body;

    if (!payoutId) {
      return res.status(400).json({ message: "payoutId is required" });
    }

    const payout = await Payout.findById(payoutId);
    if (!payout) {
      return res.status(404).json({ message: "Payout not found" });
    }

    // Verify payout belongs to ASM's hierarchy
    const asmId = req.user.sub;
    const partners = await User.find({ role: ROLES.PARTNER }).lean();
    const partnerIds = partners.map((p) => p._id);

    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);
    const asmPartners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).lean();
    const asmPartnerIds = asmPartners.map((p) => p._id);

    if (!asmPartnerIds.includes(payout.partnerId.toString())) {
      return res.status(403).json({ message: "Payout does not belong to your hierarchy" });
    }

    payout.payOutStatus = "DONE";
    await payout.save();

    res.json({
      message: "Payout approved successfully",
      payout,
    });
  } catch (error) {
    console.error("Error approving payout:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/asm/payouts/create
// ASM creates or updates a payout for a disbursed application
router.post("/payouts/create", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { applicationId, partnerId, payoutPercentage, note } = req.body;

    if (!applicationId || !partnerId) {
      return res.status(400).json({ message: "applicationId and partnerId are required" });
    }

    const asmId = req.user.sub;

    // Verify application belongs to ASM's hierarchy
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).lean();
    const partnerIds = partners.map((p) => p._id);

    const application = await Application.findOne({
      _id: applicationId,
      status: "DISBURSED",
      $or: [
        { rsmId: { $in: rsmIds } },
        { rmId: { $in: rmIds } },
        { partnerId: { $in: partnerIds } }
      ]
    }).select("approvedLoanAmount partnerId");

    if (!application) {
      return res.status(404).json({ message: "Application not found or not disbursed" });
    }

    if (!partnerIds.includes(partnerId)) {
      return res.status(403).json({ message: "Partner does not belong to your hierarchy" });
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
      // Update existing payout
      payout.amount = payoutAmount || payout.amount;
      payout.note = note || payout.note;
      await payout.save();
    } else {
      // Create new payout
      payout = await Payout.create({
        application: applicationId,
        partnerId,
        amount: payoutAmount,
        note,
        payOutStatus: "PENDING",
        addedBy: asmId,
      });
    }

    res.json({
      message: "Payout created/updated successfully",
      payout,
    });
  } catch (error) {
    console.error("Error creating payout:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ==================== PAYOUT MANAGEMENT - PENDING/DONE (ASM) ====================

// GET /api/asm/customers/pending-payouts
// ASM gets pending payout customers (disbursed loans without DONE payout)
router.get("/customers/pending-payouts", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);

    // Get all RMs under these RSMs
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get all partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).select("_id").lean();
    const partnerIds = partners.map(p => p._id);

    // Fetch all applications under this ASM hierarchy
    const applications = await Application.find({
      $or: [
        { rsmId: { $in: rsmIds } },
        { rmId: { $in: rmIds } },
        { partnerId: { $in: partnerIds } }
      ]
    })
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

// GET /api/asm/customers/done-payouts
// ASM gets done payout customers
router.get("/customers/done-payouts", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;

    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);

    // Get all RMs under these RSMs
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get all partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).select("_id").lean();
    const partnerIds = partners.map(p => p._id);

    // Fetch all applications under this ASM hierarchy
    const applications = await Application.find({
      $or: [
        { rsmId: { $in: rsmIds } },
        { rmId: { $in: rmIds } },
        { partnerId: { $in: partnerIds } }
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

// GET /api/asm/customer/:customerId/partners-payout
// ASM gets partner details for a customer's applications with payout info
router.get("/customer/:customerId/partners-payout", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;
    const { customerId } = req.params;

    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);

    // Get all RMs under these RSMs
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get all partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).lean();
    const partnerIds = partners.map((p) => p._id);

    // Find applications for this customer under ASM hierarchy
    const applications = await Application.find({
      customerId,
      $or: [
        { rsmId: { $in: rsmIds } },
        { rmId: { $in: rmIds } },
        { partnerId: { $in: partnerIds } }
      ]
    })
      .select("_id partnerId")
      .lean();

    const appIds = applications.map((app) => app._id);

    // Fetch payouts for these applications
    const payouts = await Payout.find({ application: { $in: appIds } })
      .select("application partnerId amount payOutStatus note")
      .lean();

    // Map partner details + application info + payout status
    const partnerDetails = partners
      .filter((partner) => {
        // Check if this partner has any applications for this customer
        return applications.some((app) => app.partnerId?.toString() === partner._id.toString());
      })
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

// POST /api/asm/set-payouts
// ASM creates/updates payout for disbursed application
router.post("/set-payouts", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { applicationId, partnerId, payoutPercentage, note, payOutStatus } =
      req.body;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(applicationId)) {
      return res.status(400).json({ message: "Invalid application ID" });
    }

    const asmId = req.user.sub;

    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);

    // Get all RMs under these RSMs
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get all partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).select("_id").lean();
    const partnerIds = partners.map(p => p._id);

    // Fetch application and verify it belongs to this ASM hierarchy
    const application = await Application.findOne({
      _id: applicationId,
      $or: [
        { rsmId: { $in: rsmIds } },
        { rmId: { $in: rmIds } },
        { partnerId: { $in: partnerIds } }
      ]
    }).select("approvedLoanAmount partnerId rmId");

    if (!application) {
      return res.status(404).json({ message: "Application not found or not assigned to this ASM" });
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

    if (payout) {
      // ✅ Update existing payout (ASM can only change amount/note, NOT final status)
      payout.amount = payoutAmount || payout.amount;
      payout.note = note || payout.note;
      // Force ASM-created payouts to stay in PENDING status
      payout.payOutStatus = "PENDING";
      await payout.save();
    } else {
      // ✅ Create new payout (always PENDING when created by ASM)
      payout = await Payout.create({
        application: applicationId,
        partnerId,
        amount: payoutAmount,
        note,
        payOutStatus: "PENDING",
        addedBy: req.user.sub, // ASM user
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

// ==================== INCENTIVE MANAGEMENT (ASM) ====================

// GET /api/asm/incentives
// ASM gets incentive data based on target achievements
router.get("/incentives", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;
    const { year, month } = req.query;

    // Get all RSMs under this ASM
    const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
    const rsmIds = rsms.map((rsm) => rsm._id);

    // Get all RMs under these RSMs
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    }).lean();
    const rmIds = rms.map((rm) => rm._id);

    // Get all partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).lean();
    const partnerIds = partners.map((p) => p._id);

    // Build date filter
    const currentDate = new Date();
    const targetMonth = month ? Number(month) : currentDate.getMonth() + 1;
    const targetYear = year ? Number(year) : currentDate.getFullYear();

    const startDate = new Date(targetYear, targetMonth - 1, 1);
    const endDate = new Date(targetYear, targetMonth, 1);

    // Get target achievements for partners (for the specific month/year)
    const targets = await Target.find({
      assignedTo: { $in: partnerIds },
      role: ROLES.PARTNER,
      month: targetMonth,
      year: targetYear,
    }).lean();

    // Get relevant applications for achievement calculation
    const relevantApps = await Application.find({
      partnerId: { $in: partnerIds },
      status: { $ne: "DRAFT" },
      updatedAt: {
        $gte: startDate,
        $lt: endDate,
      },
    }).lean();

    // Calculate achievements using Hybrid Target Model (for display only)
    const incentiveData = partners.map((partner) => {
      const partnerTargets = targets.filter(
        (t) => t.assignedTo.toString() === partner._id.toString()
      );
      const partnerApps = relevantApps.filter(
        (app) => app.partnerId.toString() === partner._id.toString()
      );

      // Get target values (use hybrid model if available, else fallback to legacy)
      const target = partnerTargets[0] || {};
      const fileCountTarget = target.fileCountTarget || 4; // Default 4 files
      const disbursementTarget = target.disbursementTarget || target.targetValue || 2000000; // Default ₹20L

      // Calculate achievements
      const achievedFileCount = partnerApps.length;
      const achievedDisbursement = partnerApps
        .filter(app => app.status === "DISBURSED")
        .reduce(
          (sum, app) => sum + (parseFloat(app.approvedLoanAmount) || 0),
          0
        );

      // Check if both conditions are met (Target Achieved)
      const fileTargetMet = achievedFileCount >= fileCountTarget;
      const disbursementTargetMet = achievedDisbursement >= disbursementTarget;
      const targetAchieved = fileTargetMet && disbursementTargetMet;

      // Check if partner met / exceeded targets (for information only)
      // Incentive itself will be set manually, not computed from these numbers.
      const fileTargetExceeded = achievedFileCount > fileCountTarget;
      const disbursementTargetExceeded = achievedDisbursement > disbursementTarget;
      const targetExceeded = disbursementTargetExceeded;

      // Calculate percentages
      const fileAchievementPercentage = fileCountTarget > 0
        ? (achievedFileCount / fileCountTarget) * 100
        : 0;
      const disbursementAchievementPercentage = disbursementTarget > 0
        ? (achievedDisbursement / disbursementTarget) * 100
        : 0;

      // Overall achievement percentage (minimum of both)
      const overallAchievementPercentage = Math.min(
        fileAchievementPercentage,
        disbursementAchievementPercentage
      );

      return {
        partnerId: partner._id,
        partnerName: `${partner.firstName} ${partner.lastName}`,
        partnerEmployeeId: partner.employeeId,
        // Legacy fields for backward compatibility
        totalTarget: disbursementTarget,
        totalAchieved: achievedDisbursement,
        achievementPercentage: overallAchievementPercentage.toFixed(2),
        disbursedCount: achievedFileCount,
        // Hybrid model fields
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
        disbursementAchievementPercentage: disbursementAchievementPercentage.toFixed(2),
        // Incentive flags for UI only – amount is set manually by ASM
        eligibleForIncentive: targetExceeded && targetAchieved,
        incentiveLevel: "NONE",
        incentiveAmount: 0,
      };
    });

    // Attach Incentive records (PENDING / PAID) for this period
    const incentiveDocs = await Incentive.find({
      partnerId: { $in: partnerIds },
      month: targetMonth,
      year: targetYear,
    })
      .select("partnerId amount status month year basis percentValue fixedValue notes")
      .lean();

    const docMap = new Map();
    incentiveDocs.forEach((inv) => {
      docMap.set(inv.partnerId.toString(), inv);
    });

    const response = incentiveData.map((row) => {
      const doc = docMap.get(row.partnerId.toString());
      return {
        ...row,
        incentiveRecordId: doc?._id || null,
        incentiveStatus: doc?.status || null,
        proposedAmount: doc?.amount || 0,
        basis: doc?.basis || null,
        percentValue: doc?.percentValue || null,
        fixedValue: doc?.fixedValue || null,
        notes: doc?.notes || null,
        incentivePaid: doc?.status === "PAID",
        paidAmount: doc?.status === "PAID" ? doc.amount : 0,
      };
    });

    res.json(response);
  } catch (error) {
    console.error("Error fetching incentives:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/asm/incentives/:partnerId/pay
// ASM records a proposed incentive for a partner (stored in Incentive collection as PENDING)
router.post(
  "/incentives/:partnerId/pay",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      const asmId = req.user.sub;
      const { partnerId } = req.params;
      const { basis, percentValue, fixedValue, amount, month, year, notes } = req.body;

      if (!partnerId) {
        return res.status(400).json({ message: "PartnerId is required" });
      }

      if (!basis || !["PERCENT", "FIXED"].includes(basis)) {
        return res.status(400).json({ message: "Invalid basis. Use PERCENT or FIXED." });
      }

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ message: "Valid incentive amount is required" });
      }

      const now = new Date();
      const payMonth = month || now.getMonth() + 1;
      const payYear = year || now.getFullYear();

      // Optional: verify partner exists and is under this ASM hierarchy
      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
      }).lean();

      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      // Snapshot current incentive metrics from latest calculation
      // Reuse the same logic as /asm/incentives to fetch one partner's row
      const incentivesSnapshot = await Application.aggregate([
        {
          $match: {
            status: "DISBURSED",
            partnerId: new mongoose.Types.ObjectId(partnerId),
          },
        },
        {
          $group: {
            _id: "$partnerId",
            achievedDisbursement: { $sum: "$approvedLoanAmount" },
            achievedFileCount: { $sum: 1 },
          },
        },
      ]);

      const snapshot = incentivesSnapshot[0] || {
        achievedDisbursement: 0,
        achievedFileCount: 0,
      };

      const target = await Target.findOne({
        assignedTo: partnerId,
        role: ROLES.PARTNER,
        month: payMonth,
        year: payYear,
      }).lean();

      const fileCountTarget = target?.fileCountTarget || 4;
      const disbursementTarget = target?.disbursementTarget || target?.targetValue || 2000000;

      const incentiveDoc = await Incentive.create({
        partnerId,
        asmId,
        month: payMonth,
        year: payYear,
        fileCountTarget,
        achievedFileCount: snapshot.achievedFileCount || 0,
        disbursementTarget,
        achievedDisbursement: snapshot.achievedDisbursement || 0,
        basis,
        percentValue: basis === "PERCENT" ? Number(percentValue) || 0 : undefined,
        fixedValue: basis === "FIXED" ? Number(fixedValue) || Number(amount) : undefined,
        amount: Number(amount),
        status: "PENDING",
        notes: notes || "",
      });

      return res.status(201).json(incentiveDoc);
    } catch (error) {
      console.error("Error recording incentive payment:", error);
      return res.status(500).json({ message: "Server error", error: error.message });
    }
  }
);

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
  "/rm-deactivate",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { oldRmId, newRmId } = req.body;

      if (!oldRmId || !newRmId) {
        return res.status(400).json({ message: "Both RM IDs are required" });
      }

      let partnerCount = 0;
      let appModifiedCount = 0;
      let oldRm;
      let newRm;
      let reassignmentAudit;
      await session.withTransaction(async () => {
        const partners = await User.find(
          { role: ROLES.PARTNER, rmId: oldRmId },
          "_id"
        ).session(session);
        const partnerIds = partners.map((p) => p._id);
        partnerCount = partnerIds.length;

        await User.updateMany(
          { role: ROLES.PARTNER, rmId: oldRmId },
          { $set: { rmId: newRmId } },
          { session }
        );

        const appUpdate = await Application.updateMany(
          buildReassignableApplicationFilter({ rmId: oldRmId }),
          { $set: { rmId: newRmId } },
          { session }
        );
        appModifiedCount = appUpdate.modifiedCount || 0;

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
        if (!newRm || newRm.role !== ROLES.RM) {
          throw new Error("New RM not found or invalid");
        }
        reassignmentAudit = buildReassignmentAudit({
          changedBy: req.user.sub,
          oldUserId: oldRmId,
          newUserId: newRmId,
          action: "asm_rm_deactivate",
        });
        await persistReassignmentAudit(reassignmentAudit, req, session);
      });

      // 6️⃣ Send deactivation email
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
              <p>Regards,<br/>DhanSource Capital</p>
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
              <p>Regards,<br/>DhanSource Capital</p>
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
          "RM deactivated and active workload reassigned successfully. Settled finance/history is preserved.",
        reassignmentAudit,
      });
    } catch (error) {
      if (error.message === "New RM not found or invalid") {
        return res.status(404).json({ message: error.message });
      }
      console.error("Error in /assign-partners-rm:", error);
      res.status(500).json({ message: error.message });
    } finally {
      await session.endSession();
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
  "/partner-deactivate",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { oldPartnerId, newPartnerId } = req.body;

      if (!oldPartnerId) {
        return res.status(400).json({ message: "oldPartnerId is required" });
      }

      const oldId = new mongoose.Types.ObjectId(oldPartnerId);

      let reassignedCustomers = 0;
      let reassignedApplications = 0;
      let reassignedPayouts = 0;
      let reassignedIncentives = 0;
      let preservedPayoutsDone = 0;
      let preservedIncentivesPaid = 0;
      let deactivatedPartner = null;
      let reassignmentAudit = null;

      await session.withTransaction(async () => {
        const oldPartner = await User.findById(oldId).session(session);
        if (!oldPartner || oldPartner.role !== ROLES.PARTNER) {
          throw new Error("Old partner not found or not a partner");
        }

        if (newPartnerId) {
          const newId = new mongoose.Types.ObjectId(newPartnerId);
          const newPartner = await User.findById(newId).session(session);
          if (
            !newPartner ||
            newPartner.role !== ROLES.PARTNER ||
            String(newPartner._id) === String(oldPartner._id)
          ) {
            throw new Error("Valid newPartnerId is required");
          }

          const customerUpdate = await User.updateMany(
            { role: ROLES.CUSTOMER, partnerId: oldId },
            { $set: { partnerId: newId } },
            { session }
          );
          reassignedCustomers = customerUpdate.modifiedCount || 0;

          const appUpdate = await Application.updateMany(
            buildReassignableApplicationFilter({ partnerId: oldId }),
            { $set: { partnerId: newId } },
            { session }
          );
          reassignedApplications = appUpdate.modifiedCount || 0;

          const payoutUpdate = await Payout.updateMany(
            { partnerId: oldId, payOutStatus: REASSIGNABLE_PAYOUT_STATUS },
            { $set: { partnerId: newId } },
            { session }
          );
          reassignedPayouts = payoutUpdate.modifiedCount || 0;

          const incentiveUpdate = await Incentive.updateMany(
            { partnerId: oldId, status: REASSIGNABLE_INCENTIVE_STATUS },
            { $set: { partnerId: newId } },
            { session }
          );
          reassignedIncentives = incentiveUpdate.modifiedCount || 0;
        }

        deactivatedPartner = await User.findByIdAndUpdate(
          oldId,
          { $set: { status: "SUSPENDED", updatedAt: new Date() } },
          { new: true, session }
        );
        preservedPayoutsDone = await Payout.countDocuments({
          partnerId: oldId,
          payOutStatus: LOCKED_PAYOUT_STATUS,
        }).session(session);
        preservedIncentivesPaid = await Incentive.countDocuments({
          partnerId: oldId,
          status: LOCKED_INCENTIVE_STATUS,
        }).session(session);

        reassignmentAudit = buildReassignmentAudit({
          changedBy: req.user.sub,
          oldUserId: oldPartnerId,
          newUserId: newPartnerId || null,
          action: "asm_partner_deactivate",
        });
        await persistReassignmentAudit(reassignmentAudit, req, session);
      });
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
        message: `Partner ${deactivatedPartner.firstName} ${deactivatedPartner.lastName} has been deactivated. Active workload moved, settled finance/history preserved.`,
        reassignmentAudit,
      });
    } catch (error) {
      if (error.message === "Old partner not found or not a partner") {
        return res.status(404).json({ message: error.message });
      }
      if (error.message === "Valid newPartnerId is required") {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error in /deactivate-partner:", error);
      res
        .status(500)
        .json({ message: "Internal server error", error: error.message });
    } finally {
      await session.endSession();
    }
  }
);

// Activate RM (ASM can activate RMs under their RSMs)
router.post("/rm-activate", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { rmId } = req.body;

    if (!rmId) {
      return res.status(400).json({ message: "rmId is required" });
    }

    const asmId = req.user.sub;

    // Get RSMs under this ASM
    const rsms = await User.find({ role: ROLES.RSM, asmId }).select("_id").lean();
    const rsmIds = rsms.map(r => r._id);

    // Verify RM belongs to one of the RSMs under this ASM
    const rm = await User.findOne({
      _id: rmId,
      role: ROLES.RM,
      $or: [
        { personalRsmId: { $in: rsmIds } },
        { businessHomeRsmId: { $in: rsmIds } }
      ]
    });

    if (!rm) {
      return res.status(404).json({ message: "RM not found or not under your management" });
    }

    // Activate RM
    const updatedRm = await User.findByIdAndUpdate(
      rmId,
      { status: "ACTIVE" },
      { new: true }
    );

    // 📧 Send activation email
    try {
      await sendMail({
        to: updatedRm.email,
        subject: "Your RM Account Has Been Activated",
        html: `
          <p>Dear ${updatedRm.firstName} ${updatedRm.lastName},</p>
          <p>We are pleased to inform you that your RM account has been <b>activated</b> successfully.</p>
          <p><b>Employee ID:</b> ${updatedRm.employeeId || "-"}<br/>
          <b>RM Code:</b> ${updatedRm.rmCode || "-"}</p>
          <p>You can now log in and continue managing your Partners and their Customers as usual.</p>
          <br/>
          <p>Regards,<br/>DhanSource Capital</p>
        `,
      });
      console.log("📧 RM activation mail sent to:", updatedRm.email);
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
});


router.post(
  "/partner-activate",
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
            <p>Regards,<br/>DhanSource Capital</p>
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

// ================== REMOVED: ASM/RSM/RM TARGET ASSIGNMENT ==================
// Targets are now only for Partners. ASM/RSM/RM targets have been removed.

// ================== ASSIGN TARGET TO PARTNERS (ASM Only) ==================

// POST /target/assign-partner (Single Partner)
// ASM assigns target to a single partner with hybrid model
router.post(
  "/target/assign-partner",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      const { partnerId, month, year, fileCountTarget, disbursementTarget } = req.body;

      if (!partnerId || !month || !year) {
        return res.status(400).json({ message: "partnerId, month, and year are required" });
      }

      if (month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month value" });
      }

      const asmId = req.user.sub;

      // Verify partner is under ASM's hierarchy
      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
      }).lean();

      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      // Get RM of this partner
      const rm = await User.findOne({ _id: partner.rmId, role: ROLES.RM }).lean();
      if (!rm) {
        return res.status(404).json({ message: "Partner's RM not found" });
      }

      // Verify RM is under ASM's hierarchy (through RSM)
      const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
      const rsmIds = rsms.map((r) => r._id);

      const isUnderAsm = rm.personalRsmId && rsmIds.some(id => id.toString() === rm.personalRsmId.toString()) ||
        rm.businessHomeRsmId && rsmIds.some(id => id.toString() === rm.businessHomeRsmId.toString());

      if (!isUnderAsm) {
        return res.status(403).json({ message: "Partner is not under your ASM hierarchy" });
      }

      if (!fileCountTarget || !disbursementTarget) {
        return res.status(400).json({ message: "fileCountTarget and disbursementTarget are required" });
      }

      let target = await Target.findOne({
        assignedTo: partnerId,
        role: ROLES.PARTNER,
        month: Number(month),
        year: Number(year),
      });

      if (target) {
        // Update target fields
        target.fileCountTarget = Number(fileCountTarget);
        target.disbursementTarget = Number(disbursementTarget);
        target.assignedBy = asmId;
        await target.save();
      } else {
        target = await Target.create({
          assignedBy: asmId,
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
  }
);

// POST /target/assign-partner-bulk (Bulk Partner Targets)
// ASM assigns targets to all partners under their hierarchy
router.post(
  "/target/assign-partner-bulk",
  auth,
  requireRole(ROLES.ASM),
  async (req, res) => {
    try {
      let { month, year, fileCountTarget, disbursementTarget } = req.body;

      if (!month || !year) {
        return res.status(400).json({ message: "Month and year are required" });
      }

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

      if (!month || month < 1 || month > 12) {
        return res.status(400).json({ message: "Invalid month value" });
      }

      const asmId = req.user.sub;

      // Get all RSMs under this ASM
      const rsms = await User.find({ asmId, role: ROLES.RSM }).lean();
      const rsmIds = rsms.map((rsm) => rsm._id);

      // Get all RMs under these RSMs
      const rms = await User.find({
        role: ROLES.RM,
        $or: [
          { personalRsmId: { $in: rsmIds } },
          { businessHomeRsmId: { $in: rsmIds } }
        ]
      }).lean();
      const rmIds = rms.map((rm) => rm._id);

      // Get all partners under these RMs
      const partners = await User.find({
        role: ROLES.PARTNER,
        rmId: { $in: rmIds },
      }).lean();

      if (!partners.length) {
        return res.status(404).json({ message: "No Partners found under this ASM" });
      }

      if (!fileCountTarget || !disbursementTarget) {
        return res.status(400).json({ message: "fileCountTarget and disbursementTarget are required" });
      }

      const finalFileCountTarget = Number(fileCountTarget);
      const finalDisbursementTarget = Number(disbursementTarget);

      const bulkAssignments = [];

      for (let partner of partners) {
        let target = await Target.findOne({
          assignedTo: partner._id,
          role: ROLES.PARTNER,
          month,
          year,
        });

        if (target) {
          // Update target fields
          target.fileCountTarget = finalFileCountTarget;
          target.disbursementTarget = finalDisbursementTarget;
          target.assignedBy = asmId;
          await target.save();
          bulkAssignments.push(target);
        } else {
          const newTarget = await Target.create({
            assignedBy: asmId,
            assignedTo: partner._id,
            role: ROLES.PARTNER,
            month,
            year,
            fileCountTarget: finalFileCountTarget,
            disbursementTarget: finalDisbursementTarget,
          });
          bulkAssignments.push(newTarget);
        }
      }

      emitTargetUpdatesForDocs(global.io, bulkAssignments);

      res.status(201).json({
        message: "Bulk target assigned successfully to all Partners under this ASM",
        fileCountTarget: finalFileCountTarget,
        disbursementTarget: finalDisbursementTarget,
        month,
        year,
        assignments: bulkAssignments,
      });
    } catch (err) {
      console.error("Assign Partner bulk error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
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
        currentEmail,
        currentPassword,
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

      let emailChangePending = false;
      let emailChangeMessage = null;

      if (
        email &&
        String(email).toLowerCase() !== String(updatedAsm.email).toLowerCase()
      ) {
        const normalizedEmail = String(email).toLowerCase();
        const exists = await User.findOne({
          email: normalizedEmail,
          _id: { $ne: asmId },
        });
        if (exists) {
          return res.status(409).json({ message: "Email already in use" });
        }
        const current = await User.findById(asmId).select("email firstName passwordHash");
        if (!currentPassword) {
          return res.status(400).json({ message: "Current password is required for email change." });
        }
        const passOk = await argon2.verify(current.passwordHash, String(currentPassword));
        if (!passOk) {
          return res.status(400).json({ message: "Current password is incorrect." });
        }
        if (
          currentEmail &&
          String(currentEmail).toLowerCase().trim() !== String(current.email).toLowerCase().trim()
        ) {
          return res.status(400).json({ message: "Current email does not match your active email." });
        }
        await createEmailChangeRequest({
          user: current,
          currentEmail: current.email,
          newEmail: normalizedEmail,
          clientUrl: process.env.CLIENT_URL,
        });
        emailChangePending = true;
        emailChangeMessage =
          "Email change link sent. Please confirm via the link in your inbox.";
      }

      const profileObj = updatedAsm?.toObject ? updatedAsm.toObject() : updatedAsm;
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

// GET /api/asm/rsm/:rsmId/analytics (Universal - but restricted to RSM only)
// ASM views analytics for a specific RSM (Hierarchical Access - ASM can only see RSMs)
// Note: This endpoint is already defined above at /rsm/:rsmId/analytics, but keeping this for backward compatibility
// Universal analytics/dashboard API - RESTRICTED TO RSM ONLY
router.get("/:id/analytics", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const asmId = req.user.sub;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const user = await User.findById(id).lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    // ✅ HIERARCHICAL ACCESS CONTROL: ASM can only view RSM analytics
    if (user.role !== ROLES.RSM) {
      return res.status(403).json({
        message: "Access denied. ASM can only view RSM analytics."
      });
    }

    // Verify RSM belongs to this ASM
    // If asmId is not set, set it now for future queries (backward compatibility)
    if (!user.asmId) {
      // RSM doesn't have asmId set, update it now
      await User.updateOne({ _id: id }, { asmId: asmId });
      user.asmId = asmId;
    } else if (user.asmId.toString() !== asmId.toString()) {
      // RSM has asmId but it doesn't match - deny access
      return res.status(403).json({
        message: "Access denied. RSM does not belong to this ASM."
      });
    }

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

    const getAssignedTarget = async (userId, role, filter) => {
      const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
      ];

      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      // Find target
      const t = await Target.findOne({
        assignedTo: userId,
        role,
        month: currentMonth,
        year: currentYear,
      }).lean();

      // Calculate achievedValue
      const agg = await Application.aggregate([
        {
          $match: {
            ...filter,
            status: "DISBURSED",
            $expr: {
              $and: [
                { $eq: [{ $month: { $ifNull: ["$disbursedDate", "$createdAt"] } }, currentMonth] },
                { $eq: [{ $year: { $ifNull: ["$disbursedDate", "$createdAt"] } }, currentYear] },
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

      // Get target value - prefer disbursementTarget, fallback to targetValue
      let targetValue = 0;
      if (t) {
        targetValue = Number(t.disbursementTarget || t.targetValue || 0);
      }

      // Debug logging
      console.log(`[ASM Analytics] getAssignedTarget for userId=${userId}, role=${role}:`, {
        foundTarget: !!t,
        disbursementTarget: t?.disbursementTarget,
        targetValue: t?.targetValue,
        finalTargetValue: targetValue,
        achievedValue,
        month: currentMonth,
        year: currentYear
      });

      return {
        month: monthNames[currentMonth - 1],
        year: currentYear,
        targetValue,
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
    let assignedTargetValue = { targetValue: 0, achievedValue: 0 }; // Initialize as object
    let scope = ROLES.RSM; // Always RSM for ASM view

    // ================= RSM ANALYTICS ONLY =================
    // ASM can only view RSM analytics (hierarchical access - ASM → RSM)
    // Get all RMs under this RSM
    const rms = await User.find({
      role: ROLES.RM,
      $or: [
        { personalRsmId: id },
        { businessHomeRsmId: id }
      ]
    }).select("_id").lean();
    const rmIds = rms.map((x) => x._id);

    // Get partners under these RMs
    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
    }).select("_id").lean();
    const partnerIds = partners.map((x) => x._id);

    // Get customers
    const customers = await Application.distinct("customerId", {
      $or: [
        { rsmId: id },
        { rmId: { $in: rmIds } },
        { partnerId: { $in: partnerIds } }
      ]
    });

    // Calculate totals for this RSM
    totalDisbursed = await sumDisbursedBy({ rsmId: id });
    assignedTargetValue = await getAssignedTarget(id, ROLES.RSM, { rsmId: id });

    performance =
      assignedTargetValue.targetValue > 0
        ? ((assignedTargetValue.achievedValue / assignedTargetValue.targetValue) * 100).toFixed(2)
        : "0.00";

    totals = {
      totalRMs: rmIds.length,
      totalPartners: partnerIds.length,
      totalCustomers: customers.length,
    };

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


// POST /api/rsm/deactivate (ASM can deactivate RSM)
router.post("/rsm-deactivate", auth, requireRole(ROLES.ASM), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const rsmId = req.body?.rsmId || req.body?.oldRsmId;
    const newRsmId = req.body?.newRsmId;

    if (!rsmId) {
      return res.status(400).json({ message: "rsmId is required" });
    }

    const asmId = req.user.sub;

    let rsm;
    let reassignedRms = 0;
    let suspendedRsm;
    let reassignmentAudit;
    await session.withTransaction(async () => {
      rsm = await User.findOne({ _id: rsmId, role: ROLES.RSM, asmId }).session(session);
      if (!rsm) throw new Error("RSM not found or not under your management");

      if (newRsmId) {
        if (String(newRsmId) === String(rsmId)) {
          throw new Error("newRsmId cannot be same as rsmId");
        }
        const newRsm = await User.findOne({
          _id: newRsmId,
          role: ROLES.RSM,
          asmId,
          status: "ACTIVE",
          rsmType: rsm.rsmType,
        }).session(session);
        if (!newRsm) {
          throw new Error("Valid active replacement RSM is required (same type, same ASM)");
        }

        const rmFilter =
          rsm.rsmType === "PERSONAL"
            ? { role: ROLES.RM, personalRsmId: rsm._id }
            : rsm.rsmType === "BUSINESS_HOME"
              ? { role: ROLES.RM, businessHomeRsmId: rsm._id }
              : { role: ROLES.RM, $or: [{ personalRsmId: rsm._id }, { businessHomeRsmId: rsm._id }] };

        const rmUpdate =
          rsm.rsmType === "PERSONAL"
            ? await User.updateMany(rmFilter, { $set: { personalRsmId: newRsm._id } }, { session })
            : rsm.rsmType === "BUSINESS_HOME"
              ? await User.updateMany(rmFilter, { $set: { businessHomeRsmId: newRsm._id } }, { session })
              : await User.updateMany(rmFilter, { $set: { personalRsmId: newRsm._id, businessHomeRsmId: newRsm._id } }, { session });

        reassignedRms = rmUpdate.modifiedCount || 0;
      }

      suspendedRsm = await User.findOneAndUpdate(
        { _id: rsmId, role: ROLES.RSM, asmId },
        { status: "SUSPENDED" },
        { new: true, session }
      );
      reassignmentAudit = buildReassignmentAudit({
        changedBy: req.user.sub,
        oldUserId: rsmId,
        newUserId: newRsmId || null,
        action: "asm_rsm_deactivate",
      });
      await persistReassignmentAudit(reassignmentAudit, req, session);
    });

    // 📧 Send deactivation email
    try {
      await sendMail({
        to: rsm.email,
        subject: "Your RSM Account Has Been Deactivated",
        html: `
          <p>Dear ${rsm.firstName} ${rsm.lastName},</p>
          <p>Your RSM account has been <b>deactivated</b> by your ASM.</p>
          <p><b>Employee ID:</b> ${rsm.employeeId || "-"}<br/>
          <b>RSM Type:</b> ${rsm.rsmType || "-"}</p>
          <p>If you believe this action was incorrect, please contact support.</p>
          <br/>
          <p>Regards,<br/>DhanSource Capital</p>
        `,
      });
      console.log("📧 RSM deactivation mail sent to:", rsm.email);
    } catch (mailErr) {
      console.error("❌ Failed to send RSM deactivation email:", mailErr.message);
    }

    res.json({
      message: "RSM deactivated successfully and notified via email",
      reassignmentAudit,
    });
  } catch (error) {
    if (
      error.message === "RSM not found or not under your management" ||
      error.message === "newRsmId cannot be same as rsmId" ||
      error.message === "Valid active replacement RSM is required (same type, same ASM)"
    ) {
      const code =
        error.message === "RSM not found or not under your management"
          ? 404
          : 400;
      return res.status(code).json({ message: error.message });
    }
    console.error("Error in /rsm/deactivate:", error);
    res.status(500).json({ message: error.message });
  } finally {
    await session.endSession();
  }
});

// POST /api/rsm/activate (ASM can activate RSM)
router.post("/rsm-activate", auth, requireRole(ROLES.ASM), async (req, res) => {
  try {
    const { rsmId } = req.body;

    if (!rsmId) {
      return res.status(400).json({ message: "rsmId is required" });
    }

    const asmId = req.user.sub;

    // Verify RSM belongs to this ASM
    const rsm = await User.findOneAndUpdate(
      { _id: rsmId, role: ROLES.RSM, asmId },
      { status: "ACTIVE" },
      { new: true }
    );

    if (!rsm) {
      return res.status(404).json({ message: "RSM not found or not under your management" });
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
});


export default router;
