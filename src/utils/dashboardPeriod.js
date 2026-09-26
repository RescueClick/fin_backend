/**
 * Shared year/month period parsing for Admin / ASM / RSM / RM dashboards.
 * Query: ?year=2026&month=9  or year=all / month=all
 */
export function parseDashboardPeriod(query = {}) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const yearRaw = query.year;
  const monthRaw = query.month;

  const hasYear =
    yearRaw != null &&
    String(yearRaw).trim() !== "" &&
    String(yearRaw).toLowerCase() !== "all";
  const hasMonth =
    monthRaw != null &&
    String(monthRaw).trim() !== "" &&
    String(monthRaw).toLowerCase() !== "all";

  const year = hasYear ? Number(yearRaw) : null;
  const month = hasMonth ? Number(monthRaw) : null;

  let startDate = null;
  let endDate = null;

  if (hasYear && hasMonth && year && month >= 1 && month <= 12) {
    startDate = new Date(year, month - 1, 1);
    endDate = new Date(year, month, 1);
  } else if (hasYear && year) {
    startDate = new Date(year, 0, 1);
    endDate = new Date(year + 1, 0, 1);
  }

  return {
    year: hasYear ? year : "all",
    month: hasMonth ? month : "all",
    hasYear,
    hasMonth,
    isFiltered: hasYear || hasMonth,
    startDate,
    endDate,
    currentYear,
    currentMonth,
  };
}
