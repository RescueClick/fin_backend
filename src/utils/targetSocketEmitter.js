import { ROLES } from "../config/roles.js";

/**
 * Notify the assignee's socket room that their target changed (create/update).
 * Rooms: partner_<id>, rm_<id>, asm_<id>, rsm_<id>
 */
export function emitTargetUpdatedForDoc(io, targetDoc) {
  if (!io || !targetDoc) return;
  const assignedTo = targetDoc.assignedTo?._id
    ? String(targetDoc.assignedTo._id)
    : String(targetDoc.assignedTo);
  const role = targetDoc.role;
  const targetId = targetDoc._id != null ? String(targetDoc._id) : undefined;
  if (!role || !assignedTo) return;

  let room = null;
  if (role === ROLES.PARTNER) room = `partner_${assignedTo}`;
  else if (role === ROLES.RM) room = `rm_${assignedTo}`;
  else if (role === ROLES.ASM) room = `asm_${assignedTo}`;
  else if (role === ROLES.RSM) room = `rsm_${assignedTo}`;
  if (!room) return;

  io.to(room).emit("targetUpdated", {
    targetId,
    assignedTo,
    role,
    month: targetDoc.month,
    year: targetDoc.year,
    fileCountTarget: targetDoc.fileCountTarget,
    disbursementTarget: targetDoc.disbursementTarget ?? targetDoc.targetValue,
    targetValue: targetDoc.targetValue,
    isCalculated: targetDoc.isCalculated,
    timestamp: new Date(),
  });
}

export function emitTargetUpdatesForDocs(io, docs) {
  if (!io || !Array.isArray(docs)) return;
  for (const d of docs) emitTargetUpdatedForDoc(io, d);
}
