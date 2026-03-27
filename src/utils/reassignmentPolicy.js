// Reassignment policy for user deactivation flows.
// Keep history and settled finance immutable; move only active workload.

export const LOCKED_APPLICATION_STATUSES = ["DISBURSED", "REJECTED"];
export const REASSIGNABLE_APPLICATION_STATUS_FILTER = {
  $nin: LOCKED_APPLICATION_STATUSES,
};

export const LOCKED_PAYOUT_STATUS = "DONE";
export const REASSIGNABLE_PAYOUT_STATUS = "PENDING";

export const LOCKED_INCENTIVE_STATUS = "PAID";
export const REASSIGNABLE_INCENTIVE_STATUS = "PENDING";

export function buildReassignableApplicationFilter(baseFilter = {}) {
  return {
    ...baseFilter,
    status: REASSIGNABLE_APPLICATION_STATUS_FILTER,
  };
}

/** Bump when locked statuses or payout/incentive rules change. */
export const REASSIGNMENT_POLICY_VERSION = "1.0.0";

/**
 * Standard audit block for deactivation + reassignment API responses.
 * @param {object} opts
 * @param {string} [opts.changedBy] - JWT subject / actor user id
 * @param {string} [opts.oldUserId] - User being deactivated or scope root
 * @param {string|null} [opts.newUserId] - Replacement user id, or null
 * @param {string} [opts.action] - Route-specific label for logs/integrations
 */
export function buildReassignmentAudit({
  changedBy,
  oldUserId,
  newUserId = null,
  action = "deactivation_reassignment",
}) {
  const id = (v) => (v != null && v !== "" ? String(v) : null);
  return {
    policyVersion: REASSIGNMENT_POLICY_VERSION,
    changedAt: new Date().toISOString(),
    changedBy: id(changedBy),
    oldUserId: id(oldUserId),
    newUserId: id(newUserId),
    action,
  };
}
