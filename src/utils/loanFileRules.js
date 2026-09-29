import { resolveSpecializedAsmForLoanType } from "./rmRsmHierarchy.js";

/** Same range as the partner app loan forms. */
export const MIN_LOAN_AMOUNT = 100000;
export const MAX_LOAN_AMOUNT = 50000000;
export const LOAN_AMOUNT_RANGE_MESSAGE =
  "Loan amount must be between ₹1,00,000 and ₹5,00,00,000";

export const RM_HIERARCHY_FIELDS =
  "rsmId asmId personalAsmId businessAsmId homeLapAsmId businessHomeAsmId personalRsmId businessRsmId homeLapRsmId businessHomeRsmId";

/**
 * Returns an error message when a filled amount is outside the allowed range.
 * Empty or zero means the amount is not filled yet (early wizard steps).
 */
export function loanAmountError(amount, { required = false } = {}) {
  const n = Number(amount);
  const filled = Number.isFinite(n) && n > 0;
  if (!filled) {
    return required ? "Loan amount is required" : null;
  }
  if (n < MIN_LOAN_AMOUNT || n > MAX_LOAN_AMOUNT) {
    return LOAN_AMOUNT_RANGE_MESSAGE;
  }
  return null;
}

/**
 * Partner → that partner's RM → the ASM for this loan type → the RM's senior RSM.
 * personalRsmId is a legacy copy of the ASM, so the senior RSM is always rm.rsmId.
 */
export function hierarchyFromRm(rm, loanType) {
  if (!rm) return { rmId: null, asmId: null, rsmId: null };
  return {
    rmId: rm._id,
    asmId: resolveSpecializedAsmForLoanType(rm, loanType) || null,
    rsmId: rm.rsmId || null,
  };
}

export function stampLoanHierarchy(app, hierarchy, partnerId) {
  if (!app || !hierarchy) return;
  if (partnerId) app.partnerId = partnerId;
  app.rmId = hierarchy.rmId || app.rmId;
  app.asmId = hierarchy.asmId || null;
  app.rsmId = hierarchy.rsmId || null;
  if (app.customer) {
    if (partnerId) app.customer.partnerId = partnerId;
    app.customer.rmId = hierarchy.rmId || app.customer.rmId;
    app.customer.asmId = hierarchy.asmId || null;
  }
}
