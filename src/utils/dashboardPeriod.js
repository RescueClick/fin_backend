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

  const narrowed = narrowRangeToDay(startDate, endDate, query.day);

  return {
    year: hasYear ? year : "all",
    month: hasMonth ? month : "all",
    day: narrowed.day,
    hasYear,
    hasMonth,
    hasDay: narrowed.day !== "all",
    isFiltered: hasYear || hasMonth || narrowed.day !== "all",
    startDate: narrowed.startDate,
    endDate: narrowed.endDate,
    currentYear,
    currentMonth,
  };
}

/** Narrow a month range to one calendar day. Year-long ranges stay unchanged. */
export function narrowRangeToDay(startDate, endDate, day) {
  const d = Number(day);
  if (!startDate || !endDate || !Number.isFinite(d) || d < 1 || d > 31) {
    return { startDate, endDate, day: "all" };
  }
  const span = endDate.getTime() - startDate.getTime();
  if (span > 32 * 24 * 60 * 60 * 1000) {
    return { startDate, endDate, day: "all" };
  }
  const y = startDate.getFullYear();
  const m = startDate.getMonth();
  const start = new Date(y, m, d, 0, 0, 0, 0);
  if (start.getMonth() !== m) return { startDate, endDate, day: "all" };
  return {
    startDate: start,
    endDate: new Date(y, m, d + 1, 0, 0, 0, 0),
    day: d,
  };
}

/** Inclusive start, exclusive end. Month-only uses the current year. A day narrows that month to one date. */
export function periodBounds(query = {}) {
  const period = parseDashboardPeriod(query);
  let startDate = period.startDate;
  let endDate = period.endDate;
  if ((!startDate || !endDate) && period.hasMonth && period.month >= 1 && period.month <= 12) {
    const y = period.currentYear;
    startDate = new Date(y, period.month - 1, 1);
    endDate = new Date(y, period.month, 1);
  }
  const narrowed = narrowRangeToDay(startDate, endDate, query.day);
  return {
    ...period,
    startDate: narrowed.startDate,
    endDate: narrowed.endDate,
    day: narrowed.day,
    hasDay: narrowed.day !== "all",
    isFiltered: Boolean(narrowed.startDate && narrowed.endDate),
  };
}
