const CIBIL_BANDS = new Set(["BELOW_600", "RANGE_600_700", "RANGE_700_750", "RANGE_750_850"]);
const SALARY_MODES = new Set(["ONLINE", "CASH"]);

function yesNo(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  return raw === "YES" || raw === "TRUE" ? "YES" : "NO";
}

export function personFinancialFrom(source = {}) {
  const mode = String(source.salaryReceiptMode || "").trim().toUpperCase();
  const band = String(source.cibilScoreBand || "").trim().toUpperCase();
  const salaryRaw = source.salaryInHand;
  const hasBounce = yesNo(source.hasBounce);
  const bounceRaw = Number(source.bounceCount);
  const bounceCount =
    hasBounce === "YES" && Number.isFinite(bounceRaw) && bounceRaw > 0
      ? Math.min(999, Math.floor(bounceRaw))
      : 0;
  return {
    salaryInHand:
      salaryRaw === undefined || salaryRaw === null ? "" : String(salaryRaw).trim(),
    salaryReceiptMode: SALARY_MODES.has(mode) ? mode : "",
    cibilScoreBand: CIBIL_BANDS.has(band) ? band : "",
    hasBounce,
    bounceCount,
  };
}
