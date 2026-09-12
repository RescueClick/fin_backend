import mongoose from "mongoose";
import { ROLES } from "../config/roles.js";

const incentiveSchema = new mongoose.Schema(
  {
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    rsmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    asmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true,
    },
    month: { type: Number, required: true }, // 1-12
    year: { type: Number, required: true },

    // Optional snapshot fields for legacy audit compatibility
    fileCountTarget: { type: Number, default: 0 },
    achievedFileCount: { type: Number, default: 0 },
    disbursementTarget: { type: Number, default: 0 },
    achievedDisbursement: { type: Number, default: 0 },

    // How the incentive was calculated
    basis: {
      type: String,
      enum: ["PERCENT", "FIXED"],
      required: true,
    },
    percentValue: { type: Number }, // when basis === PERCENT
    fixedValue: { type: Number }, // when basis === FIXED

    // Final incentive amount actually paid / approved
    amount: { type: Number, required: true },

    // Status & audit
    status: {
      type: String,
      enum: ["PENDING", "PAID"],
      default: "PENDING",
    },
    paidAt: { type: Date },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

// Simple guard to ensure amount is positive
incentiveSchema.pre("save", function (next) {
  if (this.amount <= 0) {
    return next(new Error("Incentive amount must be greater than zero"));
  }
  next();
});

export const Incentive = mongoose.model("Incentive", incentiveSchema);


