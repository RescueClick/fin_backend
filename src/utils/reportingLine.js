import { User } from "../models/User.js";

/**
 * Resolve Senior RSM + Specialized ASM line from an RM.
 */
export async function getReportingLineFromRmId(rmId) {
  if (!rmId) return { rsmId: null, asmId: null, asmIds: [], rsmIds: [] };
  const rmIdStr = String(rmId);
  const rm = await User.findById(rmIdStr)
    .select("personalAsmId businessAsmId homeLapAsmId personalRsmId businessRsmId homeLapRsmId businessHomeRsmId rsmId asmId")
    .lean();
  if (!rm) return { rsmId: null, asmId: null, asmIds: [], rsmIds: [] };

  const specializedAsmIds = [
    ...new Set(
      [
        rm.personalAsmId,
        rm.businessAsmId,
        rm.homeLapAsmId,
        rm.personalRsmId,
        rm.businessRsmId,
        rm.homeLapRsmId,
        rm.businessHomeRsmId,
      ]
        .filter(Boolean)
        .map((id) => String(id))
    ),
  ];

  let seniorRsmId = rm.rsmId ? String(rm.rsmId) : (rm.asmId ? String(rm.asmId) : null);
  if (!seniorRsmId && specializedAsmIds.length > 0) {
    const asm = await User.findById(specializedAsmIds[0]).select("rsmId asmId").lean();
    if (asm?.rsmId) seniorRsmId = String(asm.rsmId);
    else if (asm?.asmId) seniorRsmId = String(asm.asmId);
  }

  return {
    rsmId: seniorRsmId,
    asmId: seniorRsmId, // for backward compat with socket rooms
    asmIds: specializedAsmIds,
    rsmIds: [...specializedAsmIds, ...(seniorRsmId ? [seniorRsmId] : [])], // ensure notifications reach both senior and line managers
  };
}
