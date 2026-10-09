const CIBIL_BANDS = new Set(["BELOW_600", "RANGE_600_700", "RANGE_700_750", "RANGE_750_850"]);
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
