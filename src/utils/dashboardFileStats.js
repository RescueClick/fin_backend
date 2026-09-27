import { Application } from "../models/Application.js";
import { getDisbursedAt, isDateInRange } from "./asmHierarchy.js";

/** Same buckets as the Admin dashboard pipeline. */
const IN_PROCESS_STATUSES = [
  "SUBMITTED",
  "DOC_INCOMPLETE",
  "DOC_COMPLETE",
  "LOGIN",
  "DOC_SUBMITTED",
  "KYC_PENDING",
  "KYC_COMPLETE",
  "UNDER_REVIEW",
];
const APPROVED_STATUSES = ["APPROVED", "AGREEMENT"];

function emptyBucket() {
  return {
    files: 0,
    customers: 0,
    inProcess: 0,
    approved: 0,
    disbursed: 0,
    rejected: 0,
    leads: 0,
    disbursedAmount: 0,
    activePartners: 0,
  };
}

function countByDate(items, period) {
  if (!period.startDate || !period.endDate) return items.length;
  return items.filter((x) => isDateInRange(x.createdAt, period.startDate, period.endDate)).length;
}

/**
 * Admin-style counting for a role dashboard scope.
 * Period counts use file creation date (disbursed uses disbursal date), like Admin.
 *
 * @param {object} appScope   Mongo filter for the caller's applications
 * @param {object} period     result of parseDashboardPeriod
 * @param {object} [opts]
 * @param {Array}  [opts.partners]     partner user docs in scope (need createdAt, status)
 * @param {Array}  [opts.subordinates] subordinate user docs in scope (need createdAt)
 * @param {object} [opts.disbursedScope] wider filter for disbursed revenue, if different
 */
export async function computeDashboardFileStats(appScope, period, opts = {}) {
  const { partners = [], subordinates = [], disbursedScope = null } = opts;
  const dated = Boolean(period.startDate && period.endDate);
  const inPeriod = (d) => !dated || isDateInRange(d, period.startDate, period.endDate);

  const apps = await Application.find(appScope)
    .select("status customerId partnerId createdAt approvedLoanAmount disbursedAt disbursedDate stageHistory updatedAt")
    .lean();

  const allTime = emptyBucket();
  const current = emptyBucket();
  const allCustomers = new Set();
  const periodCustomers = new Set();
  const periodPartners = new Set();

  for (const app of apps) {
    const st = String(app.status || "").toUpperCase();
    const created = inPeriod(app.createdAt);
    const buckets = created ? [allTime, current] : [allTime];

    for (const b of buckets) {
      b.files += 1;
      if (st === "LEAD") b.leads += 1;
      else if (st === "REJECTED") b.rejected += 1;
      else if (APPROVED_STATUSES.includes(st)) b.approved += 1;
      else if (IN_PROCESS_STATUSES.includes(st)) b.inProcess += 1;
    }
    if (app.customerId) {
      allCustomers.add(String(app.customerId));
      if (created) periodCustomers.add(String(app.customerId));
    }
    if (created && app.partnerId) periodPartners.add(String(app.partnerId));
  }

  const disbursedApps = disbursedScope
    ? await Application.find(disbursedScope)
        .select("status partnerId approvedLoanAmount disbursedAt disbursedDate stageHistory createdAt updatedAt")
        .lean()
    : apps.filter((a) => String(a.status).toUpperCase() === "DISBURSED");

  for (const app of disbursedApps) {
    if (String(app.status).toUpperCase() !== "DISBURSED") continue;
    const amt = Number(app.approvedLoanAmount || 0);
    allTime.disbursed += 1;
    allTime.disbursedAmount += amt;
    if (inPeriod(getDisbursedAt(app))) {
      current.disbursed += 1;
      current.disbursedAmount += amt;
      if (app.partnerId) periodPartners.add(String(app.partnerId));
    }
  }

  allTime.customers = allCustomers.size;
  current.customers = periodCustomers.size;
  allTime.activePartners = partners.filter((p) => p.status === "ACTIVE").length;
  current.activePartners = dated ? periodPartners.size : allTime.activePartners;

  return {
    isFiltered: dated,
    period: current,
    allTime,
    partners: {
      total: partners.length,
      active: allTime.activePartners,
      newInPeriod: countByDate(partners, period),
      withActivityInPeriod: current.activePartners,
    },
    subordinates: {
      total: subordinates.length,
      newInPeriod: countByDate(subordinates, period),
    },
  };
}
