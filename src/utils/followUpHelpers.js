import dayjs from "dayjs";
import mongoose from "mongoose";
import { Application } from "../models/Application.js";
import { FollowUp } from "../models/followUp.js";

const CALL_STATUSES = ["Connected", "Ringing", "Switch Off", "Not Reachable"];

/**
 * Parse year / month / date / from-to query into a Date range (inclusive day bounds).
 * @returns {{ start: Date, end: Date, label: string } | null}
 */
export function parseFollowUpPeriod(query = {}) {
  const { year, month, date, from, to } = query;

  if (date) {
    const d = dayjs(String(date));
    if (d.isValid()) {
      return {
        start: d.startOf("day").toDate(),
        end: d.endOf("day").toDate(),
        label: d.format("DD MMM YYYY"),
      };
    }
  }

  if (from || to) {
    const start = from
      ? dayjs(String(from)).startOf("day")
      : dayjs("2000-01-01").startOf("day");
    const end = to
      ? dayjs(String(to)).endOf("day")
      : dayjs().endOf("day");
    if (start.isValid() && end.isValid()) {
      return {
        start: start.toDate(),
        end: end.toDate(),
        label: `${start.format("DD MMM YYYY")} – ${end.format("DD MMM YYYY")}`,
      };
    }
  }

  const y = year ? Number(year) : null;
  const m = month ? Number(month) : null;
  if (y && m >= 1 && m <= 12) {
    const start = dayjs(`${y}-${String(m).padStart(2, "0")}-01`).startOf("month");
    return {
      start: start.toDate(),
      end: start.endOf("month").toDate(),
      label: start.format("MMM YYYY"),
    };
  }
  if (y) {
    const start = dayjs(`${y}-01-01`).startOf("year");
    return {
      start: start.toDate(),
      end: start.endOf("year").toDate(),
      label: String(y),
    };
  }

  return null;
}

export function isValidFollowUpStatus(status) {
  return CALL_STATUSES.includes(status);
}

export { CALL_STATUSES };

/**
 * Latest follow-up per target (optionally only within period).
 */
export async function latestFollowUpsByTargets({
  targetIds,
  followUpType,
  period,
  partnerIdMode = false,
}) {
  if (!targetIds?.length) return new Map();

  const ids = targetIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
  );

  const match = partnerIdMode
    ? { partnerId: { $in: ids } }
    : { targetId: { $in: ids }, followUpType };

  if (period) {
    match.lastCall = { $gte: period.start, $lte: period.end };
  }

  const rows = await FollowUp.find(match)
    .sort({ lastCall: -1, updatedAt: -1 })
    .populate("updatedBy", "firstName lastName employeeId")
    .lean();

  const map = new Map();
  for (const fu of rows) {
    const key = String(
      partnerIdMode ? fu.partnerId : fu.targetId?._id || fu.targetId
    );
    if (!map.has(key)) map.set(key, fu);
  }
  return map;
}

/**
 * Count applications grouped by partnerId (optional createdAt period).
 */
export async function applicationCountsByPartner(partnerIds, period) {
  if (!partnerIds?.length) return new Map();
  const ids = partnerIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
  );
  const match = { partnerId: { $in: ids } };
  if (period) {
    match.createdAt = { $gte: period.start, $lte: period.end };
  }
  const rows = await Application.aggregate([
    { $match: match },
    { $group: { _id: "$partnerId", count: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), r.count);
  return map;
}

/**
 * Count applications grouped by rmId.
 */
export async function applicationCountsByRm(rmIds, period) {
  if (!rmIds?.length) return new Map();
  const ids = rmIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
  );
  const match = { rmId: { $in: ids } };
  if (period) {
    match.createdAt = { $gte: period.start, $lte: period.end };
  }
  const rows = await Application.aggregate([
    { $match: match },
    { $group: { _id: "$rmId", count: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), r.count);
  return map;
}

/**
 * Per RM: how many partners have ≥1 application in period.
 */
export async function partnerFillStatsByRm(rmIds, period) {
  if (!rmIds?.length) return new Map();
  const ids = rmIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
  );

  const { User } = await import("../models/User.js");
  const { ROLES } = await import("../config/roles.js");
  const partners = await User.find({
    role: ROLES.PARTNER,
    rmId: { $in: ids },
    status: { $ne: "PENDING" },
  })
    .select("_id rmId")
    .lean();

  const partnersByRm = new Map();
  for (const p of partners) {
    const rk = String(p.rmId);
    if (!partnersByRm.has(rk)) partnersByRm.set(rk, []);
    partnersByRm.get(rk).push(p._id);
  }

  const allPartnerIds = partners.map((p) => p._id);
  const appCounts = await applicationCountsByPartner(allPartnerIds, period);

  const result = new Map();
  for (const rmId of ids) {
    const rk = String(rmId);
    const list = partnersByRm.get(rk) || [];
    let filled = 0;
    for (const pid of list) {
      if ((appCounts.get(String(pid)) || 0) > 0) filled += 1;
    }
    result.set(rk, {
      partnerCount: list.length,
      partnersFilled: filled,
      partnersNotFilled: Math.max(list.length - filled, 0),
    });
  }
  return result;
}

export function formatFollowUpLastCall(value) {
  if (!value) return null;
  return dayjs(value).format("DD MMM YYYY, hh:mm a");
}

export function buildPartnerFollowUpSummary(rows) {
  const total = rows.length;
  const filled = rows.filter((r) => r.hasFilledForm).length;
  const notFilled = total - filled;
  const working = rows.filter((r) => r.performance === "working").length;
  const nonWorking = total - working;
  return { total, filled, notFilled, working, nonWorking };
}

export function buildRmFollowUpSummary(rows) {
  const total = rows.length;
  const working = rows.filter((r) => r.performance === "working").length;
  const nonWorking = total - working;
  const partnersFilled = rows.reduce((s, r) => s + (r.partnersFilled || 0), 0);
  const partnersNotFilled = rows.reduce(
    (s, r) => s + (r.partnersNotFilled || 0),
    0
  );
  const partnerCount = rows.reduce((s, r) => s + (r.partnerCount || 0), 0);
  return {
    total,
    working,
    nonWorking,
    partnerCount,
    partnersFilled,
    partnersNotFilled,
  };
}
