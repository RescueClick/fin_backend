// routes/notification.routes.js
import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { Notification } from "../models/Notification.js";
import { Application } from "../models/Application.js";
import { User } from "../models/User.js";
import { Payout } from "../models/Payout.js";
import { DeleteAccountRequest } from "../models/DeleteAccountRequest.js";
import { Incentive } from "../models/Incentive.js";
import { activeApplicationsFilter } from "../utils/activeApplicationsFilter.js";

const router = Router();

// GET /api/notifications - Get all notifications for the current user
// Optimized to use indexed queries instead of scanning the whole collection.
router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user.sub;

    if (!userId) {
      return res.status(400).json({ message: "User ID not found" });
    }

    const { limit = 200, skip = 0 } = req.query;

    const mongoose = await import("mongoose");
    const isValid = mongoose.default.Types.ObjectId.isValid(userId);

    if (!isValid) {
      return res.status(400).json({ message: "Invalid user ID format" });
    }

    const userIdObjectId =
      typeof userId === "string"
        ? new mongoose.default.Types.ObjectId(userId)
        : userId;

    // Use model helper for efficient, indexed query
    const notifications = await Notification.getUserNotifications(
      userIdObjectId,
      {
        limit,
        skip,
      }
    );

    const [unreadCount, totalCount] = await Promise.all([
      Notification.getUnreadCount(userIdObjectId),
      Notification.countDocuments({ userId: userIdObjectId }),
    ]);

    res.json({
      notifications,
      unreadCount,
      total: totalCount,
      returned: notifications.length,
    });
  } catch (error) {
    console.error("❌ Error fetching notifications:", error);
    res.status(500).json({
      message: "Failed to fetch notifications",
      error: error.message,
    });
  }
});

// POST /api/notifications - Create a new notification
router.post("/", auth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const {
      type,
      title,
      message,
      data,
      actionBy,
      loanInfo,
      notificationId,
      timestamp,
    } = req.body;

    // Check if notification with same notificationId already exists (deduplication)
    if (notificationId) {
      const existing = await Notification.findOne({
        userId,
        notificationId,
      });

      if (existing) {
        console.log("⚠️ Duplicate notification detected, skipping:", notificationId);
        return res.json({
          message: "Notification already exists",
          notification: existing,
        });
      }
    }

    const notification = new Notification({
      userId,
      type: type || "info",
      title: title || "Notification",
      message: message || "You have a new notification",
      read: false,
      timestamp: timestamp || new Date(),
      data,
      actionBy,
      loanInfo,
      notificationId: notificationId || `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    });

    await notification.save();

    res.status(201).json({
      message: "Notification created successfully",
      notification,
    });
  } catch (error) {
    console.error("Error creating notification:", error);
    res.status(500).json({ message: "Failed to create notification" });
  }
});

// PUT /api/notifications/:id/read - Mark notification as read
router.put("/:id/read", auth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.json({
      message: "Notification marked as read",
      notification,
    });
  } catch (error) {
    console.error("Error updating notification:", error);
    res.status(500).json({ message: "Failed to update notification" });
  }
});

// PUT /api/notifications/read-all - Mark all notifications as read
router.put("/read-all", auth, async (req, res) => {
  try {
    const userId = req.user.sub;

    const result = await Notification.updateMany(
      { userId, read: false },
      { read: true }
    );

    res.json({
      message: "All notifications marked as read",
      updatedCount: result.modifiedCount,
    });
  } catch (error) {
    console.error("Error marking all as read:", error);
    res.status(500).json({ message: "Failed to mark all as read" });
  }
});

// DELETE /api/notifications/:id - Delete a notification
router.delete("/:id", auth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { id } = req.params;

    const notification = await Notification.findOneAndDelete({
      _id: id,
      userId,
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.json({
      message: "Notification deleted successfully",
      id: notification._id,
    });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({ message: "Failed to delete notification" });
  }
});

// DELETE /api/notifications - Delete all notifications
router.delete("/", auth, async (req, res) => {
  try {
    const userId = req.user.sub;

    const result = await Notification.deleteMany({ userId });

    res.json({
      message: "All notifications deleted successfully",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error deleting all notifications:", error);
    res.status(500).json({ message: "Failed to delete all notifications" });
  }
});

// GET /api/notifications/unread-count - Get unread count
router.get("/unread-count", auth, async (req, res) => {
  try {
    const userId = req.user.sub;
    
    if (!userId) {
      return res.status(400).json({ message: "User ID not found" });
    }

    // Ensure userId is ObjectId
    const mongoose = await import("mongoose");
    const userIdObjectId = mongoose.default.Types.ObjectId.isValid(userId) 
      ? (typeof userId === 'string' ? new mongoose.default.Types.ObjectId(userId) : userId)
      : null;

    if (!userIdObjectId) {
      return res.status(400).json({ message: "Invalid user ID format" });
    }

    const unreadCount = await Notification.countDocuments({
      userId: userIdObjectId,
      read: false,
    });

    res.json({ unreadCount });
  } catch (error) {
    console.error("Error fetching unread count:", error);
    res.status(500).json({ message: "Failed to fetch unread count" });
  }
});

// GET /api/notifications/test - Test endpoint to verify notifications are being saved
router.get("/test", auth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const mongoose = await import("mongoose");
    
    // Ensure userId is ObjectId
    const userIdObjectId = mongoose.default.Types.ObjectId.isValid(userId) 
      ? (typeof userId === 'string' ? new mongoose.default.Types.ObjectId(userId) : userId)
      : null;

    if (!userIdObjectId) {
      return res.status(400).json({ message: "Invalid user ID format" });
    }

    // Try multiple query formats
    const query1 = await Notification.countDocuments({ userId: userIdObjectId });
    const query2 = await Notification.countDocuments({ userId: userId });
    const query3 = await Notification.countDocuments({ userId: userIdObjectId.toString() });
    const query4 = await Notification.countDocuments({
      $or: [
        { userId: userIdObjectId },
        { userId: userId },
        { userId: userIdObjectId.toString() },
      ]
    });

    // Get latest 5 notifications with flexible query
    const latest = await Notification.find({
      $or: [
        { userId: userIdObjectId },
        { userId: userId },
        { userId: userIdObjectId.toString() },
      ]
    })
      .sort({ timestamp: -1 })
      .limit(5)
      .lean();

    // Get all notifications to see userId formats
    const allSample = await Notification.find({}).limit(10).select('userId').lean();

    res.json({
      userFromToken: {
        userId: userId,
        userIdType: typeof userId,
        userIdObjectId: userIdObjectId.toString(),
      },
      queryResults: {
        withObjectId: query1,
        withString: query2,
        withStringConverted: query3,
        withFlexibleQuery: query4,
      },
      totalCount: query4,
      unreadCount: await Notification.countDocuments({
        $or: [
          { userId: userIdObjectId },
          { userId: userId },
          { userId: userIdObjectId.toString() },
        ],
        read: false,
      }),
      latest: latest.map(n => ({
        _id: n._id,
        userId: n.userId?.toString(),
        userIdType: typeof n.userId,
        type: n.type,
        title: n.title,
        read: n.read,
        timestamp: n.timestamp,
        notificationId: n.notificationId,
      })),
      sampleUserIdsInDB: allSample.map(n => ({
        userId: n.userId?.toString(),
        userIdType: typeof n.userId,
        matches: n.userId?.toString() === userIdObjectId.toString(),
      })),
      message: "Test endpoint - check query results",
    });
  } catch (error) {
    console.error("Error in test endpoint:", error);
    res.status(500).json({ 
      message: "Test failed",
      error: error.message,
    });
  }
});

// GET /api/notifications/sidebar-counts - Calculate exact dynamic action counts for each user role
router.get("/sidebar-counts", auth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const role = String(req.user.role || "").toLowerCase();

    const counts = {
      payout: 0,
      partner: 0,
      application: 0,
      delete_request: 0,
      incentive: 0,
    };

    const mongoose = await import("mongoose");
    const userIdObjectId = mongoose.default.Types.ObjectId.isValid(userId)
      ? new mongoose.default.Types.ObjectId(userId)
      : null;

    if (!userIdObjectId) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    if (role === "admin" || role === "super_admin") {
      // 1. Partner: Count of partners registered with status PENDING (waiting for validation)
      counts.partner = await User.countDocuments({ role: "partner", status: "PENDING" });
      // 2. Payout: Count of payouts in PENDING status
      counts.payout = await Payout.countDocuments({ payOutStatus: "PENDING" });
      // 3. Delete Request: Count of delete account requests in PENDING status
      counts.delete_request = await DeleteAccountRequest.countDocuments({ status: "PENDING" });
    } 
    else if (role === "asm") {
      // ASM specific counts
      // Find all RSMs under this ASM
      const rsms = await User.find({ asmId: userIdObjectId, role: "rsm" }).select("_id");
      const rsmIds = rsms.map(r => r._id);
      
      // Find all RMs under these RSMs
      const rms = await User.find({
        $or: [
          { personalRsmId: { $in: rsmIds } },
          { businessHomeRsmId: { $in: rsmIds } }
        ],
        role: "rm"
      }).select("_id");
      const rmIds = rms.map(r => r._id);
      
      // Find all Partners under these RMs
      const partners = await User.find({ rmId: { $in: rmIds }, role: "partner" }).select("_id");
      const partnerIds = partners.map(p => p._id);
      
      // 1. Payouts: PENDING payouts for those Partners
      counts.payout = await Payout.countDocuments({ partnerId: { $in: partnerIds }, payOutStatus: "PENDING" });
      
      // 2. Incentives: PENDING incentives for those Partners
      counts.incentive = await Incentive.countDocuments({ partnerId: { $in: partnerIds }, status: "PENDING" });

      // 3. Applications: Count of applications assigned/routed to ASM (DOC_SUBMITTED)
      counts.application = await Application.countDocuments(
        activeApplicationsFilter({ asmId: userIdObjectId, status: "DOC_SUBMITTED" })
      );
    }
    else if (role === "rsm") {
      // RSM specific counts
      // 1. Applications: Count of applications in DOC_COMPLETE status assigned to this RSM
      counts.application = await Application.countDocuments(
        activeApplicationsFilter({ rsmId: userIdObjectId, status: "DOC_COMPLETE" })
      );
    }
    else if (role === "rm") {
      // RM specific counts
      // 1. Applications: Count of applications in SUBMITTED or DOC_INCOMPLETE status assigned to this RM
      counts.application = await Application.countDocuments(
        activeApplicationsFilter({ 
          rmId: userIdObjectId, 
          status: { $in: ["SUBMITTED", "DOC_INCOMPLETE"] } 
        })
      );
      // 2. My Partners: Count of partners assigned to this RM with status "PENDING"
      counts.partner = await User.countDocuments({ rmId: userIdObjectId, role: "partner", status: "PENDING" });
    }
    else if (role === "partner") {
      // Partner specific counts
      // 1. Payouts: PENDING payout requests for this partner
      counts.payout = await Payout.countDocuments({ partnerId: userIdObjectId, payOutStatus: "PENDING" });
      // 2. Incentives: PENDING incentives for this partner
      counts.incentive = await Incentive.countDocuments({ partnerId: userIdObjectId, status: "PENDING" });
    }

    res.json(counts);
  } catch (error) {
    console.error("Error calculating sidebar counts:", error);
    res.status(500).json({ message: "Failed to calculate sidebar counts", error: error.message });
  }
});

export default router;
