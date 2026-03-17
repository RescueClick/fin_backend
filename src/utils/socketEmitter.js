// Utility to emit socket events from routes
// Import this in your route files to emit socket events
import { createNotification, generateNotificationId } from "./notificationService.js";

export const emitApplicationStatusChanged = async (io, application, oldStatus, newStatus, actionBy = null) => {
  if (!io || !application) {
    console.error("❌ emitApplicationStatusChanged: Missing io or application", { io: !!io, application: !!application });
    return;
  }

  console.log("🔔 emitApplicationStatusChanged called", {
    applicationId: application._id,
    oldStatus,
    newStatus,
    actionBy,
  });

  // Ensure IDs are strings for room names
  // Extract partnerId - handle both populated objects and plain IDs
  let partnerId = null;
  if (application.partnerId) {
    if (application.partnerId._id) {
      partnerId = application.partnerId._id.toString();
    } else {
      partnerId = application.partnerId.toString();
    }
  }
  
  let customerId = null;
  if (application.customerId) {
    if (application.customerId._id) {
      customerId = application.customerId._id.toString();
    } else {
      customerId = application.customerId.toString();
    }
  }
  
  let rmId = null;
  if (application.rmId) {
    if (application.rmId._id) {
      rmId = application.rmId._id.toString();
    } else {
      rmId = application.rmId.toString();
    }
  }
  
  console.log("🔍 Extracted IDs for notifications:", {
    partnerId,
    customerId,
    rmId,
    partnerIdType: typeof partnerId,
    applicationPartnerId: application.partnerId,
    applicationPartnerIdType: typeof application.partnerId,
  });

  console.log("📤 Notification targets:", { partnerId, customerId, rmId });

  // Ensure application is populated if needed
  let appData = application;
  if (application && !application.customerId?.firstName) {
    try {
      const { Application } = await import("../models/Application.js");
      appData = await Application.findById(application._id)
        .populate("customerId", "firstName middleName lastName email phone")
        .populate("partnerId", "firstName lastName email employeeId")
        .populate("rmId", "firstName lastName email employeeId asmId")
        .populate("asmId", "firstName lastName email employeeId")
        .select("appNo loanType appliedLoanAmount approvedLoanAmount status asmId")
        .lean();
    } catch (err) {
      console.error("Error fetching application:", err);
      appData = application;
    }
  }

  // Get ASM ID from RM or Application
  let asmId = null;
  if (appData?.asmId) {
    asmId = appData.asmId._id || appData.asmId;
  } else if (appData?.rmId?.asmId) {
    asmId = appData.rmId.asmId._id || appData.rmId.asmId;
  } else if (rmId) {
    // Fetch RM to get ASM
    try {
      const { User } = await import("../models/User.js");
      const rm = await User.findById(rmId).select("asmId").lean();
      if (rm?.asmId) {
        asmId = rm.asmId;
      }
    } catch (err) {
      console.error("Error fetching RM ASM:", err);
    }
  }

  // Get action performer details if provided
  let actionByData = null;
  if (actionBy) {
    try {
      const { User } = await import("../models/User.js");
      const user = await User.findById(actionBy).select("firstName lastName email employeeId role").lean();
      if (user) {
        actionByData = {
          _id: user._id,
          name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
          email: user.email,
          employeeId: user.employeeId,
          role: user.role,
        };
      }
    } catch (err) {
      console.error("Error fetching actionBy user:", err);
    }
  }

  // Build detailed message with loan/application info
  const loanInfo = appData?.appNo 
    ? `Loan #${appData.appNo} (${appData.loanType || "N/A"})`
    : `Application #${application._id}`;
  
  const customerInfo = appData?.customerId
    ? `Customer: ${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim()
    : "";

  const loanAmount = appData?.appliedLoanAmount 
    ? `Amount: ₹${appData.appliedLoanAmount.toLocaleString()}`
    : "";

  const actionMessage = actionByData 
    ? `${actionByData.name} (${actionByData.role}) changed status from ${oldStatus} to ${newStatus} for ${loanInfo}${customerInfo ? ` - ${customerInfo}` : ""}${loanAmount ? ` - ${loanAmount}` : ""}`
    : `Application status changed from ${oldStatus} to ${newStatus} for ${loanInfo}${customerInfo ? ` - ${customerInfo}` : ""}${loanAmount ? ` - ${loanAmount}` : ""}`;

  // Notify partner - Save to MongoDB first, then emit socket event
  if (partnerId) {
    // Ensure partnerId is properly formatted as ObjectId string for consistency
    const mongoose = await import("mongoose");
    let partnerIdForNotification = partnerId;
    
    // Convert to ObjectId string to ensure consistency with JWT token format
    if (mongoose.default.Types.ObjectId.isValid(partnerId)) {
      partnerIdForNotification = new mongoose.default.Types.ObjectId(partnerId).toString();
    }
    
    console.log(`🔍 Partner notification - Original partnerId: ${partnerId}, Formatted: ${partnerIdForNotification}`);
    
    const partnerRoom = `partner_${String(partnerId)}`;
    const notificationId = generateNotificationId({
      applicationId: application._id,
      status: newStatus,
      timestamp: Date.now(),
      userId: partnerIdForNotification,
      type: "application",
    });

    // Save notification to MongoDB - use the formatted ID
    console.log(`💾 Creating notification for partner: ${partnerIdForNotification} (original: ${partnerId})`);
    const notificationResult = await createNotification(partnerIdForNotification, {
      type: "application",
      title: "Application Status Changed",
      message: actionMessage,
      data: {
        applicationId: application._id,
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        status: newStatus,
        oldStatus,
        actionBy: actionByData,
      },
      actionBy: actionByData,
      loanInfo: {
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
      },
      notificationId,
      timestamp: new Date(),
    });
    
    if (notificationResult) {
      console.log(`✅ Notification created successfully for partner ${partnerId}:`, {
        notificationId: notificationResult._id,
        userId: notificationResult.userId,
        userIdType: typeof notificationResult.userId,
        userIdString: notificationResult.userId?.toString(),
      });
    } else {
      console.error(`❌ Failed to create notification for partner ${partnerId}`);
    }

    // Emit ONLY ONE event - applicationUpdated (frontend will handle it)
    console.log(`📨 [APPLICATION] Emitting to partner room: ${partnerRoom}`, { partnerId, partnerIdType: typeof partnerId });
    io.to(partnerRoom).emit("applicationUpdated", {
      applicationId: application._id,
      status: newStatus,
      oldStatus,
      actionBy: actionByData,
      message: actionMessage,
      notificationId, // Include notificationId so frontend can sync
      application: {
        _id: application._id,
        appNo: appData?.appNo,
        status: appData?.status || application.status,
        loanType: appData?.loanType || application.loanType,
        appliedLoanAmount: appData?.appliedLoanAmount || application.appliedLoanAmount,
        approvedLoanAmount: appData?.approvedLoanAmount || application.approvedLoanAmount,
        customer: appData?.customerId ? {
          name: `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim(),
          email: appData.customerId.email,
          phone: appData.customerId.phone,
        } : null,
      },
      timestamp: new Date(),
    });
  }

  // Notify customer - ONLY LOAN STATUS (no internal details) - Save to MongoDB first
  if (customerId) {
    const customerRoom = `user_${String(customerId)}`;
    const notificationId = generateNotificationId({
      applicationId: application._id,
      status: newStatus,
      timestamp: Date.now(),
      userId: customerId,
      type: "application",
    });
    
    // Customer-friendly message (no internal details about who did what)
    const customerMessage = `Your loan application status has been updated from ${oldStatus} to ${newStatus}${appData?.appNo ? ` for Loan #${appData.appNo}` : ""}${appData?.loanType ? ` (${appData.loanType})` : ""}`;

    // Save notification to MongoDB
    await createNotification(customerId, {
      type: "application",
      title: "Loan Status Updated",
      message: customerMessage,
      data: {
        applicationId: application._id,
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        status: newStatus,
        oldStatus,
      },
      loanInfo: {
        appNo: appData?.appNo,
        loanType: appData?.loanType,
      },
      notificationId,
      timestamp: new Date(),
    });

    // Emit ONLY ONE event
    console.log(`📨 Emitting to customer room: ${customerRoom}`, { customerId, customerIdType: typeof customerId });
    io.to(customerRoom).emit("applicationUpdated", {
      applicationId: application._id,
      status: newStatus,
      oldStatus,
      notificationId, // Include notificationId
      message: customerMessage,
      application: {
        _id: application._id,
        appNo: appData?.appNo,
        status: appData?.status || application.status,
        loanType: appData?.loanType || application.loanType,
        appliedLoanAmount: appData?.appliedLoanAmount || application.appliedLoanAmount,
        approvedLoanAmount: appData?.approvedLoanAmount || application.approvedLoanAmount,
      },
      timestamp: new Date(),
    });
  }

  // DO NOT notify RM of their own actions - RM actions go to Admin, ASM, Partner, Customer only
  // Only notify RM if the action was performed by someone else (e.g., Admin or ASM)
  // Check if RM is performing the action themselves by comparing IDs
  const rmPerformedAction = rmId && actionByData && (
    String(rmId) === String(actionByData._id) || 
    actionByData.role === "RM"
  );
  
  if (rmId && actionByData && !rmPerformedAction) {
    const rmRoom = `rm_${String(rmId)}`;
    const notificationId = generateNotificationId({
      applicationId: application._id,
      status: newStatus,
      timestamp: Date.now(),
      userId: rmId,
      type: "application",
    });

    // Save notification to MongoDB
    await createNotification(rmId, {
      type: "application",
      title: "Application Status Changed",
      message: actionMessage,
      data: {
        applicationId: application._id,
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        status: newStatus,
        oldStatus,
        actionBy: actionByData,
      },
      actionBy: actionByData,
      loanInfo: {
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
      },
      notificationId,
      timestamp: new Date(),
    });

    // Emit ONLY ONE event
    console.log(`📨 Emitting to RM room: ${rmRoom} (action by ${actionByData.role} ${actionByData._id})`);
    io.to(rmRoom).emit("applicationUpdated", {
      applicationId: application._id,
      status: newStatus,
      oldStatus,
      actionBy: actionByData,
      message: actionMessage,
      notificationId,
      application: appData || application,
      timestamp: new Date(),
    });
  } else if (rmPerformedAction) {
    console.log(`⏭️ Skipping RM notification - RM ${actionByData?._id || rmId} performed this action themselves`);
  }

  // Notify ASM (only if RM belongs to this ASM - hierarchy)
  if (asmId) {
    const asmIdStr = String(asmId);
    const asmRoom = `asm_${asmIdStr}`;
    const notificationId = generateNotificationId({
      applicationId: application._id,
      status: newStatus,
      timestamp: Date.now(),
      userId: asmIdStr,
      type: "application",
    });

    // Save notification to MongoDB
    await createNotification(asmIdStr, {
      type: "application",
      title: "Application Status Changed (Your RM)",
      message: actionMessage,
      data: {
        applicationId: application._id,
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        rmName: appData?.rmId ? `${appData.rmId.firstName || ""} ${appData.rmId.lastName || ""}`.trim() : null,
        status: newStatus,
        oldStatus,
        actionBy: actionByData,
      },
      actionBy: actionByData,
      loanInfo: {
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
      },
      notificationId,
      timestamp: new Date(),
    });

    // Emit ONLY ONE event
    console.log(`📨 Emitting to ASM room: ${asmRoom}`, { asmId, asmIdType: typeof asmId });
    io.to(asmRoom).emit("applicationUpdated", {
      applicationId: application._id,
      status: newStatus,
      oldStatus,
      actionBy: actionByData,
      message: actionMessage,
      notificationId,
      application: appData || application,
      timestamp: new Date(),
    });
  }

  // Notify Admin and SUPER_ADMIN - Save to MongoDB for all admin users first
  console.log("📨 Creating notifications for Admin and SUPER_ADMIN");
  
  try {
    const { User } = await import("../models/User.js");
    const { createNotificationsForUsers } = await import("./notificationService.js");
    
    // Get all Admin and SUPER_ADMIN users
    const adminUsers = await User.find({
      role: { $in: ["ADMIN", "SUPER_ADMIN"] }
    }).select("_id").lean();
    
    const adminUserIds = adminUsers.map(u => u._id.toString());
    const notificationId = generateNotificationId({
      applicationId: application._id,
      status: newStatus,
      timestamp: Date.now(),
      type: "application",
    });

    // Save notifications to MongoDB for all admins
    await createNotificationsForUsers(adminUserIds, {
      type: "application",
      title: "Application Status Changed",
      message: actionMessage,
      data: {
        applicationId: application._id,
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        partnerName: appData?.partnerId ? `${appData.partnerId.firstName || ""} ${appData.partnerId.lastName || ""}`.trim() : null,
        rmName: appData?.rmId ? `${appData.rmId.firstName || ""} ${appData.rmId.lastName || ""}`.trim() : null,
        asmName: appData?.asmId ? `${appData.asmId.firstName || ""} ${appData.asmId.lastName || ""}`.trim() : null,
        status: newStatus,
        oldStatus,
        actionBy: actionByData,
      },
      actionBy: actionByData,
      loanInfo: {
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
      },
      notificationId,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("❌ Error creating admin notifications:", error);
  }

  // Emit ONLY ONE event to admin room
  console.log("📨 Emitting to admin room: admin");
  io.to("admin").emit("applicationUpdated", {
    applicationId: application._id,
    status: newStatus,
    oldStatus,
    actionBy: actionByData,
    message: actionMessage,
    notificationId: generateNotificationId({
      applicationId: application._id,
      status: newStatus,
      timestamp: Date.now(),
      type: "application",
    }),
    application: appData || application,
    timestamp: new Date(),
  });

  // Also emit to super_admin room
  io.to("super_admin").emit("applicationUpdated", {
    applicationId: application._id,
    status: newStatus,
    oldStatus,
    actionBy: actionByData,
    message: actionMessage,
    notificationId: generateNotificationId({
      applicationId: application._id,
      status: newStatus,
      timestamp: Date.now(),
      type: "application",
    }),
    application: appData || application,
    timestamp: new Date(),
  });

  console.log("✅ emitApplicationStatusChanged: All notifications sent");
};

export const emitDocumentUploaded = (io, applicationId, docType, partnerId, customerId) => {
  if (!io) return;

  // Notify RM
  io.to(`rm_${partnerId}`).emit("documentUploaded", {
    applicationId,
    docType,
    partnerId,
    customerId,
    timestamp: new Date(),
  });

  // Notify Admin
  io.to("admin").emit("documentUploaded", {
    applicationId,
    docType,
    partnerId,
    customerId,
    timestamp: new Date(),
  });
};

export const emitDocumentStatusChanged = async (io, applicationId, docType, status, updatedBy, partnerId, customerId, actionBy = null, application = null) => {
  if (!io) {
    console.error("❌ emitDocumentStatusChanged: Missing io");
    return;
  }
  
  // Ensure IDs are strings - handle both objects and string IDs
  let partnerIdStr = null;
  let customerIdStr = null;
  
  // Extract partner ID - handle populated object or plain ID
  if (partnerId) {
    if (typeof partnerId === 'object' && partnerId._id) {
      partnerIdStr = String(partnerId._id);
    } else {
      partnerIdStr = String(partnerId);
    }
  }
  
  // Extract customer ID - handle populated object or plain ID
  if (customerId) {
    if (typeof customerId === 'object' && customerId._id) {
      customerIdStr = String(customerId._id);
    } else {
      customerIdStr = String(customerId);
    }
  }
  
  console.log("🔔 emitDocumentStatusChanged called", {
    applicationId,
    docType,
    status,
    partnerId: partnerIdStr,
    customerId: customerIdStr,
    partnerIdInput: partnerId,
    customerIdInput: customerId,
    actionBy,
  });

  // Get application details if not provided
  let appData = application;
  if (!appData && applicationId) {
    try {
      const { Application } = await import("../models/Application.js");
      appData = await Application.findById(applicationId)
        .populate("customerId", "firstName middleName lastName email phone")
        .populate("partnerId", "firstName lastName email employeeId")
        .populate("rmId", "firstName lastName asmId")
        .select("appNo loanType appliedLoanAmount status rmId asmId partnerId customerId")
        .lean();
      // Extract ASM ID from RM if available
      if (appData?.rmId?.asmId) {
        appData.asmId = appData.rmId.asmId;
      }
      // Extract IDs from populated objects if needed (override if not already set)
      if (appData?.partnerId) {
        if (typeof appData.partnerId === 'object' && appData.partnerId._id) {
          partnerIdStr = String(appData.partnerId._id);
        } else if (!partnerIdStr) {
          partnerIdStr = String(appData.partnerId);
        }
      }
      if (appData?.customerId) {
        if (typeof appData.customerId === 'object' && appData.customerId._id) {
          customerIdStr = String(appData.customerId._id);
        } else if (!customerIdStr) {
          customerIdStr = String(appData.customerId);
        }
      }
    } catch (err) {
      console.error("Error fetching application:", err);
    }
  } else if (appData) {
    // Ensure asmId is available in appData
    if (appData.rmId?.asmId) {
      appData.asmId = appData.rmId.asmId;
    }
    // Extract IDs from populated objects if needed (override if not already set)
    if (appData?.partnerId && !partnerIdStr) {
      if (typeof appData.partnerId === 'object' && appData.partnerId._id) {
        partnerIdStr = String(appData.partnerId._id);
      } else {
        partnerIdStr = String(appData.partnerId);
      }
    }
    if (appData?.customerId && !customerIdStr) {
      if (typeof appData.customerId === 'object' && appData.customerId._id) {
        customerIdStr = String(appData.customerId._id);
      } else {
        customerIdStr = String(appData.customerId);
      }
    }
  }
  
  // Final validation - ensure IDs are strings
  if (partnerIdStr && typeof partnerIdStr !== 'string') {
    partnerIdStr = String(partnerIdStr);
  }
  if (customerIdStr && typeof customerIdStr !== 'string') {
    customerIdStr = String(customerIdStr);
  }
  
  console.log("🔔 emitDocumentStatusChanged: Final extracted IDs", {
    partnerIdStr,
    customerIdStr,
    partnerIdStrType: typeof partnerIdStr,
    customerIdStrType: typeof customerIdStr,
  });

  // Get action performer details if provided
  let actionByData = null;
  if (actionBy) {
    try {
      const { User } = await import("../models/User.js");
      const user = await User.findById(actionBy).select("firstName lastName email employeeId role").lean();
      if (user) {
        actionByData = {
          _id: user._id,
          name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
          email: user.email,
          employeeId: user.employeeId,
          role: user.role,
        };
      }
    } catch (err) {
      console.error("Error fetching actionBy user:", err);
    }
  }

  // Get RM ID from application to check if RM is performing the action themselves
  const rmIdFromApp = appData?.rmId?._id?.toString() || appData?.rmId?.toString() || (appData?.rmId ? String(appData.rmId) : null);
  const rmPerformedAction = rmIdFromApp && actionByData && (
    String(rmIdFromApp) === String(actionByData._id) || 
    actionByData.role === "RM"
  );
  
  if (rmPerformedAction) {
    console.log(`⏭️ RM ${actionByData._id} performed this document status change themselves - skipping RM notification`);
  }

  const statusMessages = {
    VERIFIED: "verified",
    REJECTED: "rejected",
    PENDING: "marked as pending",
    UPDATED: "marked as updated",
  };

  // Build detailed message with loan/application info
  const loanInfo = appData 
    ? `Loan #${appData.appNo || applicationId} (${appData.loanType || "N/A"})`
    : `Application #${applicationId}`;
  
  const customerInfo = appData?.customerId
    ? `Customer: ${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim()
    : "";

  const actionMessage = actionByData 
    ? `${actionByData.name} (${actionByData.role}) ${statusMessages[status] || "updated"} the document "${docType}" for ${loanInfo}${customerInfo ? ` - ${customerInfo}` : ""}`
    : `Document "${docType}" status changed to ${status} for ${loanInfo}${customerInfo ? ` - ${customerInfo}` : ""}`;

  // Notify partner - Save to MongoDB first, then emit socket event
  if (partnerIdStr) {
    const partnerRoom = `partner_${String(partnerIdStr)}`;
    const notificationId = generateNotificationId({
      applicationId,
      docType,
      status,
      timestamp: Date.now(),
      userId: partnerIdStr,
      type: "document",
    });

    // Save notification to MongoDB
    await createNotification(partnerIdStr, {
      type: "document",
      title: "Document Status Changed",
      message: actionMessage,
      data: {
        applicationId,
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        docType,
        status,
        actionBy: actionByData,
      },
      actionBy: actionByData,
      loanInfo: {
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        docType,
      },
      notificationId,
      timestamp: new Date(),
    });

    // Emit ONLY ONE event
    console.log(`📨 Emitting documentStatusChanged to partner room: ${partnerRoom}`, { partnerId: partnerIdStr });
    io.to(partnerRoom).emit("documentStatusChanged", {
      applicationId,
      docType,
      status,
      updatedBy,
      actionBy: actionByData,
      message: actionMessage,
      notificationId,
      data: appData ? {
        appNo: appData.appNo,
        loanType: appData.loanType,
        appliedLoanAmount: appData.appliedLoanAmount,
        status: appData.status,
        customerName: appData.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
      } : null,
      application: appData ? {
        appNo: appData.appNo,
        loanType: appData.loanType,
        appliedLoanAmount: appData.appliedLoanAmount,
        status: appData.status,
        customer: appData.customerId ? {
          name: `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim(),
          email: appData.customerId.email,
          phone: appData.customerId.phone,
        } : null,
      } : null,
      timestamp: new Date(),
    });
  }

  // Notify customer - Save to MongoDB first, then emit socket event
  if (customerIdStr) {
    const customerRoom = `user_${String(customerIdStr)}`;
    const notificationId = generateNotificationId({
      applicationId,
      docType,
      status,
      timestamp: Date.now(),
      userId: customerIdStr,
      type: "document",
    });

    // Customer-friendly message
    const customerMessage = `Your document "${docType}" status has been updated to ${status}${appData?.appNo ? ` for Loan #${appData.appNo}` : ""}`;

    // Save notification to MongoDB
    await createNotification(customerIdStr, {
      type: "document",
      title: "Document Status Changed",
      message: customerMessage,
      data: {
        applicationId,
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        docType,
        status,
      },
      loanInfo: {
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        docType,
      },
      notificationId,
      timestamp: new Date(),
    });

    // Emit ONLY ONE event
    console.log(`📨 [DOCUMENT] Emitting documentStatusChanged to customer room: ${customerRoom}`, { customerId: customerIdStr });
    io.to(customerRoom).emit("documentStatusChanged", {
      applicationId,
      docType,
      status,
      updatedBy,
      actionBy: actionByData,
      message: customerMessage,
      notificationId,
      data: appData ? {
        appNo: appData.appNo,
        loanType: appData.loanType,
        appliedLoanAmount: appData.appliedLoanAmount,
        status: appData.status,
        customerName: appData.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
      } : null,
      application: appData ? {
        appNo: appData.appNo,
        loanType: appData.loanType,
        appliedLoanAmount: appData.appliedLoanAmount,
        status: appData.status,
      } : null,
      timestamp: new Date(),
    });
  }

  // Notify Admin and SUPER_ADMIN - Save to MongoDB for all admin users first
  console.log("📨 [DOCUMENT] Creating notifications for Admin and SUPER_ADMIN");
  
  try {
    const { User } = await import("../models/User.js");
    const { createNotificationsForUsers } = await import("./notificationService.js");
    
    // Get all Admin and SUPER_ADMIN users
    const adminUsers = await User.find({
      role: { $in: ["ADMIN", "SUPER_ADMIN"] }
    }).select("_id").lean();
    
    const adminUserIds = adminUsers.map(u => u._id.toString());
    const notificationId = generateNotificationId({
      applicationId,
      docType,
      status,
      timestamp: Date.now(),
      type: "document",
    });

    // Save notifications to MongoDB for all admins
    await createNotificationsForUsers(adminUserIds, {
      type: "document",
      title: "Document Status Changed",
      message: actionMessage,
      data: {
        applicationId,
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        docType,
        status,
        actionBy: actionByData,
      },
      actionBy: actionByData,
      loanInfo: {
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        docType,
      },
      notificationId,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("❌ Error creating admin document notifications:", error);
  }

  // Emit ONLY ONE event to admin room
  console.log("📨 [DOCUMENT] Emitting documentStatusChanged to admin room: admin");
  io.to("admin").emit("documentStatusChanged", {
    applicationId,
    docType,
    status,
    updatedBy,
    actionBy: actionByData,
    message: actionMessage,
    notificationId: generateNotificationId({
      applicationId,
      docType,
      status,
      timestamp: Date.now(),
      type: "document",
    }),
    data: appData ? {
      appNo: appData.appNo,
      loanType: appData.loanType,
      appliedLoanAmount: appData.appliedLoanAmount,
      status: appData.status,
      customerName: appData.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
    } : null,
    application: appData ? {
      appNo: appData.appNo,
      loanType: appData.loanType,
      appliedLoanAmount: appData.appliedLoanAmount,
      status: appData.status,
      customer: appData.customerId ? {
        name: `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim(),
        email: appData.customerId.email,
        phone: appData.customerId.phone,
      } : null,
    } : null,
    timestamp: new Date(),
  });

  // Also emit to super_admin room
  io.to("super_admin").emit("documentStatusChanged", {
    applicationId,
    docType,
    status,
    updatedBy,
    actionBy: actionByData,
    message: actionMessage,
    notificationId: generateNotificationId({
      applicationId,
      docType,
      status,
      timestamp: Date.now(),
      type: "document",
    }),
    data: appData ? {
      appNo: appData.appNo,
      loanType: appData.loanType,
      appliedLoanAmount: appData.appliedLoanAmount,
      status: appData.status,
      customerName: appData.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
    } : null,
    application: appData ? {
      appNo: appData.appNo,
      loanType: appData.loanType,
      appliedLoanAmount: appData.appliedLoanAmount,
      status: appData.status,
      customer: appData.customerId ? {
        name: `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim(),
        email: appData.customerId.email,
        phone: appData.customerId.phone,
      } : null,
    } : null,
    timestamp: new Date(),
  });

  // Notify ASM if application has ASM (hierarchy-based) - Save to MongoDB first
  if (appData?.asmId) {
    const asmIdStr = String(appData.asmId);
    const asmRoom = `asm_${asmIdStr}`;
    const notificationId = generateNotificationId({
      applicationId,
      docType,
      status,
      timestamp: Date.now(),
      userId: asmIdStr,
      type: "document",
    });

    // Save notification to MongoDB
    await createNotification(asmIdStr, {
      type: "document",
      title: "Document Status Changed (Your RM)",
      message: actionMessage,
      data: {
        applicationId,
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        docType,
        status,
        actionBy: actionByData,
      },
      actionBy: actionByData,
      loanInfo: {
        appNo: appData?.appNo,
        loanType: appData?.loanType,
        customerName: appData?.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
        docType,
      },
      notificationId,
      timestamp: new Date(),
    });

    // Emit ONLY ONE event
    console.log(`📨 [DOCUMENT] Emitting documentStatusChanged to ASM room: ${asmRoom}`, { asmId: asmIdStr });
    io.to(asmRoom).emit("documentStatusChanged", {
      applicationId,
      docType,
      status,
      updatedBy,
      actionBy: actionByData,
      message: actionMessage,
      notificationId,
      data: appData ? {
        appNo: appData.appNo,
        loanType: appData.loanType,
        appliedLoanAmount: appData.appliedLoanAmount,
        status: appData.status,
        customerName: appData.customerId ? `${appData.customerId.firstName || ""} ${appData.customerId.middleName || ""} ${appData.customerId.lastName || ""}`.trim() : null,
      } : null,
      application: appData ? {
        appNo: appData.appNo,
        loanType: appData.loanType,
        appliedLoanAmount: appData.appliedLoanAmount,
        status: appData.status,
      } : null,
      timestamp: new Date(),
    });
  }

  // DO NOT notify RM of their own actions - RM actions go to Admin, ASM, Partner, Customer only
  // RM should not receive notifications for actions they perform themselves
  // This check is already done above at the beginning of the function
  // No need to do anything here as rmPerformedAction is already checked

  console.log("✅ emitDocumentStatusChanged: All notifications sent");
};

export const emitPartnerStatusChanged = async (io, partnerId, newStatus, oldStatus) => {
  if (!io) return;

  const partnerIdStr = String(partnerId);
  const notificationId = generateNotificationId({
    applicationId: partnerIdStr,
    status: newStatus,
    timestamp: Date.now(),
    type: "partner",
  });

  const message = `Partner status changed from ${oldStatus} to ${newStatus}`;

  // Save notification to MongoDB for partner
  await createNotification(partnerIdStr, {
    type: "partner",
    title: "Partner Status Changed",
    message: message,
    data: {
      partnerId: partnerIdStr,
      status: newStatus,
      oldStatus,
    },
    notificationId,
    timestamp: new Date(),
  });

  // Save notifications for all Admin and SUPER_ADMIN users
  try {
    const { User } = await import("../models/User.js");
    const { createNotificationsForUsers } = await import("./notificationService.js");
    
    const adminUsers = await User.find({
      role: { $in: ["ADMIN", "SUPER_ADMIN"] }
    }).select("_id").lean();
    
    const adminUserIds = adminUsers.map(u => u._id.toString());
    
    await createNotificationsForUsers(adminUserIds, {
      type: "partner",
      title: "Partner Status Changed",
      message: message,
      data: {
        partnerId: partnerIdStr,
        status: newStatus,
        oldStatus,
      },
      notificationId: generateNotificationId({
        applicationId: partnerIdStr,
        status: newStatus,
        timestamp: Date.now(),
        type: "partner",
      }),
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("❌ Error creating admin partner notifications:", error);
  }

  // Emit socket events
  io.to(`partner_${partnerIdStr}`).emit("partnerStatusChanged", {
    partnerId: partnerIdStr,
    status: newStatus,
    oldStatus,
    notificationId,
    timestamp: new Date(),
  });

  io.to("admin").emit("partnerStatusChanged", {
    partnerId: partnerIdStr,
    status: newStatus,
    oldStatus,
    notificationId,
    timestamp: new Date(),
  });

  io.to("super_admin").emit("partnerStatusChanged", {
    partnerId: partnerIdStr,
    status: newStatus,
    oldStatus,
    notificationId,
    timestamp: new Date(),
  });
};

export const emitNewPartnerRegistered = async (io, partner) => {
  if (!io || !partner) return;

  const partnerIdStr = String(partner._id);
  const notificationId = generateNotificationId({
    applicationId: partnerIdStr,
    timestamp: Date.now(),
    type: "registration",
  });

  const message = `New partner registered: ${partner.firstName} ${partner.lastName}`;

  // Save notifications for all Admin and SUPER_ADMIN users
  try {
    const { User } = await import("../models/User.js");
    const { createNotificationsForUsers } = await import("./notificationService.js");
    
    const adminUsers = await User.find({
      role: { $in: ["ADMIN", "SUPER_ADMIN"] }
    }).select("_id").lean();
    
    const adminUserIds = adminUsers.map(u => u._id.toString());
    
    await createNotificationsForUsers(adminUserIds, {
      type: "registration",
      title: "New Partner Registered",
      message: message,
      data: {
        partnerId: partnerIdStr,
        partner: {
          _id: partner._id,
          firstName: partner.firstName,
          lastName: partner.lastName,
          email: partner.email,
          status: partner.status,
        },
      },
      notificationId,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("❌ Error creating admin partner registration notifications:", error);
  }

  // Save notification for RM if assigned
  if (partner.rmId) {
    const rmIdStr = String(partner.rmId._id || partner.rmId);
    await createNotification(rmIdStr, {
      type: "registration",
      title: "New Partner Registered",
      message: message,
      data: {
        partnerId: partnerIdStr,
        partner: {
          _id: partner._id,
          firstName: partner.firstName,
          lastName: partner.lastName,
          email: partner.email,
          status: partner.status,
        },
      },
      notificationId: generateNotificationId({
        applicationId: partnerIdStr,
        timestamp: Date.now(),
        userId: rmIdStr,
        type: "registration",
      }),
      timestamp: new Date(),
    });
  }

  // Emit socket events
  io.to("admin").emit("newPartnerRegistered", {
    partner: {
      _id: partner._id,
      firstName: partner.firstName,
      lastName: partner.lastName,
      email: partner.email,
      status: partner.status,
    },
    notificationId,
    timestamp: new Date(),
  });

  io.to("super_admin").emit("newPartnerRegistered", {
    partner: {
      _id: partner._id,
      firstName: partner.firstName,
      lastName: partner.lastName,
      email: partner.email,
      status: partner.status,
    },
    notificationId,
    timestamp: new Date(),
  });

  if (partner.rmId) {
    io.to(`rm_${partner.rmId._id || partner.rmId}`).emit("newPartnerRegistered", {
      partner: {
        _id: partner._id,
        firstName: partner.firstName,
        lastName: partner.lastName,
        email: partner.email,
        status: partner.status,
      },
      notificationId,
      timestamp: new Date(),
    });
  }
};

export const emitNewCustomerRegistered = async (io, customer, partnerId) => {
  if (!io || !customer) return;

  const customerIdStr = String(customer._id);
  const notificationId = generateNotificationId({
    applicationId: customerIdStr,
    timestamp: Date.now(),
    type: "registration",
  });

  const message = `New customer registered: ${customer.firstName} ${customer.lastName}`;

  // Save notification to MongoDB for partner
  if (partnerId) {
    const partnerIdStr = String(partnerId);
    await createNotification(partnerIdStr, {
      type: "registration",
      title: "New Customer Registered",
      message: message,
      data: {
        customerId: customerIdStr,
        customer: {
          _id: customer._id,
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
        },
      },
      notificationId,
      timestamp: new Date(),
    });
  }

  // Emit socket event
  if (partnerId) {
    io.to(`partner_${String(partnerId)}`).emit("newCustomerRegistered", {
      customer: {
        _id: customer._id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
      },
      notificationId,
      timestamp: new Date(),
    });
  }
};

export const emitPayoutStatusChanged = async (io, payoutId, status, partnerId) => {
  if (!io) return;

  const notificationId = generateNotificationId({
    applicationId: payoutId,
    status: status,
    timestamp: Date.now(),
    type: "payout",
  });

  const message = `Payout status changed to ${status}`;

  // Save notification to MongoDB for partner
  if (partnerId) {
    const partnerIdStr = String(partnerId);
    await createNotification(partnerIdStr, {
      type: "payout",
      title: "Payout Status Changed",
      message: message,
      data: {
        payoutId,
        status,
      },
      notificationId,
      timestamp: new Date(),
    });
  }

  // Save notifications for all Admin and SUPER_ADMIN users
  try {
    const { User } = await import("../models/User.js");
    const { createNotificationsForUsers } = await import("./notificationService.js");
    
    const adminUsers = await User.find({
      role: { $in: ["ADMIN", "SUPER_ADMIN"] }
    }).select("_id").lean();
    
    const adminUserIds = adminUsers.map(u => u._id.toString());
    
    await createNotificationsForUsers(adminUserIds, {
      type: "payout",
      title: "Payout Status Changed",
      message: message,
      data: {
        payoutId,
        status,
        partnerId,
      },
      notificationId: generateNotificationId({
        applicationId: payoutId,
        status: status,
        timestamp: Date.now(),
        type: "payout",
      }),
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("❌ Error creating admin payout notifications:", error);
  }

  // Emit socket events
  if (partnerId) {
    io.to(`partner_${String(partnerId)}`).emit("payoutStatusChanged", {
      payoutId,
      status,
      notificationId,
      timestamp: new Date(),
    });
  }

  io.to("admin").emit("payoutStatusChanged", {
    payoutId,
    status,
    partnerId,
    notificationId,
    timestamp: new Date(),
  });

  io.to("super_admin").emit("payoutStatusChanged", {
    payoutId,
    status,
    partnerId,
    notificationId,
    timestamp: new Date(),
  });
};

// Incentive status (PENDING → PAID) notifications
export const emitIncentiveStatusChanged = async (io, incentive, partnerId) => {
  if (!io || !incentive || !partnerId) return;

  const incentiveId = String(incentive._id);
  const partnerIdStr = String(partnerId);
  const status = incentive.status;

  const notificationId = generateNotificationId({
    applicationId: incentiveId,
    status,
    timestamp: Date.now(),
    type: "incentive",
  });

  const message = `Incentive of ₹${incentive.amount} has been marked as ${status}`;

  // Save notification for partner
  await createNotification(partnerIdStr, {
    type: "incentive",
    title: "Incentive Status Updated",
    message,
    data: {
      incentiveId,
      status,
      month: incentive.month,
      year: incentive.year,
      amount: incentive.amount,
    },
    notificationId,
    timestamp: new Date(),
  });

  // Notify admins as well
  try {
    const { User } = await import("../models/User.js");
    const { createNotificationsForUsers } = await import("./notificationService.js");

    const adminUsers = await User.find({
      role: { $in: ["ADMIN", "SUPER_ADMIN"] },
    })
      .select("_id")
      .lean();

    const adminUserIds = adminUsers.map((u) => u._id.toString());

    await createNotificationsForUsers(adminUserIds, {
      type: "incentive",
      title: "Incentive Status Updated",
      message,
      data: {
        incentiveId,
        status,
        partnerId: partnerIdStr,
        month: incentive.month,
        year: incentive.year,
        amount: incentive.amount,
      },
      notificationId: generateNotificationId({
        applicationId: incentiveId,
        status,
        timestamp: Date.now(),
        type: "incentive",
      }),
      timestamp: new Date(),
    });
  } catch (err) {
    console.error("❌ Error creating admin incentive notifications:", err);
  }

  // Emit socket events
  io.to(`partner_${partnerIdStr}`).emit("incentiveStatusChanged", {
    incentiveId,
    status,
    amount: incentive.amount,
    month: incentive.month,
    year: incentive.year,
    notificationId,
    timestamp: new Date(),
  });

  io.to("admin").emit("incentiveStatusChanged", {
    incentiveId,
    status,
    partnerId: partnerIdStr,
    amount: incentive.amount,
    month: incentive.month,
    year: incentive.year,
    notificationId,
    timestamp: new Date(),
  });

  io.to("super_admin").emit("incentiveStatusChanged", {
    incentiveId,
    status,
    partnerId: partnerIdStr,
    amount: incentive.amount,
    month: incentive.month,
    year: incentive.year,
    notificationId,
    timestamp: new Date(),
  });
};