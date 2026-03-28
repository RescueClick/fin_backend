/**
 * Strip non-digits; cap at 10 digits for entry, or take last 10 when longer (e.g. +91 prefix).
 */
export function normalizePhoneToTen(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}
