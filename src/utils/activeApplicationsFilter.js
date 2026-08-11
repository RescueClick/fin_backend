/**
 * Applications still visible in product UI.
 * REJECTED apps often get deletedAt set to a future cleanup date (e.g. +90 days).
 * Those must stay visible until cleanup actually runs (deletedAt <= now).
 */
export function activeApplicationsFilter(extra = {}) {
  const baseFilter = {
    isArchived: { $ne: true },
    $or: [{ deletedAt: null }, { deletedAt: { $gt: new Date() } }],
  };

  if (!extra || Object.keys(extra).length === 0) return baseFilter;

  // If extra contains $or, $and, or other complex operators that might conflict with baseFilter,
  // we must combine them safely using $and to prevent key overwriting.
  return {
    $and: [baseFilter, extra]
  };
}
