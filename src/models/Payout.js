import mongoose from "mongoose";

const payoutSchema = new mongoose.Schema(
  {
    application: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Application", 
      required: false 
    },
    cibilReport: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CibilReport",
      required: false
    },
    type: {
      type: String,
      enum: ["LOAN_DISBURSEMENT", "CIBIL_COMMISSION"],
      default: "LOAN_DISBURSEMENT"
    },
    partnerId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User", 
      required: true 
    }, // denormalized for fast access
    amount: { 
      type: Number, 
      required: true 
    }, // Net amount paid / payable to partner
    grossAmount: {
      type: Number,
      default: 0,
    }, // Gross commission before TDS
    payoutPercentage: {
      type: Number,
    }, // Commission rate % on loan
    tdsApplicable: {
      type: Boolean,
      default: true,
    },
    tdsSection: {
      type: String,
      default: "194T", // Section 194T (TDS on payment to partners @ 10%)
    },
    tdsPercentage: {
      type: Number,
      default: 10,
    },
    tdsAmount: {
      type: Number,
      default: 0,
    },
    netAmount: {
      type: Number,
      default: 0,
    },
    invoiceNumber: {
      type: String,
      trim: true,
    },
    invoiceDate: {
      type: Date,
    },
    invoiceSentAt: {
      type: Date,
    },
    invoiceSentTo: {
      type: String,
      trim: true,
    },
    invoiceNotes: {
      type: String,
      trim: true,
    },
    payOutStatus: { 
      type: String, 
      enum: ["PENDING", "DONE", "REJECTED"], 
      default: "PENDING" 
    },
    note: { 
      type: String, 
      trim: true 
    },
    addedBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User", 
      required: false // can be system for automated commissions
    },
  },
  { timestamps: true }
);

export const Payout = mongoose.model("Payout", payoutSchema);
