import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { CallLog } from "../models/CallLog.js";
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";
import { normalizePhoneToTen } from "../utils/phoneNormalize.js";
import { activeUsersFilter } from "../utils/activeUsersFilter.js";
import { activeApplicationsFilter } from "../utils/activeApplicationsFilter.js";

const router = Router();

// POST /api/calls/log — Record a call from Android app or Web dialer
router.post(
  "/log",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM, ROLES.RM),
  async (req, res) => {
    try {
      const {
        targetPhone,
        targetName,
        contactType,
        callType = "OUTGOING",
        callStartTime,
        callEndTime,
        durationSeconds = 0,
        feedback = "",
        notes = "",
        source = "android_native",
      } = req.body;

      const cleanPhone = normalizePhoneToTen(targetPhone);
      if (!cleanPhone || cleanPhone.length !== 10) {
        return res.status(400).json({ message: "A valid 10-digit target phone number is required" });
      }

      const duration = Math.max(0, parseInt(durationSeconds, 10) || 0);
      const isVerifiedRealCall = duration > 0 && (callType === "OUTGOING" || callType === "INCOMING");

      const rmUser = req.user;
      const rmName = `${rmUser.firstName || ""} ${rmUser.lastName || ""}`.trim() || rmUser.name || "RM";

      // Attempt to identify target contact in User or Application
      let contactId = null;
      let identifiedContactType = contactType || "unknown";
      let resolvedTargetName = targetName || "";
      let applicationId = null;

      const userMatch = await User.findOne(
        activeUsersFilter({
          $or: [{ phone: cleanPhone }, { alternatePhone: cleanPhone }],
        })
      )
        .select("_id firstName lastName name role employeeId")
        .lean();

      if (userMatch) {
        contactId = userMatch._id;
        identifiedContactType = userMatch.role === "partner" ? "partner" : "customer";
        if (!resolvedTargetName) {
          resolvedTargetName = `${userMatch.firstName || ""} ${userMatch.lastName || ""}`.trim() || userMatch.name || "";
        }
      } else {
        const appMatch = await Application.findOne(
          activeApplicationsFilter({
            $or: [{ "customer.phone": cleanPhone }, { "customer.alternatePhone": cleanPhone }],
          })
        )
          .select("_id appNo customer.name customer.phone customerId")
          .lean();

        if (appMatch) {
          applicationId = appMatch._id;
          contactId = appMatch.customerId || null;
          identifiedContactType = "customer";
          if (!resolvedTargetName) {
            resolvedTargetName = appMatch.customer?.name || "";
          }
        }
      }

      const log = await CallLog.create({
        rmId: rmUser._id,
        rmName,
        targetPhone: cleanPhone,
        targetName: resolvedTargetName || "Unknown Contact",
        contactType: identifiedContactType,
        contactId,
        applicationId,
        callType: ["OUTGOING", "INCOMING", "MISSED", "REJECTED"].includes(callType) ? callType : "OUTGOING",
        callStartTime: callStartTime ? new Date(callStartTime) : new Date(),
        callEndTime: callEndTime ? new Date(callEndTime) : new Date(),
        durationSeconds: duration,
        isVerifiedRealCall,
        feedback,
        notes,
        source,
      });

      return res.status(201).json({
        success: true,
        message: "Call log saved successfully",
        data: log,
      });
    } catch (err) {
      console.error("Failed to save call log:", err);
      return res.status(500).json({ message: err.message || "Failed to record call log" });
    }
  }
);

// GET /api/calls/admin-logs — Admin / RSM view of all calls with stats & filters
router.get(
  "/admin-logs",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.RSM),
  async (req, res) => {
    try {
      const {
        rmId,
        callType,
        verifiedOnly,
        contactType,
        search,
        startDate,
        endDate,
        page = 1,
        limit = 50,
      } = req.query;

      const filter = {};

      if (rmId && rmId !== "all") {
        filter.rmId = rmId;
      }

      if (callType && callType !== "all") {
        filter.callType = callType;
      }

      if (verifiedOnly === "true") {
        filter.isVerifiedRealCall = true;
      } else if (verifiedOnly === "false") {
        filter.isVerifiedRealCall = false;
      }

      if (contactType && contactType !== "all") {
        filter.contactType = contactType;
      }

      if (startDate || endDate) {
        filter.callStartTime = {};
        if (startDate) filter.callStartTime.$gte = new Date(startDate);
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          filter.callStartTime.$lte = end;
        }
      }

      if (search && search.trim()) {
        const term = search.trim();
        filter.$or = [
          { targetPhone: { $regex: term, $options: "i" } },
          { targetName: { $regex: term, $options: "i" } },
          { rmName: { $regex: term, $options: "i" } },
        ];
      }

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const skip = (pageNum - 1) * limitNum;

      const [logs, total] = await Promise.all([
        CallLog.find(filter)
          .sort({ callStartTime: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        CallLog.countDocuments(filter),
      ]);

      // Calculate aggregate stats for today or the filtered set
      const statsAgg = await CallLog.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalCalls: { $sum: 1 },
            totalDurationSeconds: { $sum: "$durationSeconds" },
            verifiedCalls: {
              $sum: { $cond: ["$isVerifiedRealCall", 1, 0] },
            },
            missedCalls: {
              $sum: { $cond: [{ $eq: ["$callType", "MISSED"] }, 1, 0] },
            },
          },
        },
      ]);

      const stats = statsAgg[0] || {
        totalCalls: total,
        totalDurationSeconds: 0,
        verifiedCalls: 0,
        missedCalls: 0,
      };

      return res.json({
        success: true,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum) || 1,
        stats: {
          totalCalls: stats.totalCalls || 0,
          totalDurationMinutes: Math.round((stats.totalDurationSeconds || 0) / 60),
          verifiedCalls: stats.verifiedCalls || 0,
          missedCalls: stats.missedCalls || 0,
        },
        logs,
      });
    } catch (err) {
      console.error("Failed to fetch admin call logs:", err);
      return res.status(500).json({ message: err.message || "Failed to fetch call logs" });
    }
  }
);

// GET /api/calls/rm-history — RM view of their own recent calls
router.get(
  "/rm-history",
  auth,
  requireRole(ROLES.RM, ROLES.RSM, ROLES.ADMIN, ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const rmId = req.user._id;
      const { limit = 30 } = req.query;

      const logs = await CallLog.find({ rmId })
        .sort({ callStartTime: -1 })
        .limit(Math.min(100, parseInt(limit, 10) || 30))
        .lean();

      return res.json({ success: true, logs });
    } catch (err) {
      console.error("Failed to fetch RM call history:", err);
      return res.status(500).json({ message: err.message || "Failed to fetch call history" });
    }
  }
);

export default router;
