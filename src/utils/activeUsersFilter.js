/**
 * Standard filter for active (non-soft-deleted) users across all roles.
 */
export function activeUsersFilter(extra = {}) {
  const baseFilter = {
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };

  if (!extra || Object.keys(extra).length === 0) return baseFilter;

  return {
    $and: [baseFilter, extra],
  };
}
