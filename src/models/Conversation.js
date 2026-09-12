import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
    // Quick preview of the latest message
    lastMessage: {
      text: { type: String, default: "" },
      sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      senderName: { type: String, default: "" },
      hasAttachment: { type: Boolean, default: false },
      createdAt: { type: Date, default: Date.now },
    },
    // Map of userId string -> unread message count
    unreadCounts: {
      type: Map,
      of: Number,
      default: {},
    },
    // Optional active loan file context attached to this conversation
    loanRef: {
      applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application" },
      applicationNumber: { type: String, trim: true },
      applicantName: { type: String, trim: true },
      loanType: { type: String, trim: true },
      amount: { type: Number },
      status: { type: String, trim: true },
    },
    // For archiving or clearing conversation per user
    clearedFor: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        clearedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1 });
conversationSchema.index({ "lastMessage.createdAt": -1 });

export const Conversation = mongoose.model("Conversation", conversationSchema);
