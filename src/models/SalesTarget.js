import mongoose from "mongoose";
import { ROLES } from "../config/roles.js";

export const TARGET_LEVELS = [ROLES.RSM, ROLES.ASM, ROLES.RM];
export const LOAN_LINES = ["ALL", "PERSONAL", "BUSINESS", "HOME_LAP", "BUSINESS_HOME"];

/**
 * Monthly sales target: Admin → RSM → ASM (per loan line) → RM (per loan line).
 * Achievement is computed live from DISBURSED applications; the final* fields
 * are only written when the month is locked.
 */
const salesTargetSchema = new mongoose.Schema(
  {
    level: { type: String, enum: TARGET_LEVELS, required: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    parentTargetId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesTarget", default: null },

    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    // RSM targets cover all lines ("ALL"); ASM/RM targets are scoped to the ASM's loan line.
    loanLine: { type: String, enum: LOAN_LINES, default: "ALL" },

    disbursementTarget: { type: Number, required: true, min: 0, default: 0 },
    fileCountTarget: { type: Number, required: true, min: 0, default: 0 },

    status: { type: String, enum: ["DRAFT", "PUBLISHED"], default: "DRAFT" },
    publishedAt: { type: Date, default: null },

    lockedAt: { type: Date, default: null },
    finalAchievedDisbursement: { type: Number, default: null },
    finalAchievedFileCount: { type: Number, default: null },
  },
  { timestamps: true }
);

salesTargetSchema.index({ assignedTo: 1, month: 1, year: 1, loanLine: 1 }, { unique: true });
salesTargetSchema.index({ assignedBy: 1, month: 1, year: 1 });
salesTargetSchema.index({ parentTargetId: 1 });
salesTargetSchema.index({ year: 1, month: 1, level: 1 });

export const SalesTarget = mongoose.model("SalesTarget", salesTargetSchema);
