import { Application } from "../models/Application.js";

/**
 * Open loan files that block starting another application.
 * REJECTED files are kept, but reapply is locked for 3 months (matches deletedAt schedule).
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

/** 3 months — same window used when REJECTED sets deletedAt */
export const REJECT_REAPPLY_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

export function openLoanApplicationFilter(customerId, extra = {}) {
  return {
    customerId,
    status: { $in: OPEN_LOAN_APPLICATION_STATUSES },
    isArchived: { $ne: true },
    $or: [{ deletedAt: null }, { deletedAt: { $gt: new Date() } }],
    ...extra,
  };
}

function unlockAtForRejectedApp(app) {
  if (app.deletedAt) {
    return new Date(app.deletedAt).getTime();
  }
  const rejectedAt = new Date(app.updatedAt || app.createdAt).getTime();
  return rejectedAt + REJECT_REAPPLY_COOLDOWN_MS;
}

/**
 * Returns a blocker if the customer cannot start a new loan application.
 * - Open in-progress file → block
 * - REJECTED within 3-month cooldown → block (old file kept)
 * After 3 months → allow reapply
 */
export async function findCustomerApplyBlocker(customerId) {
  const openApp = await Application.findOne(
    openLoanApplicationFilter(customerId)
  ).sort({ updatedAt: -1 });

  if (openApp) {
    return {
      type: "OPEN",
      app: openApp,
      message:
        "An open loan application already exists for this customer. Finish or close it before applying again.",
      unlockAt: null,
    };
  }

  const rejectedApps = await Application.find({
    customerId,
    status: "REJECTED",
    isArchived: { $ne: true },
  })
    .sort({ updatedAt: -1 })
    .limit(10)
    .lean();

  const now = Date.now();
  for (const app of rejectedApps) {
    const unlockAtMs = unlockAtForRejectedApp(app);
    if (unlockAtMs > now) {
      const unlockAt = new Date(unlockAtMs);
      return {
        type: "REJECT_COOLDOWN",
        app,
        unlockAt,
        message: `This customer was rejected and can apply again only after 3 months (from ${unlockAt.toLocaleDateString("en-IN")}). The previous loan file is kept.`,
      };
    }
  }

  return null;
}
