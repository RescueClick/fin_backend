/**
 * Universal Analytics API
 * Handles analytics for all roles (Admin, ASM, RSM, RM, Partner)
 * with proper hierarchical access control
 */

import express from "express";
import mongoose from "mongoose";
import { auth } from "../middleware/auth.js";
import { ROLES } from "../config/roles.js";
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";
import { Target } from "../models/Target.js";
import { Incentive } from "../models/Incentive.js";
import { Payout } from "../models/Payout.js";

const router = express.Router();

// ==================== SHARED HELPERS (ALL ANALYTICS ENDPOINTS) ====================

function parseDateRange(req) {
  const { start, end } = req.query;
  const startDate = start ? new Date(String(start)) : null;
  const endDate = end ? new Date(String(end)) : null;

  const hasStart = startDate instanceof Date && !Number.isNaN(startDate.getTime());
  const hasEnd = endDate instanceof Date && !Number.isNaN(endDate.getTime());

  // If only one side is provided, treat it as open-ended
  return {
    startDate: hasStart ? startDate : null,
    endDate: hasEnd ? endDate : null,
  };
}

function buildUpdatedAtRangeFilter(startDate, endDate) {
  if (!startDate && !endDate) return {};
  const range = {};
  if (startDate) range.$gte = startDate;
  if (endDate) range.$lt = endDate;
  return { updatedAt: range };
}

function buildCreatedAtRangeFilter(startDate, endDate) {
  if (!startDate && !endDate) return {};
  const range = {};
  if (startDate) range.$gte = startDate;
  if (endDate) range.$lt = endDate;
  return { createdAt: range };
}

function buildLoanTypeFilter(req) {
  const { loanType } = req.query;
  if (!loanType) return {};
  return { loanType: String(loanType) };
}

async function enforceHierarchyAccess({ requesterId, requesterRole, targetUser }) {
  // SUPER_ADMIN can view any user's analytics
  if (requesterRole === ROLES.SUPER_ADMIN) return;

  // ASM can only view RSM analytics under them
  if (requesterRole === ROLES.ASM) {
    if (targetUser.role !== ROLES.RSM) {
      throw Object.assign(new Error("ASM can only view RSM analytics"), { statusCode: 403 });
    }
    if (targetUser.asmId && targetUser.asmId.toString() !== requesterId) {
      throw Object.assign(new Error("RSM not found or not under this ASM"), { statusCode: 403 });
    }
    // Backward compatibility: auto-set asmId if missing
    if (!targetUser.asmId) {
      await User.findByIdAndUpdate(targetUser._id, { asmId: requesterId });
    }
    return;
  }

  // RSM can only view RM analytics under them
  if (requesterRole === ROLES.RSM) {
    if (targetUser.role !== ROLES.RM) {
      throw Object.assign(new Error("RSM can only view RM analytics"), { statusCode: 403 });
    }
    const isUnderRSM =
      (targetUser.personalRsmId && targetUser.personalRsmId.toString() === requesterId) ||
      (targetUser.businessHomeRsmId && targetUser.businessHomeRsmId.toString() === requesterId);
    if (!isUnderRSM) {
      throw Object.assign(new Error("RM not found or not under this RSM"), { statusCode: 403 });
    }
    return;
  }

  // RM can only view Partner analytics under them
  if (requesterRole === ROLES.RM) {
    if (targetUser.role !== ROLES.PARTNER) {
      throw Object.assign(new Error("RM can only view Partner analytics"), { statusCode: 403 });
    }
    if (!targetUser.rmId || targetUser.rmId.toString() !== requesterId) {
      throw Object.assign(new Error("Partner not found or not under this RM"), { statusCode: 403 });
    }
    return;
  }

  // PARTNER can only view their own analytics
  if (requesterRole === ROLES.PARTNER) {
    if (targetUser._id.toString() !== requesterId) {
      throw Object.assign(new Error("Partners can only view their own analytics"), { statusCode: 403 });
    }
    return;
  }

  throw Object.assign(new Error("Unauthorized role"), { statusCode: 403 });
}

/**
 * Build the application match scope (hierarchy filter).
 * Returns:
 * - appMatchBase: filter to apply on Application queries
 * - partnerIds: partner IDs included in this scope (needed for payouts/incentives)
 */
async function buildScopeMatch({ targetUserId, targetRole }) {
  const id = String(targetUserId);

  // Helper to ObjectId array
  const toObjectIds = (arr) => arr.map((x) => new mongoose.Types.ObjectId(x));

  // ASM scope: partners under RMs under RSMs under ASM
  if (targetRole === ROLES.ASM) {
    // 1) RSMs under ASM
    const rsms = await User.find({
      asmId: id,
      role: ROLES.RSM,
      status: "ACTIVE",
    })
      .select("_id")
      .lean();
    const rsmIds = rsms.map((x) => x._id);

    // 2) RMs under those RSMs (personal + business/home)
    const rms = await User.find({
      role: ROLES.RM,
      status: "ACTIVE",
      ...(rsmIds.length
        ? {
            $or: [
              { personalRsmId: { $in: rsmIds } },
              { businessHomeRsmId: { $in: rsmIds } },
            ],
          }
        : { _id: { $in: [] } }),
    })
      .select("_id")
      .lean();
    const rmIds = rms.map((x) => x._id);

    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
      status: "ACTIVE",
    }).select("_id").lean();
    const partnerIds = partners.map((x) => x._id);

    return {
      partnerIds,
      appMatchBase: partnerIds.length ? { partnerId: { $in: toObjectIds(partnerIds) } } : {},
    };
  }

  // RSM scope: partners under RMs under this RSM
  if (targetRole === ROLES.RSM) {
    const rms = await User.find({
      role: ROLES.RM,
      $or: [{ personalRsmId: id }, { businessHomeRsmId: id }],
      status: "ACTIVE",
    }).select("_id").lean();
    const rmIds = rms.map((x) => x._id);

    const partners = await User.find({
      rmId: { $in: rmIds },
      role: ROLES.PARTNER,
      status: "ACTIVE",
    }).select("_id").lean();
    const partnerIds = partners.map((x) => x._id);

    const or = [
      { rsmId: new mongoose.Types.ObjectId(id) },
      ...(rmIds.length ? [{ rmId: { $in: toObjectIds(rmIds) } }] : []),
      ...(partnerIds.length ? [{ partnerId: { $in: toObjectIds(partnerIds) } }] : []),
    ];

    return {
      partnerIds,
      appMatchBase: or.length ? { $or: or } : {},
    };
  }

  // RM scope: partners under RM
  if (targetRole === ROLES.RM) {
    const partners = await User.find({
      rmId: id,
      role: ROLES.PARTNER,
      status: "ACTIVE",
    }).select("_id").lean();
    const partnerIds = partners.map((x) => x._id);

    return {
      partnerIds,
      appMatchBase: partnerIds.length
        ? { partnerId: { $in: toObjectIds(partnerIds) } }
        : {},
    };
  }

  // Partner scope: this partner only
  if (targetRole === ROLES.PARTNER) {
    return {
      partnerIds: [new mongoose.Types.ObjectId(id)],
      appMatchBase: { partnerId: new mongoose.Types.ObjectId(id) },
    };
  }

  // Admin scope (SUPER_ADMIN viewing someone) is handled by passing targetUser.role above.
  // CUSTOMER scope: this customer only
  if (targetRole === ROLES.CUSTOMER) {
    return {
      partnerIds: [],
      appMatchBase: { customerId: new mongoose.Types.ObjectId(id) },
    };
  }

  // SUPER_ADMIN as a target doesn't have a meaningful application scope; return empty
  return { partnerIds: [], appMatchBase: {} };
}

/**
 * Ordered reporting chain from organization → user (ASM → RSM → RM → Partner).
 * Each node includes role, display name, ids, and contact for managers ("boss" info).
 */
async function buildReportingChain(targetUser) {
  const select =
    "firstName lastName employeeId phone email role asmId personalRsmId businessHomeRsmId rsmType adminId";
  const chain = [];

  const pushNode = (u, segmentLabel, isSelf = false) => {
    if (!u) return;
    chain.push({
      segmentLabel: segmentLabel || null,
      role: u.role,
      name: `${u.firstName || ""} ${u.lastName || ""}`.trim() || "—",
      employeeId: u.employeeId || null,
      phone: u.phone || null,
      email: u.email || null,
      rsmType: u.rsmType || null,
      isSelf,
    });
  };

  const role = targetUser.role;

  if (role === ROLES.PARTNER) {
    if (!targetUser.rmId) {
      pushNode(targetUser, "Partner", true);
      return chain;
    }
    const rm = await User.findById(targetUser.rmId).select(select).lean();
    const rsmOrdered = [];
    const pairs = [
      [rm?.personalRsmId, "RSM (Personal loans)"],
      [rm?.businessHomeRsmId, "RSM (Business/Home loans)"],
    ];
    const seenRsm = new Set();
    for (const [rid, label] of pairs) {
      if (!rid) continue;
      const idstr = rid.toString();
      if (seenRsm.has(idstr)) continue;
      seenRsm.add(idstr);
      const rsm = await User.findById(rid).select(select).lean();
      if (rsm) rsmOrdered.push({ rsm, label });
    }
    const asmSeen = new Set();
    const asmOrdered = [];
    for (const { rsm } of rsmOrdered) {
      if (rsm.asmId) {
        const asid = rsm.asmId.toString();
        if (!asmSeen.has(asid)) {
          asmSeen.add(asid);
          const asm = await User.findById(rsm.asmId).select(select).lean();
          if (asm) asmOrdered.push(asm);
        }
      }
    }
    asmOrdered.forEach((asm) => pushNode(asm, "Area Sales Manager"));
    rsmOrdered.forEach(({ rsm, label }) => pushNode(rsm, label));
    if (rm) pushNode(rm, "Relationship Manager");
    pushNode(targetUser, "Partner", true);
    return chain;
  }

  if (role === ROLES.RM) {
    const rsmOrdered = [];
    const pairs = [
      [targetUser.personalRsmId, "RSM (Personal loans)"],
      [targetUser.businessHomeRsmId, "RSM (Business/Home loans)"],
    ];
    const seenRsm = new Set();
    for (const [rid, label] of pairs) {
      if (!rid) continue;
      const idstr = rid.toString();
      if (seenRsm.has(idstr)) continue;
      seenRsm.add(idstr);
      const rsm = await User.findById(rid).select(select).lean();
      if (rsm) rsmOrdered.push({ rsm, label });
    }
    const asmSeen = new Set();
    const asmOrdered = [];
    for (const { rsm } of rsmOrdered) {
      if (rsm.asmId) {
        const asid = rsm.asmId.toString();
        if (!asmSeen.has(asid)) {
          asmSeen.add(asid);
          const asm = await User.findById(rsm.asmId).select(select).lean();
          if (asm) asmOrdered.push(asm);
        }
      }
    }
    asmOrdered.forEach((asm) => pushNode(asm, "Area Sales Manager"));
    rsmOrdered.forEach(({ rsm, label }) => pushNode(rsm, label));
    pushNode(targetUser, "Relationship Manager", true);
    return chain;
  }

  if (role === ROLES.RSM) {
    if (targetUser.asmId) {
      const asm = await User.findById(targetUser.asmId).select(select).lean();
      if (asm) pushNode(asm, "Area Sales Manager");
    }
    pushNode(targetUser, "Regional Sales Manager", true);
    return chain;
  }

  if (role === ROLES.ASM) {
    if (targetUser.adminId) {
      const admin = await User.findById(targetUser.adminId).select(select).lean();
      if (admin) pushNode(admin, "Super Admin");
    }
    pushNode(targetUser, "Area Sales Manager", true);
    return chain;
  }

  if (role === ROLES.SUPER_ADMIN) {
    pushNode(targetUser, "Super Admin", true);
    return chain;
  }

  pushNode(targetUser, targetUser.role || "User", true);
  return chain;
}

/**
 * Universal Analytics Endpoint
 * GET /api/analytics/:id
 * 
 * Access Control:
 * - SUPER_ADMIN: Can view analytics for any user
 * - ASM: Can only view RSM analytics (hierarchical access)
 * - RSM: Can only view RM analytics (hierarchical access)
 * - RM: Can only view Partner analytics (hierarchical access)
 * - PARTNER: Can view their own analytics
 */
router.get(
  "/:id",
  auth,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { year } = req.query;
      const requesterId = req.user.sub;
      const requesterRole = req.user.role;

      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid user ID" });
      }

      // Find the target user
      const targetUser = await User.findById(id).lean();
      if (!targetUser) {
        return res.status(404).json({ message: "User not found" });
      }

      // ==================== HIERARCHICAL ACCESS CONTROL ====================
      try {
        await enforceHierarchyAccess({ requesterId, requesterRole, targetUser });
      } catch (e) {
        return res.status(e.statusCode || 403).json({ message: e.message || "Forbidden" });
      }

      // ⚠️ CRITICAL: If user is SUSPENDED, return zero targets and achievements
      if (targetUser.status === "SUSPENDED") {
        const reportingChainSuspended = await buildReportingChain(targetUser);
        return res.json({
          data: {
            profile: {
              userId: targetUser._id,
              name: `${targetUser.firstName} ${targetUser.lastName}`,
              role: targetUser.role,
              email: targetUser.email,
              phone: targetUser.phone || "N/A",
              employeeId: targetUser.employeeId || "N/A",
              status: targetUser.status,
              reportingChain: reportingChainSuspended,
            },
            analytics: {
              scope: targetUser.role,
              totals: {},
              totalDisbursed: 0,
              assignedTarget: { targetValue: 0, achievedValue: 0 },
              performance: "0.00%",
            },
          },
        });
      }

      // ==================== HELPER FUNCTIONS ====================
      
      /**
       * Sum disbursed amounts based on filter
       */
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

      /**
       * Get assigned target and achieved value for current month
       */
      const getAssignedTarget = async (userId, role, filter) => {
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

        // Calculate achievedValue for current month
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
          month: currentMonth,
          year: currentYear,
          targetValue: t ? Number(t.disbursementTarget || t.targetValue || 0) : 0,
          achievedValue,
        };
      };

      /**
       * Sum incentives paid based on partner filter
       */
      const sumIncentivesPaidByPartners = async (partnerFilter) => {
        const match = {
          status: "PAID",
          ...partnerFilter,
        };
        const agg = await Incentive.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: { $ifNull: ["$amount", 0] } } },
            },
          },
        ]);
        return agg.length > 0 ? Number(agg[0].total) : 0;
      };

      // ==================== BASE PROFILE ====================
      const reportingChain = await buildReportingChain(targetUser);
      const base = {
        userId: targetUser._id,
        name: `${targetUser.firstName} ${targetUser.lastName}`,
        role: targetUser.role,
        email: targetUser.email,
        phone: targetUser.phone || "N/A",
        employeeId: targetUser.employeeId || "N/A",
        status: targetUser.status,
        reportingChain,
      };

      // ==================== ROLE-SPECIFIC CALCULATIONS ====================
      let totals = {};
      let totalDisbursed = 0;
      let totalIncentivesPaid = 0;
      let performance = "0.00";
      let assignedTargetValue = { targetValue: 0, achievedValue: 0 };
      const scope = targetUser.role;
      let appMatchBase = {};
      let partnerIdsForScope = [];

      // ASM Analytics
      if (targetUser.role === ROLES.ASM) {
        // Get all ACTIVE RMs under this ASM
        const rms = await User.find({
          asmId: id,
          role: ROLES.RM,
          status: "ACTIVE",
        })
          .select("_id")
          .lean();
        const rmIds = rms.map((x) => x._id);

        // Get all ACTIVE partners under these RMs
        const partners = await User.find({
          rmId: { $in: rmIds },
          role: ROLES.PARTNER,
          status: "ACTIVE",
        })
          .select("_id")
          .lean();
        const partnerIds = partners.map((x) => x._id);

        // Get customers
        const customers = await Application.distinct("customerId", {
          partnerId: { $in: partnerIds },
        });

        // Calculate total disbursed - include all applications from Partners under ASM
        const disbursedAggASM = await Application.aggregate([
          {
            $match: {
              status: "DISBURSED",
              ...(partnerIds.length > 0 ? { partnerId: { $in: partnerIds.map(pId => new mongoose.Types.ObjectId(pId)) } } : {}),
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } } },
            },
          },
        ]);
        totalDisbursed = disbursedAggASM.length > 0 ? Number(disbursedAggASM[0].total || 0) : 0;

        appMatchBase = partnerIds.length > 0
          ? { partnerId: { $in: partnerIds.map((pId) => new mongoose.Types.ObjectId(pId)) } }
          : {};
        partnerIdsForScope = partnerIds.map((pId) => new mongoose.Types.ObjectId(pId));

        // Get assigned target
        assignedTargetValue = await getAssignedTarget(targetUser._id, ROLES.ASM, {
          partnerId: { $in: partnerIds },
        });

        // Total incentives paid to partners under this ASM
        totalIncentivesPaid = await sumIncentivesPaidByPartners({
          partnerId: { $in: partnerIds },
        });

        // Calculate performance
        performance =
          assignedTargetValue.targetValue > 0
            ? ((assignedTargetValue.achievedValue / assignedTargetValue.targetValue) * 100).toFixed(2)
            : "0.00";

        totals = {
          rms: rmIds.length,
          partners: partnerIds.length,
          customers: customers.length,
        };
      }

      // RSM Analytics
      else if (targetUser.role === ROLES.RSM) {
        // Get all ACTIVE RMs under this RSM
        const rms = await User.find({
          role: ROLES.RM,
          $or: [
            { personalRsmId: id },
            { businessHomeRsmId: id },
          ],
          status: "ACTIVE",
        })
          .select("_id")
          .lean();
        const rmIds = rms.map((x) => x._id);

        // Get all ACTIVE partners under these RMs
        const partners = await User.find({
          rmId: { $in: rmIds },
          role: ROLES.PARTNER,
          status: "ACTIVE",
        })
          .select("_id")
          .lean();
        const partnerIds = partners.map((x) => x._id);

        // Get customers
        const customers = await Application.distinct("customerId", {
          $or: [
            { rsmId: id },
            { rmId: { $in: rmIds } },
            { partnerId: { $in: partnerIds } },
          ],
        });

        // Calculate total disbursed - include all applications from RSM, RMs, and Partners
        // Use aggregation to sum all disbursed amounts from the entire hierarchy
        const disbursedAgg = await Application.aggregate([
          {
            $match: {
              status: "DISBURSED",
              $or: [
                { rsmId: new mongoose.Types.ObjectId(id) },
                ...(rmIds.length > 0 ? [{ rmId: { $in: rmIds.map(rmId => new mongoose.Types.ObjectId(rmId)) } }] : []),
                ...(partnerIds.length > 0 ? [{ partnerId: { $in: partnerIds.map(pId => new mongoose.Types.ObjectId(pId)) } }] : []),
              ],
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } } },
            },
          },
        ]);
        totalDisbursed = disbursedAgg.length > 0 ? Number(disbursedAgg[0].total || 0) : 0;

        appMatchBase = {
          $or: [
            { rsmId: new mongoose.Types.ObjectId(id) },
            ...(rmIds.length > 0
              ? [{ rmId: { $in: rmIds.map((rmId) => new mongoose.Types.ObjectId(rmId)) } }]
              : []),
            ...(partnerIds.length > 0
              ? [{ partnerId: { $in: partnerIds.map((pId) => new mongoose.Types.ObjectId(pId)) } }]
              : []),
          ],
        };
        partnerIdsForScope = partnerIds.map((pId) => new mongoose.Types.ObjectId(pId));

        // Get assigned target
        assignedTargetValue = await getAssignedTarget(targetUser._id, ROLES.RSM, {
          $or: [
            { rsmId: id },
            { rmId: { $in: rmIds } },
            { partnerId: { $in: partnerIds } },
          ],
        });

        // Total incentives paid to partners under this RSM
        totalIncentivesPaid = await sumIncentivesPaidByPartners({
          partnerId: { $in: partnerIds },
        });

        // Calculate performance
        performance =
          assignedTargetValue.targetValue > 0
            ? ((assignedTargetValue.achievedValue / assignedTargetValue.targetValue) * 100).toFixed(2)
            : "0.00";

        totals = {
          rms: rmIds.length,
          partners: partnerIds.length,
          customers: customers.length,
        };
      }

      // RM Analytics
      else if (targetUser.role === ROLES.RM) {
        // Get all ACTIVE partners under this RM
        const partners = await User.find({
          rmId: id,
          role: ROLES.PARTNER,
          status: "ACTIVE",
        })
          .select("_id")
          .lean();
        const partnerIds = partners.map((x) => x._id);

        // Get customers
        const customers = await Application.distinct("customerId", {
          partnerId: { $in: partnerIds },
        });

        // Calculate total disbursed - include all applications from Partners under this RM
        const disbursedAggRM = await Application.aggregate([
          {
            $match: {
              status: "DISBURSED",
              ...(partnerIds.length > 0 ? { partnerId: { $in: partnerIds.map(pId => new mongoose.Types.ObjectId(pId)) } } : {}),
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } } },
            },
          },
        ]);
        totalDisbursed = disbursedAggRM.length > 0 ? Number(disbursedAggRM[0].total || 0) : 0;

        appMatchBase = partnerIds.length > 0
          ? { partnerId: { $in: partnerIds.map((pId) => new mongoose.Types.ObjectId(pId)) } }
          : {};
        partnerIdsForScope = partnerIds.map((pId) => new mongoose.Types.ObjectId(pId));

        // Get assigned target
        assignedTargetValue = await getAssignedTarget(targetUser._id, ROLES.RM, {
          partnerId: { $in: partnerIds },
        });

        // Total incentives paid to partners under this RM
        totalIncentivesPaid = await sumIncentivesPaidByPartners({
          partnerId: { $in: partnerIds },
        });

        // Calculate performance
        performance =
          assignedTargetValue.targetValue > 0
            ? ((assignedTargetValue.achievedValue / assignedTargetValue.targetValue) * 100).toFixed(2)
            : "0.00";

        totals = {
          partners: partnerIds.length,
          customers: customers.length,
        };
      }

      // Partner Analytics
      else if (targetUser.role === ROLES.PARTNER) {
        // Get customers
        const customers = await Application.distinct("customerId", {
          partnerId: id,
        });

        // Calculate total disbursed - include all applications from this Partner
        const disbursedAgg = await Application.aggregate([
          {
            $match: {
              status: "DISBURSED",
              partnerId: new mongoose.Types.ObjectId(id),
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: { $ifNull: ["$approvedLoanAmount", 0] } } },
            },
          },
        ]);
        totalDisbursed = disbursedAgg.length > 0 ? Number(disbursedAgg[0].total || 0) : 0;

        appMatchBase = { partnerId: new mongoose.Types.ObjectId(id) };
        partnerIdsForScope = [new mongoose.Types.ObjectId(id)];

        // Get assigned target
        assignedTargetValue = await getAssignedTarget(targetUser._id, ROLES.PARTNER, {
          partnerId: id,
        });

        // Total incentives paid to this Partner
        totalIncentivesPaid = await sumIncentivesPaidByPartners({
          partnerId: new mongoose.Types.ObjectId(id),
        });

        // Calculate performance
        performance =
          assignedTargetValue.targetValue > 0
            ? ((assignedTargetValue.achievedValue / assignedTargetValue.targetValue) * 100).toFixed(2)
            : "0.00";

        totals = {
          customers: customers.length,
        };
      }

      // Customer Analytics (if needed)
      else if (targetUser.role === ROLES.CUSTOMER) {
        totalDisbursed = await sumDisbursedBy({ customerId: id });
        assignedTargetValue = { targetValue: 0, achievedValue: 0 };
        performance = undefined;
        totals = {};
        appMatchBase = { customerId: new mongoose.Types.ObjectId(id) };
        partnerIdsForScope = [];
      }

      // ==================== Monthly History (12 months) ====================
      const now = new Date();
      const targetYear = year ? parseInt(year, 10) : now.getFullYear();
      const targetYearSafe = Number.isFinite(targetYear) ? targetYear : now.getFullYear();

      const monthlyPerformance = [];
      for (let month = 1; month <= 12; month++) {
        // Target for this month
        const t = await Target.findOne({
          assignedTo: targetUser._id,
          role: scope,
          month,
          year: targetYearSafe,
        }).lean();

        const monthStart = new Date(targetYearSafe, month - 1, 1);
        const monthEnd = new Date(targetYearSafe, month, 1);

        const match = {
          ...appMatchBase,
          status: "DISBURSED",
          $expr: {
            $and: [
              {
                $eq: [
                  { $month: { $ifNull: ["$disbursedDate", "$createdAt"] } },
                  month,
                ],
              },
              {
                $eq: [
                  { $year: { $ifNull: ["$disbursedDate", "$createdAt"] } },
                  targetYearSafe,
                ],
              },
            ],
          },
        };

        const agg = await Application.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: "$approvedLoanAmount" } },
            },
          },
        ]);

        const achievedValue =
          agg.length > 0 && agg[0].total ? Number(agg[0].total) : 0;
        const targetValue = t
          ? Number(t.disbursementTarget || t.targetValue || 0)
          : 0;

        monthlyPerformance.push({
          month,
          year: targetYearSafe,
          targetValue,
          achievedValue,
        });
      }

      // ==================== RESPONSE ====================
      return res.json({
        data: {
          profile: base,
          analytics: {
            scope,
            totals,
            assignedTarget: assignedTargetValue,
            totalDisbursed,
            totalIncentivesPaid,
            monthlyPerformance,
            performance:
              scope === ROLES.ASM || scope === ROLES.RSM || scope === ROLES.RM || scope === ROLES.PARTNER
                ? `${performance}%`
                : undefined,
          },
        },
      });
    } catch (err) {
      console.error("Universal analytics error:", err);
      res.status(500).json({ message: "Failed to fetch analytics" });
    }
  }
);

/**
 * Proper analytics API: KPI summary + funnel + conversion + financials + SLA (basic).
 * GET /api/analytics/:id/kpis?start=YYYY-MM-DD&end=YYYY-MM-DD&loanType=...
 */
router.get("/:id/kpis", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const requesterId = req.user.sub;
    const requesterRole = req.user.role;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const targetUser = await User.findById(id).lean();
    if (!targetUser) return res.status(404).json({ message: "User not found" });

    try {
      await enforceHierarchyAccess({ requesterId, requesterRole, targetUser });
    } catch (e) {
      return res.status(e.statusCode || 403).json({ message: e.message || "Forbidden" });
    }

    if (targetUser.status === "SUSPENDED") {
      return res.json({
        data: {
          profile: {
            userId: targetUser._id,
            name: `${targetUser.firstName} ${targetUser.lastName}`,
            role: targetUser.role,
            status: targetUser.status,
          },
          kpis: {
            funnel: {},
            conversion: {},
            statusDistribution: {},
            financials: { payouts: {}, incentives: {} },
            sla: {},
          },
        },
      });
    }

    const { startDate, endDate } = parseDateRange(req);
    const loanTypeFilter = buildLoanTypeFilter(req);

    const { appMatchBase, partnerIds } = await buildScopeMatch({
      targetUserId: targetUser._id,
      targetRole: targetUser.role,
    });

    // -------------------- Funnel + status distribution --------------------
    // For operational consistency, we time-slice statuses by updatedAt (same idea used in incentives routes).
    const timeFilter = buildUpdatedAtRangeFilter(startDate, endDate);

    const statusAgg = await Application.aggregate([
      {
        $match: {
          ...appMatchBase,
          ...loanTypeFilter,
          ...timeFilter,
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    const statusDistribution = {};
    statusAgg.forEach((row) => {
      statusDistribution[row._id || "UNKNOWN"] = Number(row.count || 0);
    });

    // Funnel: map platform statuses into investor-friendly stages
    const funnel = {
      lead: 0, // not stored as a dedicated entity currently
      application: 0,
      approved: Number(statusDistribution.APPROVED || 0),
      disbursed: Number(statusDistribution.DISBURSED || 0),
      rejected: Number(statusDistribution.REJECTED || 0),
    };
    // "Application" stage includes everything that is not draft? Keep simple and transparent
    const applicationLikeStatuses = [
      "SUBMITTED",
      "DOC_INCOMPLETE",
      "DOC_COMPLETE",
      "LOGIN",
      "DOC_SUBMITTED",
      "UNDER_REVIEW",
      "APPROVED",
      "AGREEMENT",
      "DISBURSED",
      "REJECTED",
    ];
    funnel.application = applicationLikeStatuses.reduce(
      (sum, s) => sum + Number(statusDistribution[s] || 0),
      0
    );

    // Conversion rates (stage-to-stage)
    const safeRate = (num, den) => (den > 0 ? Number(((num / den) * 100).toFixed(2)) : 0);
    const conversion = {
      application_to_approved_pct: safeRate(funnel.approved, funnel.application),
      approved_to_disbursed_pct: safeRate(funnel.disbursed, funnel.approved),
      application_to_disbursed_pct: safeRate(funnel.disbursed, funnel.application),
      application_to_rejected_pct: safeRate(funnel.rejected, funnel.application),
    };

    // -------------------- Financials: payouts + incentives --------------------
    const partnerIdFilter = partnerIds.length ? { partnerId: { $in: partnerIds } } : {};

    const payoutAgg = await Payout.aggregate([
      {
        $match: {
          ...partnerIdFilter,
          ...(startDate || endDate ? buildUpdatedAtRangeFilter(startDate, endDate) : {}),
        },
      },
      {
        $group: {
          _id: "$payOutStatus",
          totalAmount: { $sum: { $toDouble: { $ifNull: ["$amount", 0] } } },
          count: { $sum: 1 },
        },
      },
    ]);

    const payouts = {};
    payoutAgg.forEach((r) => {
      payouts[r._id || "UNKNOWN"] = {
        amount: Number(r.totalAmount || 0),
        count: Number(r.count || 0),
      };
    });

    // Incentives: time slice by month/year if provided, else by createdAt range if start/end passed
    const incentiveMatch = {
      ...partnerIdFilter,
      ...(startDate || endDate ? buildCreatedAtRangeFilter(startDate, endDate) : {}),
    };

    const incentiveAgg = await Incentive.aggregate([
      { $match: incentiveMatch },
      {
        $group: {
          _id: "$status",
          totalAmount: { $sum: { $toDouble: { $ifNull: ["$amount", 0] } } },
          count: { $sum: 1 },
        },
      },
    ]);

    const incentives = {};
    incentiveAgg.forEach((r) => {
      incentives[r._id || "UNKNOWN"] = {
        amount: Number(r.totalAmount || 0),
        count: Number(r.count || 0),
      };
    });

    const financials = {
      payouts,
      incentives,
      totalOutflow: {
        payouts: Object.values(payouts).reduce((s, x) => s + Number(x.amount || 0), 0),
        incentives: Object.values(incentives).reduce((s, x) => s + Number(x.amount || 0), 0),
      },
    };

    // -------------------- SLA (basic) --------------------
    // Provide practical operational SLAs without heavy stageHistory parsing:
    // - avg days from createdAt to DISBURSED (for disbursed apps in range)
    // - aging buckets for open applications by status
    const disbursedSlaAgg = await Application.aggregate([
      {
        $match: {
          ...appMatchBase,
          ...loanTypeFilter,
          status: "DISBURSED",
          ...(startDate || endDate ? buildUpdatedAtRangeFilter(startDate, endDate) : {}),
        },
      },
      {
        $project: {
          days: {
            $dateDiff: {
              startDate: "$createdAt",
              endDate: { $ifNull: ["$updatedAt", "$createdAt"] },
              unit: "day",
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          avgDays: { $avg: "$days" },
          count: { $sum: 1 },
        },
      },
    ]);

    const disbursedSla = disbursedSlaAgg[0]
      ? {
          count: Number(disbursedSlaAgg[0].count || 0),
          avgDays: Number((disbursedSlaAgg[0].avgDays || 0).toFixed(2)),
          // Median intentionally omitted for Mongo compatibility (avoid $percentile dependency).
          // If you want median later, we can compute it using a snapshot table or offline rollups.
          medianDays: null,
        }
      : { count: 0, avgDays: 0, medianDays: null };

    // "Open" = anything not yet closed (DISBURSED/REJECTED).
    // Include all in-flight statuses present in Application.APP_STATUSES.
    const openStatuses = [
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
    const agingAgg = await Application.aggregate([
      {
        $match: {
          ...appMatchBase,
          ...loanTypeFilter,
          status: { $in: openStatuses },
          // For "open aging", slicing by createdAt is more intuitive than updatedAt:
          // it answers "how many open apps were created in this period, and how old are they now?"
          ...(startDate || endDate ? buildCreatedAtRangeFilter(startDate, endDate) : {}),
        },
      },
      {
        $project: {
          status: 1,
          ageDays: {
            // Age since application creation (more intuitive "pending for X days")
            $dateDiff: { startDate: "$createdAt", endDate: "$$NOW", unit: "day" },
          },
        },
      },
      {
        $group: {
          _id: "$status",
          lt3: { $sum: { $cond: [{ $lt: ["$ageDays", 3] }, 1, 0] } },
          d3to7: {
            $sum: { $cond: [{ $and: [{ $gte: ["$ageDays", 3] }, { $lt: ["$ageDays", 7] }] }, 1, 0] },
          },
          d7to14: {
            $sum: { $cond: [{ $and: [{ $gte: ["$ageDays", 7] }, { $lt: ["$ageDays", 14] }] }, 1, 0] },
          },
          gte14: { $sum: { $cond: [{ $gte: ["$ageDays", 14] }, 1, 0] } },
        },
      },
    ]);

    const aging = {};
    let openCount = 0;
    agingAgg.forEach((r) => {
      const row = {
        lt3: Number(r.lt3 || 0),
        d3to7: Number(r.d3to7 || 0),
        d7to14: Number(r.d7to14 || 0),
        gte14: Number(r.gte14 || 0),
      };
      aging[r._id] = row;
      openCount += row.lt3 + row.d3to7 + row.d7to14 + row.gte14;
    });

    const sla = { disbursedSla, openCount, openStatuses, aging };

    return res.json({
      data: {
        profile: {
          userId: targetUser._id,
          name: `${targetUser.firstName} ${targetUser.lastName}`,
          role: targetUser.role,
          status: targetUser.status,
        },
        kpis: {
          scope: targetUser.role,
          filters: {
            start: startDate ? startDate.toISOString() : null,
            end: endDate ? endDate.toISOString() : null,
            loanType: req.query.loanType ? String(req.query.loanType) : null,
          },
          statusDistribution,
          funnel,
          conversion,
          financials,
          sla,
          notes: {
            lead: "Lead is not stored as a dedicated entity yet. Funnel starts from Application statuses.",
            timeSlicing: "StatusDistribution/Funnel are time-sliced by Application.updatedAt (status change time).",
          },
        },
      },
    });
  } catch (err) {
    console.error("Analytics KPIs error:", err);
    return res.status(500).json({ message: "Failed to fetch analytics KPIs" });
  }
});

export default router;

