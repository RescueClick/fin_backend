import mongoose from "mongoose";
import { ALL_ROLES } from "../config/roles.js";

const deleteAccountRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    role: {
      type: String,
      enum: ALL_ROLES,
      required: true,
    },
    reason: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED", "REJECTED"],
      default: "PENDING",
      index: true,
    },
    source: {
      type: String,
      enum: ["WEB", "MOBILE", "PORTAL"],
      default: "WEB",
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    processedAt: {
      type: Date,
    },
    meta: {
      type: Object,
    },
  },
  { timestamps: true }
);

deleteAccountRequestSchema.index({ user: 1, status: 1 });

export const DeleteAccountRequest = mongoose.model(
  "DeleteAccountRequest",
  deleteAccountRequestSchema
);


