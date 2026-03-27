import mongoose from "mongoose";
import { ReassignmentAuditLog } from "../models/ReassignmentAuditLog.js";

function toObjectIdOrNull(value) {
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

export async function persistReassignmentAudit(audit, req, session = null) {
  if (!audit) return;

  const payload = {
    action: audit.action,
    policyVersion: audit.policyVersion,
    changedAt: audit.changedAt ? new Date(audit.changedAt) : new Date(),
    changedBy: toObjectIdOrNull(audit.changedBy),
    oldUserId: toObjectIdOrNull(audit.oldUserId),
    newUserId: toObjectIdOrNull(audit.newUserId),
    sourceRoute: req?.originalUrl || "",
    actorRole: req?.user?.role || "",
    requestId: req?.id || req?.headers?.["x-request-id"] || "",
    ip: req?.ip || "",
  };

  await ReassignmentAuditLog.create([{ ...payload }], { session });
}
