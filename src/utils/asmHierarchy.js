/**
 * ASM → RSM → RM → Partner scope helpers.
 * RMs may link via personalRsmId / businessHomeRsmId OR direct asmId.
 */
import { User } from "../models/User.js";
import { ROLES } from "../config/roles.js";

import mongoose from "mongoose";

/** All RM ids that belong under an ASM (strict direct asmId priority + fallback to RSM chain). */
export async function getRmIdsUnderAsm(asmId, session = null) {
  if (!asmId) return [];
  const asmOid = new mongoose.Types.ObjectId(asmId);

  let rsmQuery = User.find({
    role: ROLES.RSM,
    asmId: asmOid,
    status: { $ne: "DELETED" },
  }).select("_id");
  if (session) rsmQuery = rsmQuery.session(session);
  const rsms = await rsmQuery.lean();
  const rsmIds = rsms.map((r) => r._id);

  let rmQuery = User.find({
    role: ROLES.RM,
    status: { $ne: "DELETED" },
    $or: [
      { asmId: asmOid },
      {
        asmId: { $in: [null, undefined] },
        $or: [
          { personalRsmId: { $in: rsmIds } },
          { businessHomeRsmId: { $in: rsmIds } },
        ],
      },
    ],
  }).select("_id");
  if (session) rmQuery = rmQuery.session(session);
  const rms = await rmQuery.lean();
  return rms.map((r) => r._id);
}

/** Resolve ASM id for an RM via direct asmId or RSM parents. */
export async function resolveAsmIdForRm(rm) {
  if (!rm) return null;
  if (rm.asmId) return rm.asmId;

  const rsmId = rm.personalRsmId || rm.businessHomeRsmId;
  if (!rsmId) return null;

  const rsm = await User.findOne({ _id: rsmId, role: ROLES.RSM })
    .select("asmId")
    .lean();
  return rsm?.asmId || null;
}

/**
 * Full ASM scope used by partner lists, payouts, incentives.
 * Partners are resolved from current rmId (survives RM→RM moves).
 */
export async function getAsmScopeIds(asmId) {
  const rsmIds = (
    await User.find({ role: ROLES.RSM, asmId }).select("_id").lean()
  ).map((r) => r._id);

  const rmIds = await getRmIdsUnderAsm(asmId);

  const partnerIds = (
    await User.find({
      role: ROLES.PARTNER,
      rmId: { $in: rmIds },
      status: { $ne: "PENDING" },
    })
      .select("_id")
      .lean()
  ).map((p) => p._id);

  return { rsmIds, rmIds, partnerIds };
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
