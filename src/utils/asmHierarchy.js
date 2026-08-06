/**
 * ASM → RSM → RM → Partner scope helpers.
 * RMs may link via personalRsmId / businessHomeRsmId OR direct asmId.
 */
import { User } from "../models/User.js";
import { ROLES } from "../config/roles.js";

/** All RM ids that belong under an ASM (RSM chain + direct asmId). */
export async function getRmIdsUnderAsm(asmId, session = null) {
  let rsmQuery = User.find({ role: ROLES.RSM, asmId }).select("_id");
  if (session) rsmQuery = rsmQuery.session(session);
  const rsms = await rsmQuery.lean();
  const rsmIds = rsms.map((r) => r._id);
  let rmQuery = User.find({
    role: ROLES.RM,
    $or: [
      { personalRsmId: { $in: rsmIds } },
      { businessHomeRsmId: { $in: rsmIds } },
      { asmId },
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
  const stage = app?.stageHistory?.find((s) => s.to === "DISBURSED");
  if (stage?.at) return new Date(stage.at);
  if (app?.disbursedDate) return new Date(app.disbursedDate);
  if (app?.updatedAt) return new Date(app.updatedAt);
  return null;
}

export function isDateInRange(date, start, end) {
  if (!date || Number.isNaN(date.getTime())) return false;
  return date >= start && date < end;
}
