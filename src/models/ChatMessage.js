import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    text: {
      type: String,
      trim: true,
      default: "",
    },
    attachments: [
      {
        url: { type: String, required: true },
        name: { type: String, default: "" },
        size: { type: Number, default: 0 },
        mimeType: { type: String, default: "" },
      },
    ],
    loanRef: {
      applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application" },
      applicationNumber: { type: String, trim: true },
      applicantName: { type: String, trim: true },
      loanType: { type: String, trim: true },
      amount: { type: Number },
      status: { type: String, trim: true },
    },
    status: {
      type: String,
      enum: ["SENT", "DELIVERED", "READ"],
      default: "SENT",
    },
    readAt: {
      type: Date,
    },
    deletedFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true }
);

chatMessageSchema.index({ conversationId: 1, createdAt: 1 });
chatMessageSchema.index({ sender: 1, recipient: 1 });

export const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);
