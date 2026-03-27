import mongoose from "mongoose";

const reassignmentAuditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true },
    policyVersion: { type: String, required: true, trim: true },
    changedAt: { type: Date, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    oldUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    newUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    sourceRoute: { type: String, trim: true },
    actorRole: { type: String, trim: true },
    requestId: { type: String, trim: true },
    ip: { type: String, trim: true },
  },
  { timestamps: true }
);

reassignmentAuditLogSchema.index({ action: 1, changedAt: -1 });

export const ReassignmentAuditLog = mongoose.model(
  "ReassignmentAuditLog",
  reassignmentAuditLogSchema
);
