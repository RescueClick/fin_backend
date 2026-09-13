import express from "express";
import mongoose from "mongoose";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { User } from "../models/User.js";
import { Conversation } from "../models/Conversation.js";
import { ChatMessage } from "../models/ChatMessage.js";
import { Application } from "../models/Application.js";
import { upload } from "../middleware/upload.js";

const router = express.Router();

// Only internal staff (SUPER_ADMIN, ASM, RSM, RM) can access the chat system
const ALLOWED_CHAT_ROLES = [ROLES.SUPER_ADMIN, ROLES.ASM, ROLES.RSM, ROLES.RM];

router.use(auth);
router.use(requireRole(ALLOWED_CHAT_ROLES));

/**
 * Helper: Find the other participant in a 2-person conversation
 */
function getOtherParticipant(conv, currentUserIdStr) {
  if (!conv || !Array.isArray(conv.participants)) return null;
  return conv.participants.find(
    (p) => (p._id ? p._id.toString() : p.toString()) !== currentUserIdStr
  );
}

// ============================================================================
// 1. GET /api/chat/contacts
// Fetch list of internal staff colleagues for starting or continuing chats
// ============================================================================
router.get("/contacts", async (req, res) => {
  try {
    const currentUserId = req.user.sub;
    const currentUser = await User.findById(currentUserId).lean();
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const { search, scope } = req.query;

    const query = {
      _id: { $ne: currentUser._id },
      role: { $in: ALLOWED_CHAT_ROLES },
      deletedAt: null,
      status: { $ne: "SUSPENDED" },
    };

    if (search && search.trim()) {
      const term = search.trim();
      const regex = new RegExp(term, "i");
      query.$or = [
        { firstName: regex },
        { lastName: regex },
        { email: regex },
        { phone: regex },
        { employeeId: regex },
        { asmCode: regex },
        { rmCode: regex },
      ];
    }

    const users = await User.find(query)
      .select(
        "_id firstName lastName email phone role rsmType employeeId asmCode rmCode asmId personalRsmId businessHomeRsmId businessRsmId homeLapRsmId status createdAt"
      )
      .sort({ firstName: 1 })
      .lean();

    // Map hierarchy relationship flags relative to the logged-in user
    const curRole = currentUser.role;
    const curIdStr = currentUser._id.toString();
    const curAsmStr = currentUser.asmId?.toString();

    const formattedContacts = users.map((u) => {
      let isMyTeam = false;
      const uIdStr = u._id.toString();

      if (curRole === ROLES.SUPER_ADMIN) {
        isMyTeam = true;
      } else if (curRole === ROLES.ASM) {
        // ASM's direct team: RSMs reporting to this ASM, RMs under this ASM, and Admin
        if (u.role === ROLES.SUPER_ADMIN) isMyTeam = true;
        if (u.asmId && u.asmId.toString() === curIdStr) isMyTeam = true;
      } else if (curRole === ROLES.RSM) {
        // RSM's team: parent ASM, Admin, and RMs assigned to this RSM
        if (u.role === ROLES.SUPER_ADMIN) isMyTeam = true;
        if (curAsmStr && uIdStr === curAsmStr) isMyTeam = true;
        if (
          u.role === ROLES.RM &&
          (u.personalRsmId?.toString() === curIdStr ||
            u.businessHomeRsmId?.toString() === curIdStr ||
            u.businessRsmId?.toString() === curIdStr ||
            u.homeLapRsmId?.toString() === curIdStr)
        ) {
          isMyTeam = true;
        }
      } else if (curRole === ROLES.RM) {
        // RM's supervisors: their parent ASM, their assigned RSMs, and Admin
        if (u.role === ROLES.SUPER_ADMIN) isMyTeam = true;
        if (curAsmStr && uIdStr === curAsmStr) isMyTeam = true;
        if (
          [
            currentUser.personalRsmId?.toString(),
            currentUser.businessHomeRsmId?.toString(),
            currentUser.businessRsmId?.toString(),
            currentUser.homeLapRsmId?.toString(),
          ].includes(uIdStr)
        ) {
          isMyTeam = true;
        }
      }

      return {
        _id: u._id,
        firstName: u.firstName || "",
        lastName: u.lastName || "",
        fullName: `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Staff Member",
        email: u.email || "",
        phone: u.phone || "",
        role: u.role,
        rsmType: u.rsmType || null,
        employeeId: u.employeeId || u.asmCode || u.rmCode || "",
        isMyTeam,
      };
    });

    const finalContacts =
      scope === "team"
        ? formattedContacts.filter((c) => c.isMyTeam)
        : formattedContacts;

    res.json({
      success: true,
      contacts: finalContacts,
      total: finalContacts.length,
    });
  } catch (error) {
    console.error("Error fetching chat contacts:", error);
    res.status(500).json({ message: "Failed to fetch chat contacts", error: error.message });
  }
});

// ============================================================================
// 2. GET /api/chat/unread-count
// Quick total unread badge count for sidebars
// ============================================================================
router.get("/unread-count", async (req, res) => {
  try {
    const currentUserId = req.user.sub;
    const conversations = await Conversation.find({
      participants: currentUserId,
    }).select("unreadCounts");

    let totalUnread = 0;
    for (const c of conversations) {
      if (c.unreadCounts) {
        const count = c.unreadCounts.get
          ? c.unreadCounts.get(currentUserId.toString()) || 0
          : c.unreadCounts[currentUserId.toString()] || 0;
        totalUnread += Number(count) || 0;
      }
    }

    res.json({ success: true, unreadCount: totalUnread });
  } catch (error) {
    console.error("Error fetching chat unread count:", error);
    res.status(500).json({ message: "Failed to fetch unread count", error: error.message });
  }
});

// ============================================================================
// 3. GET /api/chat/conversations
// Fetch all conversations for the logged-in staff member
// ============================================================================
router.get("/conversations", async (req, res) => {
  try {
    const currentUserId = req.user.sub;
    const currentUserIdStr = currentUserId.toString();

    const conversations = await Conversation.find({
      participants: currentUserId,
      "clearedFor.user": { $ne: currentUserId },
    })
      .populate(
        "participants",
        "_id firstName lastName email phone role rsmType employeeId asmCode rmCode"
      )
      .populate("loanRef.applicationId", "applicationNumber loanType status loanAmount personalDetails")
      .sort({ "lastMessage.createdAt": -1, updatedAt: -1 })
      .lean();

    const formatted = conversations.map((conv) => {
      const other = getOtherParticipant(conv, currentUserIdStr);
      let unread = 0;
      if (conv.unreadCounts) {
        unread = conv.unreadCounts[currentUserIdStr] || 0;
      }

      return {
        _id: conv._id,
        participants: conv.participants,
        otherParticipant: other
          ? {
              _id: other._id,
              firstName: other.firstName || "",
              lastName: other.lastName || "",
              fullName: `${other.firstName || ""} ${other.lastName || ""}`.trim() || "Staff Member",
              email: other.email,
              phone: other.phone,
              role: other.role,
              rsmType: other.rsmType || null,
              employeeId: other.employeeId || other.asmCode || other.rmCode || "",
            }
          : null,
        lastMessage: conv.lastMessage || null,
        unreadCount: unread,
        loanRef: conv.loanRef || null,
        updatedAt: conv.updatedAt,
      };
    });

    res.json({ success: true, conversations: formatted });
  } catch (error) {
    console.error("Error fetching conversations:", error);
    res.status(500).json({ message: "Failed to fetch conversations", error: error.message });
  }
});

// ============================================================================
// 4. POST /api/chat/conversations
// Create or retrieve an existing conversation with another staff member
// ============================================================================
router.post("/conversations", async (req, res) => {
  try {
    const currentUserId = req.user.sub;
    const { participantId, initialMessage, loanRef } = req.body;

    if (!participantId) {
      return res.status(400).json({ message: "Participant ID is required" });
    }

    if (participantId.toString() === currentUserId.toString()) {
      return res.status(400).json({ message: "Cannot create conversation with yourself" });
    }

    // Verify other participant exists and is allowed staff
    const targetUser = await User.findOne({
      _id: participantId,
      role: { $in: ALLOWED_CHAT_ROLES },
      deletedAt: null,
    }).select("_id firstName lastName email phone role rsmType employeeId asmCode rmCode");

    if (!targetUser) {
      return res.status(404).json({ message: "Colleague not found or ineligible for chat" });
    }

    // Check if conversation already exists between the two participants
    let conversation = await Conversation.findOne({
      participants: { $all: [currentUserId, participantId], $size: 2 },
    }).populate(
      "participants",
      "_id firstName lastName email phone role rsmType employeeId asmCode rmCode"
    );

    let isNew = false;
    if (!conversation) {
      isNew = true;
      conversation = new Conversation({
        participants: [currentUserId, participantId],
        unreadCounts: new Map([
          [currentUserId.toString(), 0],
          [participantId.toString(), 0],
        ]),
        loanRef: loanRef || null,
      });
      await conversation.save();
      await conversation.populate(
        "participants",
        "_id firstName lastName email phone role rsmType employeeId asmCode rmCode"
      );
    } else if (loanRef) {
      // Update loanRef if provided
      conversation.loanRef = loanRef;
      await conversation.save();
    }

    // If an initial text message was sent upon creating chat
    let firstMsgDoc = null;
    if (initialMessage && initialMessage.trim()) {
      const senderUser = await User.findById(currentUserId).select("firstName lastName");
      const senderName = `${senderUser?.firstName || ""} ${senderUser?.lastName || ""}`.trim() || "Staff";

      firstMsgDoc = new ChatMessage({
        conversationId: conversation._id,
        sender: currentUserId,
        recipient: participantId,
        text: initialMessage.trim(),
        loanRef: loanRef || null,
        status: "SENT",
      });
      await firstMsgDoc.save();

      conversation.lastMessage = {
        text: initialMessage.trim(),
        sender: currentUserId,
        senderName,
        hasAttachment: false,
        createdAt: new Date(),
      };

      const curUnread = conversation.unreadCounts.get(participantId.toString()) || 0;
      conversation.unreadCounts.set(participantId.toString(), curUnread + 1);
      await conversation.save();
    }

    const currentUserIdStr = currentUserId.toString();
    const other = getOtherParticipant(conversation, currentUserIdStr);

    res.status(isNew ? 201 : 200).json({
      success: true,
      conversation: {
        _id: conversation._id,
        participants: conversation.participants,
        otherParticipant: other
          ? {
              _id: other._id,
              firstName: other.firstName || "",
              lastName: other.lastName || "",
              fullName: `${other.firstName || ""} ${other.lastName || ""}`.trim() || "Staff Member",
              email: other.email,
              phone: other.phone,
              role: other.role,
              rsmType: other.rsmType || null,
              employeeId: other.employeeId || other.asmCode || other.rmCode || "",
            }
          : null,
        lastMessage: conversation.lastMessage || null,
        unreadCount: conversation.unreadCounts?.get?.(currentUserIdStr) || 0,
        loanRef: conversation.loanRef || null,
      },
      initialMessage: firstMsgDoc,
    });
  } catch (error) {
    console.error("Error creating/getting conversation:", error);
    res.status(500).json({ message: "Failed to start conversation", error: error.message });
  }
});

// ============================================================================
// 5. GET /api/chat/conversations/:id/messages
// Paginated messages for a conversation + automatic read receipt
// ============================================================================
router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const currentUserId = req.user.sub;
    const currentUserIdStr = currentUserId.toString();
    const { id } = req.params;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
    const skip = (page - 1) * limit;

    const conversation = await Conversation.findOne({
      _id: id,
      participants: currentUserId,
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found or access denied" });
    }

    const [messages, totalCount] = await Promise.all([
      ChatMessage.find({
        conversationId: id,
        deletedFor: { $ne: currentUserId },
      })
        .populate("sender", "_id firstName lastName role rsmType employeeId")
        .populate("recipient", "_id firstName lastName role rsmType employeeId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ChatMessage.countDocuments({
        conversationId: id,
        deletedFor: { $ne: currentUserId },
      }),
    ]);

    // Chronological order for chat feed display
    const orderedMessages = messages.reverse();

    // Mark unread messages sent by others to current user as READ
    const unreadUpdated = await ChatMessage.updateMany(
      {
        conversationId: id,
        recipient: currentUserId,
        status: { $ne: "READ" },
      },
      {
        $set: { status: "READ", readAt: new Date() },
      }
    );

    // Reset unread counter for current user in conversation
    if (conversation.unreadCounts) {
      conversation.unreadCounts.set(currentUserIdStr, 0);
      await conversation.save();
    }

    // Broadcast read receipt via Socket.io if messages were marked read
    if (unreadUpdated.modifiedCount > 0 && global.io) {
      const otherPart = conversation.participants.find(
        (p) => p.toString() !== currentUserIdStr
      );
      if (otherPart) {
        global.io.to(`chat_conv_${id}`).emit("chat:messages_read", {
          conversationId: id,
          readBy: currentUserIdStr,
          readAt: new Date(),
        });
        global.io.to(`user_${otherPart.toString()}`).emit("chat:messages_read", {
          conversationId: id,
          readBy: currentUserIdStr,
          readAt: new Date(),
        });
      }
    }

    res.json({
      success: true,
      messages: orderedMessages,
      page,
      limit,
      totalCount,
      hasMore: skip + messages.length < totalCount,
    });
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ message: "Failed to fetch messages", error: error.message });
  }
});

// ============================================================================
// 6. POST /api/chat/conversations/:id/messages
// Send a new message in a conversation
// ============================================================================
router.post("/conversations/:id/messages", async (req, res) => {
  try {
    const currentUserId = req.user.sub;
    const currentUserIdStr = currentUserId.toString();
    const { id } = req.params;
    const { text, attachments, loanRef } = req.body;

    if (!text?.trim() && (!attachments || attachments.length === 0) && !loanRef) {
      return res.status(400).json({ message: "Message cannot be empty" });
    }

    const conversation = await Conversation.findOne({
      _id: id,
      participants: currentUserId,
    }).populate(
      "participants",
      "_id firstName lastName email phone role rsmType employeeId asmCode rmCode"
    );

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found or access denied" });
    }

    const recipient = conversation.participants.find(
      (p) => p._id.toString() !== currentUserIdStr
    );

    if (!recipient) {
      return res.status(400).json({ message: "Recipient not found in conversation" });
    }

    const sender = conversation.participants.find(
      (p) => p._id.toString() === currentUserIdStr
    );
    const senderName = `${sender?.firstName || ""} ${sender?.lastName || ""}`.trim() || "Staff";

    const newMessage = new ChatMessage({
      conversationId: id,
      sender: currentUserId,
      recipient: recipient._id,
      text: (text || "").trim(),
      attachments: Array.isArray(attachments) ? attachments : [],
      loanRef: loanRef || null,
      status: "SENT",
    });

    await newMessage.save();

    // Populate sender & recipient info
    await newMessage.populate("sender", "_id firstName lastName role rsmType employeeId");
    await newMessage.populate("recipient", "_id firstName lastName role rsmType employeeId");

    // Plain JSON so Socket.IO clients always receive a serializable payload
    const messagePayload = newMessage.toObject ? newMessage.toObject() : newMessage;
    if (messagePayload._id) messagePayload._id = String(messagePayload._id);
    if (messagePayload.conversationId) {
      messagePayload.conversationId = String(messagePayload.conversationId);
    }
    if (messagePayload.sender?._id) {
      messagePayload.sender = {
        ...messagePayload.sender,
        _id: String(messagePayload.sender._id),
      };
    }
    if (messagePayload.recipient?._id) {
      messagePayload.recipient = {
        ...messagePayload.recipient,
        _id: String(messagePayload.recipient._id),
      };
    }

    // Update conversation state
    const previewText =
      (text || "").trim() ||
      (attachments && attachments.length > 0
        ? `📎 Sent ${attachments.length} file${attachments.length > 1 ? "s" : ""}`
        : loanRef
        ? `📄 Loan Ref: ${loanRef.applicationNumber || "Application"}`
        : "Message");

    conversation.lastMessage = {
      text: previewText,
      sender: currentUserId,
      senderName,
      hasAttachment: !!(attachments && attachments.length > 0),
      createdAt: new Date(),
    };

    if (loanRef) {
      conversation.loanRef = loanRef;
    }

    const recipientIdStr = recipient._id.toString();
    const conversationIdStr = String(id);
    const currentCount = conversation.unreadCounts?.get?.(recipientIdStr) || 0;
    if (conversation.unreadCounts) {
      conversation.unreadCounts.set(recipientIdStr, currentCount + 1);
    }
    await conversation.save();

    // Real-time distribution via Socket.io — emit to room AND both user rooms
    if (global.io) {
      const eventBody = {
        message: messagePayload,
        conversationId: conversationIdStr,
      };

      // Conversation room (anyone currently viewing this chat)
      global.io.to(`chat_conv_${conversationIdStr}`).emit("chat:new_message", eventBody);

      // Recipient personal room (always — even if not in conversation room)
      global.io.to(`user_${recipientIdStr}`).emit("chat:new_message", eventBody);
      global.io.to(`user_${recipientIdStr}`).emit("chat:incoming_message", {
        ...eventBody,
        conversation: {
          _id: conversationIdStr,
          lastMessage: conversation.lastMessage,
          unreadCount: currentCount + 1,
        },
      });

      // Sender confirmation (other tabs / devices)
      global.io.to(`user_${currentUserIdStr}`).emit("chat:message_sent", eventBody);
      global.io.to(`user_${currentUserIdStr}`).emit("chat:new_message", eventBody);
    }

    res.status(201).json({
      success: true,
      message: messagePayload,
      conversationLastMessage: conversation.lastMessage,
    });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ message: "Failed to send message", error: error.message });
  }
});

// ============================================================================
// 7. POST /api/chat/conversations/:id/read
// Explicitly mark conversation as read
// ============================================================================
router.post("/conversations/:id/read", async (req, res) => {
  try {
    const currentUserId = req.user.sub;
    const currentUserIdStr = currentUserId.toString();
    const { id } = req.params;

    const conversation = await Conversation.findOne({
      _id: id,
      participants: currentUserId,
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    await ChatMessage.updateMany(
      {
        conversationId: id,
        recipient: currentUserId,
        status: { $ne: "READ" },
      },
      {
        $set: { status: "READ", readAt: new Date() },
      }
    );

    if (conversation.unreadCounts) {
      conversation.unreadCounts.set(currentUserIdStr, 0);
      await conversation.save();
    }

    const otherPart = conversation.participants.find(
      (p) => p.toString() !== currentUserIdStr
    );

    if (global.io && otherPart) {
      global.io.to(`chat_conv_${id}`).emit("chat:messages_read", {
        conversationId: id,
        readBy: currentUserIdStr,
        readAt: new Date(),
      });
      global.io.to(`user_${otherPart.toString()}`).emit("chat:messages_read", {
        conversationId: id,
        readBy: currentUserIdStr,
        readAt: new Date(),
      });
    }

    res.json({ success: true, message: "Conversation marked as read" });
  } catch (error) {
    console.error("Error marking conversation as read:", error);
    res.status(500).json({ message: "Failed to mark as read", error: error.message });
  }
});

// ============================================================================
// 8. POST /api/chat/upload
// Upload up to 5 files/attachments for chat
// ============================================================================
router.post("/upload", upload.array("files", 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    const attachments = req.files.map((file) => ({
      url: file.location || `/uploads/${file.filename}`,
      name: file.originalname || "attachment",
      size: file.size || 0,
      mimeType: file.mimetype || "application/octet-stream",
    }));

    res.json({
      success: true,
      attachments,
    });
  } catch (error) {
    console.error("Error uploading chat attachments:", error);
    res.status(500).json({ message: "Failed to upload files", error: error.message });
  }
});

// ============================================================================
// 9. GET /api/chat/search-loans
// Search active applications to embed loan cards into messages
// ============================================================================
router.get("/search-loans", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim() || q.trim().length < 2) {
      return res.json({ success: true, loans: [] });
    }

    const term = q.trim();
    const regex = new RegExp(term, "i");

    const applications = await Application.find({
      $or: [
        { applicationNumber: regex },
        { "personalDetails.fullName": regex },
        { "personalDetails.mobileNumber": regex },
        { "personalDetails.panNumber": regex },
      ],
    })
      .select("applicationNumber loanType status loanAmount personalDetails.fullName createdAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const formattedLoans = applications.map((app) => ({
      applicationId: app._id,
      applicationNumber: app.applicationNumber || "N/A",
      applicantName: app.personalDetails?.fullName || "Applicant",
      loanType: app.loanType || "PERSONAL",
      amount: app.loanAmount || 0,
      status: app.status || "DRAFT",
    }));

    res.json({ success: true, loans: formattedLoans });
  } catch (error) {
    console.error("Error searching loans for chat:", error);
    res.status(500).json({ message: "Failed to search loans", error: error.message });
  }
});

export default router;
