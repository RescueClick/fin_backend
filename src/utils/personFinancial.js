const CIBIL_BANDS = new Set(["BELOW_650", "BELOW_750", "ABOVE_750", "NO_SCORE"]);
const SALARY_MODES = new Set(["ONLINE", "CASH"]);

export function personFinancialFrom(source = {}) {
  const mode = String(source.salaryReceiptMode || "").trim().toUpperCase();
  const band = String(source.cibilScoreBand || "").trim().toUpperCase();
  const salaryRaw = source.salaryInHand;
  return {
    salaryInHand:
      salaryRaw === undefined || salaryRaw === null ? "" : String(salaryRaw).trim(),
    salaryReceiptMode: SALARY_MODES.has(mode) ? mode : "",
    cibilScoreBand: CIBIL_BANDS.has(band) ? band : "",
  };
}
