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

const router = express.Router();

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
      // SUPER_ADMIN can view any user's analytics
      if (requesterRole === ROLES.SUPER_ADMIN) {
        // Allow access
      }
      // ASM can only view RSM analytics
      else if (requesterRole === ROLES.ASM) {
        if (targetUser.role !== ROLES.RSM) {
          return res.status(403).json({ 
            message: "ASM can only view RSM analytics" 
          });
        }
        // Verify RSM is under this ASM
        if (targetUser.asmId && targetUser.asmId.toString() !== requesterId) {
          return res.status(403).json({ 
            message: "RSM not found or not under this ASM" 
          });
        }
        // Backward compatibility: Auto-set asmId if missing
        if (!targetUser.asmId) {
          await User.findByIdAndUpdate(id, { asmId: requesterId });
        }
      }
      // RSM can only view RM analytics
      else if (requesterRole === ROLES.RSM) {
        if (targetUser.role !== ROLES.RM) {
          return res.status(403).json({ 
            message: "RSM can only view RM analytics" 
          });
        }
        // Verify RM is under this RSM
        const isUnderRSM = 
          (targetUser.personalRsmId && targetUser.personalRsmId.toString() === requesterId) ||
          (targetUser.businessHomeRsmId && targetUser.businessHomeRsmId.toString() === requesterId);
        
        if (!isUnderRSM) {
          return res.status(403).json({ 
            message: "RM not found or not under this RSM" 
          });
        }
      }
      // RM can only view Partner analytics
      else if (requesterRole === ROLES.RM) {
        if (targetUser.role !== ROLES.PARTNER) {
          return res.status(403).json({ 
            message: "RM can only view Partner analytics" 
          });
        }
        // Verify Partner is under this RM
        if (!targetUser.rmId || targetUser.rmId.toString() !== requesterId) {
          return res.status(403).json({ 
            message: "Partner not found or not under this RM" 
          });
        }
      }
      // PARTNER can only view their own analytics
      else if (requesterRole === ROLES.PARTNER) {
        if (targetUser._id.toString() !== requesterId) {
          return res.status(403).json({ 
            message: "Partners can only view their own analytics" 
          });
        }
      }
      // Unknown role
      else {
        return res.status(403).json({ 
          message: "Unauthorized role" 
        });
      }

      // ⚠️ CRITICAL: If user is SUSPENDED, return zero targets and achievements
      if (targetUser.status === "SUSPENDED") {
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
      const base = {
        userId: targetUser._id,
        name: `${targetUser.firstName} ${targetUser.lastName}`,
        role: targetUser.role,
        email: targetUser.email,
        phone: targetUser.phone || "N/A",
        employeeId: targetUser.employeeId || "N/A",
        status: targetUser.status,
      };

      // ==================== ROLE-SPECIFIC CALCULATIONS ====================
      let totals = {};
      let totalDisbursed = 0;
      let totalIncentivesPaid = 0;
      let performance = "0.00";
      let assignedTargetValue = { targetValue: 0, achievedValue: 0 };
      const scope = targetUser.role;
      let appMatchBase = {};

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

export default router;

