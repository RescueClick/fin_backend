/**
 * RSM → ASM → RM → Partner scope helpers.
 * Senior Manager: RSM
 * Specialized Line Managers: ASMs (Personal, Business, Home/LAP)
 * Relationship Managers: RMs
 */
import { User } from "../models/User.js";
import { ROLES } from "../config/roles.js";
import mongoose from "mongoose";

/** All RM ids that belong under a Senior Regional Sales Manager (RSM). */
export async function getRmIdsUnderRsm(rsmId, session = null) {
  if (!rsmId) return [];
  const rsmOid = new mongoose.Types.ObjectId(rsmId);

  // Subordinate ASMs under this RSM
  let asmQuery = User.find({
    role: { $in: [ROLES.ASM, ROLES.RSM] },
    $or: [{ rsmId: rsmOid }, { asmId: rsmOid }],
    status: { $ne: "DELETED" },
  }).select("_id");
  if (session) asmQuery = asmQuery.session(session);
  const asms = await asmQuery.lean();
  const asmIds = asms.map((a) => a._id);

  let rmQuery = User.find({
    role: ROLES.RM,
    status: { $ne: "DELETED" },
    $or: [
      { rsmId: rsmOid },
      { asmId: rsmOid },
      { personalAsmId: { $in: asmIds } },
      { businessAsmId: { $in: asmIds } },
      { homeLapAsmId: { $in: asmIds } },
      { personalRsmId: { $in: asmIds } },
      { businessRsmId: { $in: asmIds } },
      { homeLapRsmId: { $in: asmIds } },
      { businessHomeRsmId: { $in: asmIds } },
    ],
  }).select("_id");
  if (session) rmQuery = rmQuery.session(session);
  const rms = await rmQuery.lean();
  return rms.map((r) => r._id);
}

/** All RM ids that belong under a manager (handles both Senior RSM and Specialized ASM). */
export async function getRmIdsUnderAsm(managerId, session = null) {
  if (!managerId) return [];
  const mOid = new mongoose.Types.ObjectId(managerId);

  // Check role of manager
  const manager = await User.findById(mOid).select("role").lean();
  if (manager?.role === ROLES.RSM) {
    return getRmIdsUnderRsm(managerId, session);
  }

  // If manager is specialized ASM
  let rmQuery = User.find({
    role: ROLES.RM,
    status: { $ne: "DELETED" },
    $or: [
      { personalAsmId: mOid },
      { businessAsmId: mOid },
      { homeLapAsmId: mOid },
      { personalRsmId: mOid },
      { businessRsmId: mOid },
      { homeLapRsmId: mOid },
      { businessHomeRsmId: mOid },
      { asmId: mOid },
    ],
  }).select("_id");
  if (session) rmQuery = rmQuery.session(session);
  const rms = await rmQuery.lean();
  return rms.map((r) => r._id);
}

/** Resolve parent RSM id for an RM. */
export async function resolveRsmIdForRm(rm) {
  if (!rm) return null;
  if (rm.rsmId) return rm.rsmId;
  if (rm.asmId) return rm.asmId;

  const asmId = rm.personalAsmId || rm.businessAsmId || rm.homeLapAsmId || rm.personalRsmId || rm.businessRsmId;
  if (!asmId) return null;

  const asm = await User.findOne({ _id: asmId, role: { $in: [ROLES.ASM, ROLES.RSM] } })
    .select("rsmId asmId")
    .lean();
  return asm?.rsmId || asm?.asmId || null;
}

export const resolveAsmIdForRm = resolveRsmIdForRm;

/**
 * Full scope ids (RSM/ASM/RM/Partners) for Senior Manager or Line Manager.
 */
export async function getRsmScopeIds(rsmId) {
  const rsmOid = new mongoose.Types.ObjectId(rsmId);
  const asmIds = (
    await User.find({
      role: { $in: [ROLES.ASM, ROLES.RSM] },
      $or: [{ rsmId: rsmOid }, { asmId: rsmOid }],
    })
      .select("_id")
      .lean()
  ).map((a) => a._id);

  const rmIds = await getRmIdsUnderRsm(rsmId);

  const partnerIds = (
    await User.find({
      role: ROLES.PARTNER,
      rmId: { $in: rmIds },
      status: { $ne: "PENDING" },
    })
      .select("_id")
      .lean()
  ).map((p) => p._id);

  return { rsmIds: [rsmOid], asmIds, rmIds, partnerIds };
}

export async function getAsmScopeIds(managerId) {
  const mOid = new mongoose.Types.ObjectId(managerId);
  const manager = await User.findById(mOid).select("role").lean();
  if (manager?.role === ROLES.RSM) {
    const scope = await getRsmScopeIds(managerId);
    return { rsmIds: scope.asmIds, asmIds: scope.asmIds, rmIds: scope.rmIds, partnerIds: scope.partnerIds };
  }

  // If specialized ASM
  const rmIds = await getRmIdsUnderAsm(managerId);
  const partnerIds = (
    await User.find({
      role: ROLES.PARTNER,
      rmId: { $in: rmIds },
      status: { $ne: "PENDING" },
    })
      .select("_id")
      .lean()
  ).map((p) => p._id);

  return { rsmIds: [mOid], asmIds: [mOid], rmIds, partnerIds };
}

/** Prefer stable disbursement timestamp over updatedAt (RM moves bump updatedAt). */
export function getDisbursedAt(app) {
  if (!app) return null;
  if (app.disbursedAt) {
    const d = new Date(app.disbursedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (app.disbursedDate) {
    const d = new Date(app.disbursedDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (Array.isArray(app.stageHistory)) {
    const stage = app.stageHistory.find(
      (s) => s.to && String(s.to).toUpperCase() === "DISBURSED"
    );
    if (stage?.at) {
      const d = new Date(stage.at);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  if (app.createdAt) {
    const d = new Date(app.createdAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (app.updatedAt) {
    const d = new Date(app.updatedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

export function isDateInRange(date, start, end) {
  if (!date || Number.isNaN(date.getTime())) return false;
  return date >= start && date < end;
}
