import { User } from "../models/User.js";

/**
 * Resolve ASM + RSM line from an RM (Personal / Business–Home RSMs share the same ASM).
 */
export async function getReportingLineFromRmId(rmId) {
  if (!rmId) return { asmId: null, rsmIds: [] };
  const rmIdStr = String(rmId);
  const rm = await User.findById(rmIdStr).select("personalRsmId businessHomeRsmId").lean();
  if (!rm) return { asmId: null, rsmIds: [] };
  const rsmIds = [
    ...new Set(
      [rm.personalRsmId, rm.businessHomeRsmId].filter(Boolean).map((id) => String(id)),
    ),
  ];
  let asmId = null;
  if (rsmIds.length > 0) {
    const rsm = await User.findById(rsmIds[0]).select("asmId").lean();
    if (rsm?.asmId) asmId = String(rsm.asmId);
  }
  return { asmId, rsmIds };
}
