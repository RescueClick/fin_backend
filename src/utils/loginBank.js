import { BankMaster } from "../models/BankMaster.js";

/** Bank used when the file was logged in. Falls back to the latest successful send-to-bank. */
export function resolveLoginBank(app) {
  const savedName = String(app?.loginBankName || "").trim();
  if (savedName) {
    return {
      loginBankName: savedName,
      loginBankId: app.loginBankId || null,
    };
  }
  const sends = Array.isArray(app?.bankSends) ? app.bankSends : [];
  const last = [...sends]
    .reverse()
    .find((s) => s && String(s.bankName || "").trim() && s.status !== "FAILED");
  return {
    loginBankName: last ? String(last.bankName).trim() : "",
    loginBankId: last?.bankId || null,
  };
}

/**
 * Store the bank chosen for loan login.
 * Returns { error } when a required pick is missing or the bank id is unknown.
 */
export async function assignLoginBank(app, input = {}, { required = false } = {}) {
  const bankId = input.bankId;
  const typedName = String(input.bankName || "").trim();

  if (bankId) {
    const bank = await BankMaster.findById(bankId).select("bankName").lean();
    if (!bank) return { error: "Selected bank was not found" };
    app.loginBankId = bank._id;
    app.loginBankName = bank.bankName;
    return { ok: true };
  }

  if (typedName) {
    app.loginBankName = typedName;
    return { ok: true };
  }

  const resolved = resolveLoginBank(app);
  if (resolved.loginBankName) {
    app.loginBankName = resolved.loginBankName;
    if (resolved.loginBankId) app.loginBankId = resolved.loginBankId;
    return { ok: true };
  }

  if (required) {
    return { error: "Select the bank used for this loan login" };
  }
  return { ok: true };
}
