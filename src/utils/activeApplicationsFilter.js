/**
 * Applications still visible in product UI.
 * REJECTED apps often get deletedAt set to a future cleanup date (e.g. +90 days).
 * Those must stay visible until cleanup actually runs (deletedAt <= now).
 */
export function activeApplicationsFilter(extra = {}) {
  return {
    ...extra,
    isArchived: { $ne: true },
    $or: [{ deletedAt: null }, { deletedAt: { $gt: new Date() } }],
  };
}
