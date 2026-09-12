import mongoose from "mongoose";
import { ROLES, ASM_TYPES, RSM_TYPES } from "../config/roles.js";

/** Normalize DB asmType/rsmType (legacy casing / spacing). */
export function normalizeAsmTypeValue(asmType) {
  const s = String(asmType ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (s === "PERSONAL") return ASM_TYPES.PERSONAL;
  if (s === "BUSINESS") return ASM_TYPES.BUSINESS;
  if (s === "HOME_LAP" || s === "HOMELAP" || s === "HOME_AND_LAP" || s === "HOME_LAP_LOAN") {
    return ASM_TYPES.HOME_LAP;
  }
  if (s === "BUSINESS_HOME" || s === "BUSINESSHOME") return ASM_TYPES.BUSINESS_HOME;
  return null;
}

export const normalizeRsmTypeValue = normalizeAsmTypeValue;

/**
 * How an RM is linked to a specialized ASM (or legacy RSM):
 * - PERSONAL-line: personalAsmId / personalRsmId
 * - BUSINESS-line: businessAsmId / businessRsmId
 * - HOME_LAP-line: homeLapAsmId / homeLapRsmId
 */
export function rmReportingLineMatch(asmId, asmTypeNorm) {
  if (asmTypeNorm === ASM_TYPES.PERSONAL) {
    return { $or: [{ personalAsmId: asmId }, { personalRsmId: asmId }] };
  }
  if (asmTypeNorm === ASM_TYPES.BUSINESS) {
    return {
      $or: [
        { businessAsmId: asmId },
        { businessRsmId: asmId },
        { businessHomeRsmId: asmId },
        { businessHomeAsmId: asmId },
      ],
    };
  }
  if (asmTypeNorm === ASM_TYPES.HOME_LAP) {
    return {
      $or: [
        { homeLapAsmId: asmId },
        { homeLapRsmId: asmId },
        { businessHomeRsmId: asmId },
        { businessHomeAsmId: asmId },
      ],
    };
  }
  if (asmTypeNorm === ASM_TYPES.BUSINESS_HOME) {
    return {
      $or: [
        { businessHomeAsmId: asmId },
        { businessHomeRsmId: asmId },
        { businessAsmId: asmId },
        { businessRsmId: asmId },
        { homeLapAsmId: asmId },
        { homeLapRsmId: asmId },
      ],
    };
  }
  return {
    $or: [
      { personalAsmId: asmId },
      { personalRsmId: asmId },
      { businessAsmId: asmId },
      { businessRsmId: asmId },
      { homeLapAsmId: asmId },
      { homeLapRsmId: asmId },
      { businessHomeAsmId: asmId },
      { businessHomeRsmId: asmId },
    ],
  };
}

/**
 * Validate RM's specialized ASM links (Personal, Business, Home+LAP).
 * Ensures:
 * 1. IDs are distinct.
 * 2. Each ID references an active ASM with matching asmType.
 * 3. All assigned ASMs report to the same parent RSM.
 */
export async function assertValidRmAsmAssignments({
  personalAsmId,
  businessAsmId,
  homeLapAsmId,
  businessHomeAsmId,
  personalRsmId,
  businessRsmId,
  homeLapRsmId,
  businessHomeRsmId,
}) {
  const User = mongoose.models?.User;
  if (!User) {
    return { ok: true };
  }

  const pId = personalAsmId || personalRsmId;
  const bId = businessAsmId || businessRsmId;
  const hId = homeLapAsmId || homeLapRsmId;
  const bhId = businessHomeAsmId || businessHomeRsmId;

  const ids = [
    { key: "personalAsmId", id: pId, expectedType: ASM_TYPES.PERSONAL, label: "Personal Loan ASM" },
    { key: "businessAsmId", id: bId, expectedType: ASM_TYPES.BUSINESS, label: "Business Loan ASM" },
    { key: "homeLapAsmId", id: hId, expectedType: ASM_TYPES.HOME_LAP, label: "Home & LAP Loan ASM" },
    ...(bhId ? [{ key: "businessHomeAsmId", id: bhId, expectedType: ASM_TYPES.BUSINESS_HOME, label: "Business/Home Loan ASM" }] : []),
  ].filter((item) => Boolean(item.id));

  // Check uniqueness among provided manager IDs
  const seenIds = new Map();
  for (const item of ids) {
    const idStr = String(item.id);
    if (seenIds.has(idStr)) {
      return {
        ok: false,
        message: `RM cannot use the same person for both ${seenIds.get(idStr)} and ${item.label}. Assign distinct ASMs.`,
      };
    }
    seenIds.set(idStr, item.label);
  }

  // Fetch all assigned ASMs (or legacy RSM role)
  const userDocs = await User.find({
    _id: { $in: ids.map((item) => item.id) },
    role: { $in: [ROLES.ASM, ROLES.RSM] },
  })
    .select("_id role asmType rsmType rsmId asmId firstName lastName")
    .lean();

  const docMap = new Map(userDocs.map((u) => [String(u._id), u]));

  let commonRsmId = null;

  for (const item of ids) {
    const idStr = String(item.id);
    const u = docMap.get(idStr);
    if (!u) {
      return { ok: false, message: `${item.label} not found or is not an ASM.` };
    }

    const currentType = u.asmType || u.rsmType;
    const normType = normalizeAsmTypeValue(currentType);
    if (normType) {
      const matches =
        normType === item.expectedType ||
        (normType === ASM_TYPES.BUSINESS_HOME &&
          (item.expectedType === ASM_TYPES.BUSINESS || item.expectedType === ASM_TYPES.HOME_LAP));

      if (!matches) {
        return {
          ok: false,
          message: `${item.label} must be of type ${item.expectedType} (found ${currentType}).`,
        };
      }
    }

    const parentId = u.rsmId || u.asmId;
    if (parentId) {
      const rsmStr = String(parentId);
      if (!commonRsmId) {
        commonRsmId = rsmStr;
      } else if (commonRsmId !== rsmStr) {
        return {
          ok: false,
          message: "All assigned ASMs must report to the same RSM.",
        };
      }
    }
  }

  return { ok: true, rsmId: commonRsmId, asmId: commonRsmId };
}

/** Backward compatibility alias */
export const assertValidRmRsmAssignments = assertValidRmAsmAssignments;

export async function assertValidRmRsmPair(personalRsmId, businessHomeRsmId) {
  return assertValidRmAsmAssignments({ personalRsmId, businessHomeRsmId });
}
