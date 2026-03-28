import mongoose from "mongoose";
import { ROLES, RSM_TYPES } from "../config/roles.js";

/** Normalize DB rsmType (legacy casing / spacing). */
export function normalizeRsmTypeValue(rsmType) {
  const s = String(rsmType ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (s === "PERSONAL") return RSM_TYPES.PERSONAL;
  if (s === "BUSINESS_HOME" || s === "BUSINESSHOME") return RSM_TYPES.BUSINESS_HOME;
  return null;
}

/**
 * How an RM is linked to an RSM: at most one PERSONAL-line boss and one BUSINESS_HOME-line boss.
 * RSM actions must only consider RMs on *their* line (slot), not the other product line.
 */
export function rmReportingLineMatch(rsmId, rsmTypeNorm) {
  if (rsmTypeNorm === RSM_TYPES.PERSONAL) {
    return { personalRsmId: rsmId };
  }
  if (rsmTypeNorm === RSM_TYPES.BUSINESS_HOME) {
    return { businessHomeRsmId: rsmId };
  }
  return {
    $or: [{ personalRsmId: rsmId }, { businessHomeRsmId: rsmId }],
  };
}

/**
 * Validate RM's two RSM links: different users; each must be RSM with matching rsmType.
 */
export async function assertValidRmRsmPair(personalRsmId, businessHomeRsmId) {
  const User = mongoose.models?.User;
  if (!User) {
    return { ok: true };
  }
  if (personalRsmId && businessHomeRsmId) {
    if (String(personalRsmId) === String(businessHomeRsmId)) {
      return {
        ok: false,
        message:
          "RM cannot use the same person as both Personal RSM and Business/Home RSM. Assign two different RSMs.",
      };
    }
  }

  if (personalRsmId) {
    const u = await User.findById(personalRsmId).select("role rsmType").lean();
    if (!u || u.role !== ROLES.RSM) {
      return { ok: false, message: "personalRsmId must reference an RSM user." };
    }
    if (u.rsmType && u.rsmType !== RSM_TYPES.PERSONAL) {
      return {
        ok: false,
        message: "personalRsmId must be a PERSONAL-type RSM (not Business/Home).",
      };
    }
  }

  if (businessHomeRsmId) {
    const u = await User.findById(businessHomeRsmId).select("role rsmType").lean();
    if (!u || u.role !== ROLES.RSM) {
      return { ok: false, message: "businessHomeRsmId must reference an RSM user." };
    }
    if (u.rsmType && u.rsmType !== RSM_TYPES.BUSINESS_HOME) {
      return {
        ok: false,
        message: "businessHomeRsmId must be a BUSINESS_HOME-type RSM (not Personal).",
      };
    }
  }

  return { ok: true };
}
