import mongoose from "mongoose";

const cibilReportSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    customerPhone: {
      type: String,
      required: true,
      trim: true,
    },
    customerPan: {
      type: String,
      trim: true,
    },
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    razorpayOrderId: {
      type: String,
    },
    razorpayPaymentId: {
      type: String,
    },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED"],
      default: "PENDING",
    },
    score: {
      type: Number,
    },
    rawReportData: {
      type: Object, // JSON response from the actual API provider
    },
    status: {
      type: String,
      enum: ["INITIATED", "SUCCESS", "FAILED"],
      default: "INITIATED",
    },
    ipAddress: {
      type: String,
    },
    commissionAmount: {
      type: Number,
      default: 0,
    },
    feeCollected: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export const CibilReport = mongoose.model("CibilReport", cibilReportSchema);
