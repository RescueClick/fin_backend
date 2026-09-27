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

/** One customer = one loan file: a LEAD also counts as the customer's file. */
export const ACTIVE_FILE_STATUSES = ["LEAD", ...OPEN_LOAN_APPLICATION_STATUSES];

/** Early-stage files that a new submission should continue instead of duplicating. */
export const REUSABLE_FILE_STATUSES = ["LEAD", "DRAFT", "DOC_INCOMPLETE"];

/** Lead sources not owned by a specific partner — any partner may take them over. */
const UNOWNED_LEAD_SOURCES = ["PUBLIC_REFERRAL", "CUSTOMER_DIRECT"];

/** 3 months — same window used when REJECTED sets deletedAt */
export const REJECT_REAPPLY_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

export function openLoanApplicationFilter(customerId, extra = {}) {
  return {
    customerId,
    status: { $in: ACTIVE_FILE_STATUSES },
    isArchived: { $ne: true },
    $or: [{ deletedAt: null }, { deletedAt: { $gt: new Date() } }],
    ...extra,
  };
}

export function blockerResponse(blocker) {
  return {
    message: blocker.message,
    reason: blocker.type,
    existingAppNo: blocker.app?.appNo,
    existingStatus: blocker.app?.status,
    canApplyAfter: blocker.unlockAt || null,
  };
}

/**
 * Decide what a new submission for this customer should do:
 * - { app }     → continue this existing LEAD/DRAFT/DOC_INCOMPLETE file (any loan type)
 * - { blocker } → refuse (another partner's open file, open file, or reject cooldown)
 * - {}          → safe to create a new file
 */
export async function resolveCustomerFile(customerId, { partnerId } = {}) {
  const reusable = await Application.findOne(
    openLoanApplicationFilter(customerId, { status: { $in: REUSABLE_FILE_STATUSES } })
  ).sort({ updatedAt: -1 });

  if (reusable) {
    const ownedByOtherPartner =
      partnerId &&
      reusable.partnerId &&
      String(reusable.partnerId) !== String(partnerId) &&
      !UNOWNED_LEAD_SOURCES.includes(reusable.leadSource);

    if (!ownedByOtherPartner) {
      const otherFile = await findCustomerApplyBlocker(customerId, { excludeAppId: reusable._id });
      return otherFile ? { blocker: otherFile } : { app: reusable };
    }

    return {
      blocker: {
        type: "OPEN",
        app: reusable,
        message: `This customer already has a loan file (${reusable.appNo}) with another partner. One customer can have only one loan file.`,
        unlockAt: null,
      },
    };
  }

  const blocker = await findCustomerApplyBlocker(customerId);
  return blocker ? { blocker } : {};
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
export async function findCustomerApplyBlocker(customerId, { excludeAppId } = {}) {
  const exclude = excludeAppId ? { _id: { $ne: excludeAppId } } : {};
  const openApp = await Application.findOne(
    openLoanApplicationFilter(customerId, exclude)
  ).sort({ updatedAt: -1 });

  if (openApp) {
    return {
      type: "OPEN",
      app: openApp,
      message: `This customer already has a loan file (${openApp.appNo}, ${openApp.status}). One customer can have only one loan file.`,
      unlockAt: null,
    };
  }

  const rejectedApps = await Application.find({
    customerId,
    status: "REJECTED",
    isArchived: { $ne: true },
    ...exclude,
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
