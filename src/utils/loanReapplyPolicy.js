/**
 * Open loan files that block starting another application for the same customer.
 * REJECTED / DISBURSED / archived files do NOT block reapply — history is kept.
 */
export const OPEN_LOAN_APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "DOC_INCOMPLETE",
  "DOC_COMPLETE",
  "DOC_SUBMITTED",
  "LOGIN",
  "UNDER_REVIEW",
  "APPROVED",
  "AGREEMENT",
];

export function openLoanApplicationFilter(customerId, extra = {}) {
  return {
    customerId,
    status: { $in: OPEN_LOAN_APPLICATION_STATUSES },
    isArchived: { $ne: true },
    // Open files should not be past-grace soft-deleted
    $or: [{ deletedAt: null }, { deletedAt: { $gt: new Date() } }],
    ...extra,
  };
}
