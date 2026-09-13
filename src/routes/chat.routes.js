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
import { activeUsers } from "../socket/socketHandler.js";
import { getOnlineStaffIds, markHeartbeat } from "../utils/chatPresence.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3, BUCKET_NAME } from "../config/s3.js";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const router = express.Router();

// Only internal staff (SUPER_ADMIN, ADMIN, ASM, RSM, RM) can access the chat system
const ALLOWED_CHAT_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.ASM, ROLES.RSM, ROLES.RM];

function sid(v) {
  return v == null ? "" : String(v);
}

/**
 * Who this staff member may start/continue chats with.
 * - SUPER_ADMIN / ADMIN → everyone (returns null)
 * - Others → reporting-line only (parents + subordinates)
 */
async function getAllowedChatPeerIds(currentUser) {
  if (!currentUser?._id) return new Set();

  const me = currentUser._id;
  const meStr = sid(me);
  const role = currentUser.role;

  if (role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN) {
    return null; // unrestricted
  }

  const allowed = new Set();
  const staffBase = {
    deletedAt: null,
    status: { $ne: "SUSPENDED" },
    role: { $in: ALLOWED_CHAT_ROLES },
  };

  // Everyone may chat Admin
  const admins = await User.find({
    ...staffBase,
    role: { $in: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  })
    .select("_id")
    .lean();
  for (const u of admins) allowed.add(sid(u._id));

  // Direct parent links on my profile
  [
    currentUser.adminId,
    currentUser.rsmId,
    currentUser.asmId,
    currentUser.personalAsmId,
    currentUser.businessAsmId,
    currentUser.homeLapAsmId,
    currentUser.personalRsmId,
    currentUser.businessRsmId,
    currentUser.homeLapRsmId,
    currentUser.businessHomeRsmId,
  ]
    .filter(Boolean)
    .forEach((id) => allowed.add(sid(id)));

  if (role === ROLES.RSM) {
    // Specialized ASMs under this Senior RSM
    const asms = await User.find({
      ...staffBase,
      role: ROLES.ASM,
      $or: [{ rsmId: me }, { asmId: me }],
    })
      .select("_id")
      .lean();
    const asmIds = asms.map((a) => a._id);
    for (const a of asms) allowed.add(sid(a._id));

    // RMs under those ASMs or directly linked to this RSM
    const rmOr = [
      { personalRsmId: me },
      { businessRsmId: me },
      { homeLapRsmId: me },
      { businessHomeRsmId: me },
      { rsmId: me },
      { asmId: me },
    ];
    if (asmIds.length) {
      rmOr.push(
        { personalAsmId: { $in: asmIds } },
        { businessAsmId: { $in: asmIds } },
        { homeLapAsmId: { $in: asmIds } },
        { asmId: { $in: asmIds } },
        { rsmId: { $in: asmIds } }
      );
    }
    const rms = await User.find({ ...staffBase, role: ROLES.RM, $or: rmOr })
      .select("_id")
      .lean();
    for (const r of rms) allowed.add(sid(r._id));

    // Mid-level RSM/ASM children that only store asmId → me (legacy)
    const kids = await User.find({
      ...staffBase,
      role: { $in: [ROLES.ASM, ROLES.RSM, ROLES.RM] },
      $or: [{ asmId: me }, { rsmId: me }],
    })
      .select("_id")
      .lean();
    for (const k of kids) allowed.add(sid(k._id));
  }

  if (role === ROLES.ASM) {
    // RMs / RSMs reporting to this ASM
    const reports = await User.find({
      ...staffBase,
      role: { $in: [ROLES.RM, ROLES.RSM] },
      $or: [
        { personalAsmId: me },
        { businessAsmId: me },
        { homeLapAsmId: me },
        { personalRsmId: me },
        { businessRsmId: me },
        { homeLapRsmId: me },
        { businessHomeRsmId: me },
        { asmId: me },
        { rsmId: me },
      ],
    })
      .select("_id")
      .lean();
    for (const r of reports) allowed.add(sid(r._id));
  }

  if (role === ROLES.RM) {
    // Parents already added from profile fields — nothing else
  }

  allowed.delete(meStr);
  return allowed;
}

async function assertCanChatWith(currentUser, targetUser) {
  if (!targetUser) return false;
  const allowed = await getAllowedChatPeerIds(currentUser);
  if (allowed === null) return true;
  return allowed.has(sid(targetUser._id));
}

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

/**
 * Build a complete loanRef card from Application (+ optional client payload)
 */
async function enrichLoanRef(loanRefInput) {
  if (!loanRefInput) return null;

  const applicationId =
    loanRefInput.applicationId?._id ||
    loanRefInput.applicationId ||
    loanRefInput._id ||
    null;

  let app = null;
  if (applicationId && mongoose.Types.ObjectId.isValid(String(applicationId))) {
    app = await Application.findById(applicationId)
      .select(
        "appNo loanType status requestedAmount approvedLoanAmount customerId customer.firstName customer.middleName customer.lastName customer.phone customer.loanAmount"
      )
      .lean();
  } else if (loanRefInput.applicationNumber && loanRefInput.applicationNumber !== "N/A") {
    app = await Application.findOne({ appNo: loanRefInput.applicationNumber })
      .select(
        "appNo loanType status requestedAmount approvedLoanAmount customerId customer.firstName customer.middleName customer.lastName customer.phone customer.loanAmount"
      )
      .lean();
  }

  if (!app) {
    // Keep whatever client sent if we cannot resolve
    if (!loanRefInput.applicationId && !loanRefInput.applicationNumber) return null;
    return {
      applicationId: applicationId || undefined,
      applicationNumber: loanRefInput.applicationNumber || "N/A",
      applicantName: loanRefInput.applicantName || "Applicant",
      loanType: loanRefInput.loanType || "",
      amount: loanRefInput.amount || 0,
      status: loanRefInput.status || "",
      customerId: loanRefInput.customerId || undefined,
      phone: loanRefInput.phone || "",
    };
  }

  const c = app.customer || {};
  const applicantName =
    [c.firstName, c.middleName, c.lastName].filter(Boolean).join(" ").trim() ||
    loanRefInput.applicantName ||
    "Applicant";

  return {
    applicationId: app._id,
    applicationNumber: app.appNo || loanRefInput.applicationNumber || "N/A",
    applicantName,
    loanType: app.loanType || loanRefInput.loanType || "PERSONAL",
    amount:
      app.approvedLoanAmount ||
      app.requestedAmount ||
      c.loanAmount ||
      loanRefInput.amount ||
      0,
    status: app.status || loanRefInput.status || "",
    customerId: app.customerId || loanRefInput.customerId || undefined,
    phone: c.phone || loanRefInput.phone || "",
  };
}

// ============================================================================
// 1. GET /api/chat/contacts
// Admin → all staff. Others → reporting-line only.
// ============================================================================
router.get("/contacts", async (req, res) => {
  try {
    const currentUserId = req.user.sub;
    const currentUser = await User.findById(currentUserId).lean();
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const { search } = req.query;
    const allowedIds = await getAllowedChatPeerIds(currentUser);

    const query = {
      _id: { $ne: currentUser._id },
      role: { $in: ALLOWED_CHAT_ROLES },
      deletedAt: null,
      status: { $ne: "SUSPENDED" },
    };

    // Non-admin: hard-filter to hierarchy peers only
    if (allowedIds !== null) {
      const idList = Array.from(allowedIds).filter((id) => mongoose.Types.ObjectId.isValid(id));
      query._id = { $ne: currentUser._id, $in: idList };
      if (idList.length === 0) {
        return res.json({ success: true, contacts: [], total: 0, hierarchyOnly: true });
      }
    }

    if (search && search.trim()) {
      const term = search.trim();
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [
        { firstName: regex },
        { lastName: regex },
        { email: regex },
        { phone: regex },
        { employeeId: regex },
        { asmCode: regex },
        { rmCode: regex },
        { rsmCode: regex },
      ];
    }

    const users = await User.find(query)
      .select(
        "_id firstName lastName email phone role rsmType asmType employeeId asmCode rmCode rsmCode status"
      )
      .sort({ firstName: 1 })
      .lean();

    const contacts = users.map((u) => ({
      _id: u._id,
      firstName: u.firstName || "",
      lastName: u.lastName || "",
      fullName: `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Staff Member",
      email: u.email || "",
      phone: u.phone || "",
      role: u.role,
      rsmType: u.rsmType || u.asmType || null,
      employeeId: u.employeeId || u.asmCode || u.rmCode || u.rsmCode || "",
      isMyTeam: true,
    }));

    res.json({
      success: true,
      contacts,
      total: contacts.length,
      hierarchyOnly: allowedIds !== null,
    });
  } catch (error) {
    console.error("Error fetching chat contacts:", error);
    res.status(500).json({ message: "Failed to fetch chat contacts", error: error.message });
  }
});

// ============================================================================
// 1b. POST /api/chat/heartbeat  — mark me online while chat UI is open
// GET  /api/chat/online-staff — list online staff (socket + heartbeat)
// ============================================================================
router.post("/heartbeat", async (req, res) => {
  try {
    const userId = markHeartbeat(req.user.sub, req.user.role || "");

    // Notify peers over socket if available
    if (global.io) {
      global.io.to("internal_staff").emit("chat:presence", {
        userId,
        isOnline: true,
        timestamp: new Date(),
      });
    }

    res.json({ success: true, onlineUserIds: getOnlineStaffIds(activeUsers) });
  } catch (error) {
    console.error("chat heartbeat error:", error);
    res.status(500).json({ message: "Heartbeat failed", error: error.message });
  }
});

router.get("/online-staff", async (req, res) => {
  try {
    res.json({ success: true, onlineUserIds: getOnlineStaffIds(activeUsers) });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch online staff", error: error.message });
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
      .populate(
        "loanRef.applicationId",
        "appNo loanType status requestedAmount approvedLoanAmount customer.firstName customer.lastName customer.phone"
      )
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
    }).select(
      "_id firstName lastName email phone role rsmType employeeId asmCode rmCode adminId rsmId asmId personalAsmId businessAsmId homeLapAsmId personalRsmId businessRsmId homeLapRsmId businessHomeRsmId"
    );

    if (!targetUser) {
      return res.status(404).json({ message: "Colleague not found or ineligible for chat" });
    }

    const currentUser = await User.findById(currentUserId).lean();
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const allowed = await assertCanChatWith(currentUser, targetUser);
    if (!allowed) {
      return res.status(403).json({
        message: "You can only chat with Admin or staff in your reporting line",
      });
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

    // Hydrate incomplete loan cards (older messages saved with N/A / Applicant)
    for (const msg of orderedMessages) {
      const lr = msg.loanRef;
      if (!lr?.applicationId) continue;
      const needsFix =
        !lr.applicationNumber ||
        lr.applicationNumber === "N/A" ||
        !lr.applicantName ||
        lr.applicantName === "Applicant";
      if (!needsFix) continue;
      try {
        const fixed = await enrichLoanRef(lr);
        if (fixed) {
          msg.loanRef = fixed;
          ChatMessage.updateOne(
            { _id: msg._id },
            { $set: { loanRef: fixed } }
          ).catch(() => {});
        }
      } catch (_) {}
    }

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

    // Always resolve loan card from DB so appNo / applicant name are correct
    const resolvedLoanRef = await enrichLoanRef(loanRef);

    const newMessage = new ChatMessage({
      conversationId: id,
      sender: currentUserId,
      recipient: recipient._id,
      text: (text || "").trim(),
      attachments: Array.isArray(attachments) ? attachments : [],
      loanRef: resolvedLoanRef || null,
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
        ? `📄 Loan Ref: ${resolvedLoanRef?.applicationNumber || loanRef?.applicationNumber || "Application"}`
        : "Message");

    conversation.lastMessage = {
      text: previewText,
      sender: currentUserId,
      senderName,
      hasAttachment: !!(attachments && attachments.length > 0),
      createdAt: new Date(),
    };

    if (resolvedLoanRef) {
      conversation.loanRef = resolvedLoanRef;
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
// 8b. GET /api/chat/download
// Force-download chat attachment (proxy) so browser saves instead of opening
// ============================================================================
function sanitizeDownloadName(name) {
  const cleaned = String(name || "download")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "download";
}

function extractS3KeyFromUrl(fileUrl) {
  try {
    if (!fileUrl) return null;
    if (fileUrl.startsWith("uploads/")) return fileUrl;
    if (fileUrl.startsWith("/uploads/")) return fileUrl.slice(1);

    const u = new URL(fileUrl);
    const pathname = decodeURIComponent(u.pathname.replace(/^\/+/, ""));

    if (BUCKET_NAME && u.hostname.startsWith(`${BUCKET_NAME}.`)) {
      return pathname;
    }
    if (BUCKET_NAME && pathname.startsWith(`${BUCKET_NAME}/`)) {
      return pathname.slice(BUCKET_NAME.length + 1);
    }
    if (pathname.startsWith("uploads/")) return pathname;
    return null;
  } catch (_) {
    return null;
  }
}

function isAllowedChatFileUrl(fileUrl) {
  if (!fileUrl) return false;
  if (fileUrl.startsWith("/uploads/") || fileUrl.startsWith("uploads/")) return true;
  try {
    const u = new URL(fileUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (BUCKET_NAME && (host.includes(String(BUCKET_NAME).toLowerCase()) || host.includes("amazonaws.com"))) {
      return true;
    }
    if (host.includes("dhansourcecapital.com")) return true;
    return Boolean(extractS3KeyFromUrl(fileUrl));
  } catch (_) {
    return false;
  }
}

router.get("/download", async (req, res) => {
  try {
    const fileUrl = String(req.query.url || "").trim();
    const name = sanitizeDownloadName(req.query.name);

    if (!fileUrl) {
      return res.status(400).json({ message: "url is required" });
    }
    if (!isAllowedChatFileUrl(fileUrl)) {
      return res.status(403).json({ message: "File URL not allowed" });
    }

    let contentType = "application/octet-stream";
    let bodyStream = null;

    const s3Key = extractS3KeyFromUrl(fileUrl);
    if (s3Key && BUCKET_NAME) {
      const out = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: s3Key,
        })
      );
      bodyStream = out.Body;
      contentType = out.ContentType || contentType;
      if (out.ContentLength != null) {
        res.setHeader("Content-Length", String(out.ContentLength));
      }
    } else if (fileUrl.startsWith("/uploads/") || fileUrl.startsWith("uploads/")) {
      const relative = fileUrl.replace(/^\/+/, "");
      const fullPath = path.join(process.cwd(), relative);
      if (!fullPath.startsWith(path.join(process.cwd(), "uploads")) || !fs.existsSync(fullPath)) {
        return res.status(404).json({ message: "File not found" });
      }
      bodyStream = fs.createReadStream(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      if (ext === ".pdf") contentType = "application/pdf";
      else if (ext === ".png") contentType = "image/png";
      else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    } else {
      const upstream = await fetch(fileUrl);
      if (!upstream.ok) {
        return res.status(502).json({ message: "Failed to fetch file" });
      }
      contentType = upstream.headers.get("content-type") || contentType;
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      bodyStream = Readable.fromWeb(upstream.body);
    }

    if (!bodyStream) {
      return res.status(404).json({ message: "File not found" });
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (typeof bodyStream.pipe === "function") {
      bodyStream.on("error", (err) => {
        console.error("chat download stream error:", err);
        if (!res.headersSent) res.status(500).end();
        else res.destroy(err);
      });
      bodyStream.pipe(res);
      return;
    }

    await pipeline(bodyStream, res);
  } catch (error) {
    console.error("Error downloading chat attachment:", error);
    if (!res.headersSent) {
      res.status(500).json({ message: "Failed to download file", error: error.message });
    }
  }
});

// ============================================================================
// 9. GET /api/chat/search-loans
// Search applications under the staff member we are chatting with only
// Query: q (optional search), forUserId (required — chat peer)
// ============================================================================
function loanFilterForStaffUser(user) {
  if (!user?._id) return null;
  const id = user._id;
  switch (user.role) {
    case ROLES.RM:
      return { rmId: id };
    case ROLES.ASM:
      return { asmId: id };
    case ROLES.RSM:
      return { rsmId: id };
    case ROLES.SUPER_ADMIN:
    case ROLES.ADMIN:
      // Admin does not own a loan book — caller should fall back to the other party
      return null;
    default:
      return { _id: { $in: [] } };
  }
}

router.get("/search-loans", async (req, res) => {
  try {
    const { q, forUserId } = req.query;
    const currentUserId = req.user.sub;

    if (!forUserId) {
      return res.status(400).json({
        message: "forUserId is required — only loans under the chat peer are listed",
      });
    }

    const peer = await User.findById(forUserId).select("_id role firstName lastName").lean();
    if (!peer) {
      return res.status(404).json({ message: "Chat peer not found" });
    }

    // Scope to the person we are chatting with. If they are Admin, scope to me instead.
    let ownerFilter = loanFilterForStaffUser(peer);
    if (!ownerFilter) {
      const me = await User.findById(currentUserId).select("_id role").lean();
      ownerFilter = loanFilterForStaffUser(me);
    }
    if (!ownerFilter) {
      // Admin ↔ Admin: still require a search term, no unrestricted dump
      ownerFilter = {};
    }

    const term = (q || "").trim();
    const filter = {
      deletedAt: null,
      ...ownerFilter,
    };

    if (term.length >= 2) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      filter.$or = [
        { appNo: regex },
        { "customer.firstName": regex },
        { "customer.middleName": regex },
        { "customer.lastName": regex },
        { "customer.phone": regex },
        { "customer.alternatePhone": regex },
        { "customer.panNumber": regex },
        { "customer.email": regex },
        {
          $expr: {
            $regexMatch: {
              input: {
                $trim: {
                  input: {
                    $concat: [
                      { $ifNull: ["$customer.firstName", ""] },
                      " ",
                      { $ifNull: ["$customer.middleName", ""] },
                      " ",
                      { $ifNull: ["$customer.lastName", ""] },
                    ],
                  },
                },
              },
              regex: escaped,
              options: "i",
            },
          },
        },
      ];
    } else if (!ownerFilter.rmId && !ownerFilter.asmId && !ownerFilter.rsmId) {
      // No peer book + no search → empty (never dump all loans)
      return res.json({ success: true, loans: [], peerName: `${peer.firstName || ""} ${peer.lastName || ""}`.trim() });
    }

    const applications = await Application.find(filter)
      .select(
        "appNo loanType status requestedAmount approvedLoanAmount customerId customer.firstName customer.middleName customer.lastName customer.phone customer.panNumber customer.email customer.loanAmount createdAt"
      )
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const formattedLoans = applications.map((app) => {
      const c = app.customer || {};
      const applicantName =
        [c.firstName, c.middleName, c.lastName].filter(Boolean).join(" ").trim() ||
        c.email ||
        "Applicant";

      return {
        applicationId: app._id,
        applicationNumber: app.appNo || "N/A",
        applicantName,
        phone: c.phone || "",
        panNumber: c.panNumber || "",
        email: c.email || "",
        customerId: app.customerId || null,
        loanType: app.loanType || "PERSONAL",
        amount: app.approvedLoanAmount || app.requestedAmount || c.loanAmount || 0,
        status: app.status || "DRAFT",
      };
    });

    res.json({
      success: true,
      loans: formattedLoans,
      peerName: `${peer.firstName || ""} ${peer.lastName || ""}`.trim(),
      peerRole: peer.role,
    });
  } catch (error) {
    console.error("Error searching loans for chat:", error);
    res.status(500).json({ message: "Failed to search loans", error: error.message });
  }
});

export default router;
