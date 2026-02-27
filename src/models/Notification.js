// models/Notification.js
import mongoose from "mongoose";

/**
 * Notification Model - Stores all notifications for users
 * 
 * This model persists all notifications in MongoDB, ensuring they survive page reloads
 * and are available across devices. Notifications are created on the backend when
 * events occur (application status changes, document updates, etc.)
 */
const NotificationSchema = new mongoose.Schema(
  {
    // User who receives this notification
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
      index: true,
    },
    
    // Notification type
    type: {
      type: String,
      enum: [
        "application",    // Application status changes
        "document",       // Document status changes
        "partner",         // Partner status changes
        "payout",          // Payout status changes
        "registration",    // New partner/customer registrations
        "target",          // Target assignments/updates
        "info",            // General information
        "success",         // Success messages
        "error",           // Error messages
        "warning",         // Warning messages
      ],
      required: [true, "Notification type is required"],
      index: true,
    },
    
    // Notification title
    title: { 
      type: String, 
      required: [true, "Notification title is required"],
      trim: true,
      maxlength: 200,
    },
    
    // Notification message/content
    message: { 
      type: String, 
      required: [true, "Notification message is required"],
      trim: true,
      maxlength: 1000,
    },
    
    // Read status
    read: { 
      type: Boolean, 
      default: false,
      index: true,
    },
    
    // When notification was created
    timestamp: { 
      type: Date, 
      default: Date.now, 
      index: true,
      required: true,
    },
    
    // Additional data stored as JSON (flexible structure)
    data: { 
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    
    // Who performed the action that triggered this notification
    actionBy: {
      type: {
        _id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        name: String,
        role: String,
        email: String,
        employeeId: String,
      },
      _id: false,
      default: null,
    },
    
    // Loan/Application related information
    loanInfo: {
      type: {
        appNo: String,              // Application number
        loanType: String,            // Type of loan
        customerName: String,       // Customer name
        docType: String,             // Document type (for document notifications)
        applicationId: mongoose.Schema.Types.ObjectId, // Reference to application
      },
      _id: false,
      default: null,
    },
    
    // Unique identifier for deduplication
    // Format: {applicationId}_{status}_{timestamp} or {applicationId}_{docType}_{status}_{timestamp}
    notificationId: { 
      type: String, 
      index: true,
      sparse: true, // Allows null/undefined values
    },
    
    // Priority level (optional, for future use)
    priority: {
      type: String,
      enum: ["low", "normal", "high", "urgent"],
      default: "normal",
    },
    
    // Category for grouping notifications
    category: {
      type: String,
      enum: ["loan", "document", "partner", "payout", "system", "other"],
      default: "other",
    },
    
    // Link/action URL (optional, for future use)
    actionUrl: {
      type: String,
      default: null,
    },
    
    // Expiration date (optional, for time-sensitive notifications)
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { 
    timestamps: true, // Adds createdAt and updatedAt automatically
    collection: "notifications", // Explicit collection name
  }
);

// ========== INDEXES ==========

// Compound index for efficient queries: Get unread notifications for a user, sorted by timestamp
NotificationSchema.index({ userId: 1, read: 1, timestamp: -1 });

// Unique index for deduplication: Prevent duplicate notifications per user
NotificationSchema.index(
  { userId: 1, notificationId: 1 }, 
  { 
    unique: true, 
    sparse: true, // Only index documents that have notificationId
    name: "unique_user_notification",
  }
);

// Index for type-based queries
NotificationSchema.index({ userId: 1, type: 1, timestamp: -1 });

// Index for category-based queries
NotificationSchema.index({ userId: 1, category: 1, timestamp: -1 });

// Index for expiration cleanup
NotificationSchema.index({ expiresAt: 1 }, { sparse: true });

// ========== STATIC METHODS ==========

/**
 * Cleanup old notifications (older than specified days)
 * @param {number} days - Number of days to keep (default: 30)
 * @returns {Promise<Object>} - Delete result
 */
NotificationSchema.statics.cleanupOldNotifications = async function (days = 30) {
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await this.deleteMany({ 
    timestamp: { $lt: cutoffDate },
    read: true, // Only delete read notifications
  });
  console.log(`🧹 Cleaned up ${result.deletedCount} old notifications (older than ${days} days)`);
  return result;
};

/**
 * Get unread count for a user
 * @param {ObjectId} userId - User ID
 * @returns {Promise<number>} - Unread count
 */
NotificationSchema.statics.getUnreadCount = async function (userId) {
  return await this.countDocuments({ 
    userId, 
    read: false,
    $or: [
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } }
    ],
  });
};

/**
 * Mark all notifications as read for a user
 * @param {ObjectId} userId - User ID
 * @returns {Promise<Object>} - Update result
 */
NotificationSchema.statics.markAllAsRead = async function (userId) {
  const result = await this.updateMany(
    { userId, read: false },
    { read: true, updatedAt: new Date() }
  );
  return result;
};

/**
 * Delete all notifications for a user
 * @param {ObjectId} userId - User ID
 * @returns {Promise<Object>} - Delete result
 */
NotificationSchema.statics.deleteAllForUser = async function (userId) {
  const result = await this.deleteMany({ userId });
  return result;
};

/**
 * Get notifications for a user with pagination
 * @param {ObjectId} userId - User ID
 * @param {Object} options - Query options { limit, skip, read, type, category }
 * @returns {Promise<Array>} - Notifications array
 */
NotificationSchema.statics.getUserNotifications = async function (userId, options = {}) {
  const {
    limit = 100,
    skip = 0,
    read = null, // null = all, true = read only, false = unread only
    type = null,
    category = null,
  } = options;

  const query = { userId };

  // Filter by read status
  if (read !== null) {
    query.read = read;
  }

  // Filter by type
  if (type) {
    query.type = type;
  }

  // Filter by category
  if (category) {
    query.category = category;
  }

  // Exclude expired notifications
  query.$or = [
    { expiresAt: null },
    { expiresAt: { $gt: new Date() } }
  ];

  return await this.find(query)
    .sort({ timestamp: -1 })
    .limit(parseInt(limit))
    .skip(parseInt(skip))
    .lean();
};

// ========== INSTANCE METHODS ==========

/**
 * Mark notification as read
 */
NotificationSchema.methods.markAsRead = async function () {
  this.read = true;
  this.updatedAt = new Date();
  return await this.save();
};

/**
 * Check if notification is expired
 */
NotificationSchema.methods.isExpired = function () {
  if (!this.expiresAt) return false;
  return new Date() > this.expiresAt;
};

// ========== PRE-SAVE HOOKS ==========

// Validate notificationId format before saving
NotificationSchema.pre("save", function (next) {
  // If notificationId is provided, ensure it's a string
  if (this.notificationId && typeof this.notificationId !== "string") {
    this.notificationId = String(this.notificationId);
  }
  next();
});

// ========== POST-SAVE HOOKS ==========

// Log notification creation (for debugging)
NotificationSchema.post("save", function (doc) {
  console.log(`✅ Notification saved: ${doc.type} for user ${doc.userId} - ID: ${doc._id}`);
});

// ========== VIRTUAL FIELDS ==========

// Virtual for formatted time
NotificationSchema.virtual("formattedTime").get(function () {
  return this.timestamp ? new Date(this.timestamp).toLocaleString() : null;
});

// Virtual for time ago
NotificationSchema.virtual("timeAgo").get(function () {
  if (!this.timestamp) return null;
  const now = new Date();
  const diff = now - this.timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(this.timestamp).toLocaleDateString();
});

// Enable virtual fields in JSON
NotificationSchema.set("toJSON", { virtuals: true });
NotificationSchema.set("toObject", { virtuals: true });

// ========== EXPORT ==========

export const Notification = mongoose.model("Notification", NotificationSchema);
