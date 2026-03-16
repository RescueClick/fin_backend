// models/Target.js
import mongoose from "mongoose";
import { ROLES } from "../config/roles.js";

const targetSchema = new mongoose.Schema(
  {
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // Admin
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // Partner, RM, RSM, or ASM
    role: { 
      type: String, 
      enum: [ROLES.PARTNER, ROLES.RM, ROLES.RSM, ROLES.ASM], 
      required: true 
    },
    
    month: { type: Number, required: true }, // 1 = Jan ... 12 = Dec
    year: { type: Number, required: true },

    // Partner Target System (Base Level)
    // File Count Target (only for PARTNER)
    fileCountTarget: { 
      type: Number, 
      default: 4  // Minimum 4 files per month (only for partners)
    },
    achievedFileCount: { 
      type: Number, 
      default: 0  // Actual files submitted (disbursed applications)
    },
    
    // Disbursement Amount Target
    disbursementTarget: { 
      type: Number, 
      required: true,
      default: 2000000  // Minimum ₹20,00,000 per month (for partners)
      // For RM/RSM/ASM: calculated as sum of targets below them
    },
    achievedDisbursement: { 
      type: Number, 
      default: 0  // Actual disbursed amount (calculated from below for RM/RSM/ASM)
    },

    // Legacy field for backward compatibility
    targetValue: { 
      type: Number, 
      default: 0  // Same as disbursementTarget for backward compatibility
    },
    achievedValue: { 
      type: Number, 
      default: 0  // Same as achievedDisbursement for backward compatibility
    },

    // Flag to indicate if target is calculated (for RM/RSM/ASM) or directly assigned (for Partner)
    isCalculated: {
      type: Boolean,
      default: false  // true for RM/RSM/ASM (calculated from below), false for Partner (directly assigned)
    },
  },
  { timestamps: true }
);

export const Target = mongoose.model("Target", targetSchema);

