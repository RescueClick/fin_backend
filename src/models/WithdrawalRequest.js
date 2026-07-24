import mongoose from "mongoose";

const withdrawalRequestSchema = new mongoose.Schema(
  {
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    asmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    amount: { type: Number, required: true, min: 1 },
    note: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["PENDING_ASM", "PENDING_ADMIN", "PAID", "REJECTED"],
      default: "PENDING_ASM",
      index: true,
    },
    rejectReason: { type: String, trim: true, default: "" },
    reviewedByAsm: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    asmReviewedAt: { type: Date },
    reviewedByAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    adminReviewedAt: { type: Date },
    settledPayoutIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Payout" }],
    settledIncentiveIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Incentive" }],
  },
  { timestamps: true }
);

export const WithdrawalRequest = mongoose.model(
  "WithdrawalRequest",
  withdrawalRequestSchema
);
