import mongoose from "mongoose";
import { ASM_TYPES, RSM_TYPES } from "../config/roles.js";

const bankMasterSchema = new mongoose.Schema(
  {
    bankName: { type: String, required: true, trim: true },
    loanType: { type: String, required: true, trim: true },

    // Logo stored on S3 (uploaded via multer-s3)
    bankLogoUrl: { type: String, required: true },

    portalLoginId: { type: String, required: true, trim: true },
    portalPassword: { type: String, required: true, trim: true },
    portalLink: { type: String, required: true, trim: true },

    /**
     * Which ASM type(s) can see/use this bank.
     * - PERSONAL
     * - BUSINESS
     * - HOME_LAP
     */
    asmTypes: {
      type: [String],
      enum: Object.values(ASM_TYPES),
      default: [],
      index: true,
    },
    rsmTypes: {
      type: [String],
      enum: Object.values(RSM_TYPES),
      default: [],
      index: true,
    },

    // Array of pincodes where this bank operates
    serviceablePincodes: { 
      type: [String], 
      default: [] 
    },

    isActive: { type: Boolean, default: true },

    // For audit
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const BankMaster = mongoose.model("BankMaster", bankMasterSchema);


