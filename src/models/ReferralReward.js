import mongoose from "mongoose";

const referralRewardSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    referredUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Application",
      index: true,
    },
    eventType: {
      type: String,
      enum: ["SIGNUP", "DISBURSED"],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "PAID", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    note: { type: String, trim: true },
    approvedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    paymentReference: { type: String, trim: true },
    paidAt: { type: Date },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

referralRewardSchema.index(
  { referredUserId: 1, applicationId: 1, eventType: 1 },
  { unique: true, partialFilterExpression: { eventType: "DISBURSED" } }
);

referralRewardSchema.index(
  { referredUserId: 1, eventType: 1 },
  { unique: true, partialFilterExpression: { eventType: "SIGNUP" } }
);

export const ReferralReward = mongoose.model("ReferralReward", referralRewardSchema);
