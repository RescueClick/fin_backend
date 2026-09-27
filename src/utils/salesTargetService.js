/**
 * Hierarchical monthly sales targets: Admin → RSM → ASM (per loan line) → RM (per loan line).
 * Partners never carry targets; their disbursals count toward the RM saved on the application.
 */
import mongoose from "mongoose";
import { SalesTarget } from "../models/SalesTarget.js";
import { Application } from "../models/Application.js";
import { User } from "../models/User.js";
import { ROLES, ASM_TYPES } from "../config/roles.js";
import { activeUsersFilter } from "./activeUsersFilter.js";
import { activeApplicationsFilter } from "./activeApplicationsFilter.js";
import { getDisbursedAt, getRmIdsUnderRsm } from "./asmHierarchy.js";
import { normalizeAsmTypeValue, rmReportingLineMatch } from "./rmRsmHierarchy.js";

export class TargetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const USER_FIELDS =
  "firstName lastName email phone role employeeId rsmCode asmCode rmCode asmType rsmType rsmId asmId personalAsmId businessAsmId homeLapAsmId businessHomeAsmId";

const RM_LINE_FIELDS = [
  ["personalAsmId", ASM_TYPES.PERSONAL],
  ["businessAsmId", ASM_TYPES.BUSINESS],
  ["homeLapAsmId", ASM_TYPES.HOME_LAP],
  ["businessHomeAsmId", ASM_TYPES.BUSINESS_HOME],
];

export const isAdminRole = (role) => role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;

const toOid = (id) => new mongoose.Types.ObjectId(String(id));
const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

export function parsePeriod(src = {}) {
  const now = new Date();
  const month = src.month != null && src.month !== "" ? Number(src.month) : now.getMonth() + 1;
  const year = src.year != null && src.year !== "" ? Number(src.year) : now.getFullYear();
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new TargetError("Invalid month");
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new TargetError("Invalid year");
  return { month, year };
}

export function monthRange(month, year) {
  return { start: new Date(year, month - 1, 1), end: new Date(year, month, 1) };
}

function previousPeriod(month, year) {
  return month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
}

export async function isPeriodLocked(month, year) {
  return Boolean(await SalesTarget.exists({ month, year, lockedAt: { $ne: null } }));
}

// ---------------------------------------------------------------------------
// Loan line helpers
// ---------------------------------------------------------------------------

export function lineOfLoanType(loanType) {
  const lt = String(loanType || "").trim().toUpperCase();
  if (lt === "PERSONAL") return ASM_TYPES.PERSONAL;
  if (lt === "BUSINESS") return ASM_TYPES.BUSINESS;
  if (lt.startsWith("HOME") || lt.startsWith("LAP")) return ASM_TYPES.HOME_LAP;
  return null;
}

function lineCovers(targetLine, appLine) {
  if (!targetLine || targetLine === "ALL") return true;
  if (targetLine === ASM_TYPES.BUSINESS_HOME) {
    return appLine === ASM_TYPES.BUSINESS || appLine === ASM_TYPES.HOME_LAP;
  }
  return targetLine === appLine;
}

export function asmLineOf(asm) {
  return normalizeAsmTypeValue(asm?.asmType || asm?.rsmType);
}

// ---------------------------------------------------------------------------
// Achievement (live from DISBURSED applications)
// ---------------------------------------------------------------------------

/** Disbursals in [start, end). `updatedAt >= start` is a safe prefilter since disbursal bumps updatedAt. */
export async function loadDisbursals(start, end, rmIds = null) {
  const filter = { status: "DISBURSED", updatedAt: { $gte: start }, createdAt: { $lt: end } };
  if (rmIds) filter.rmId = { $in: [...rmIds].map(toOid) };

  const apps = await Application.find(activeApplicationsFilter(filter))
    .select("rmId partnerId loanType approvedLoanAmount stageHistory createdAt updatedAt")
    .lean();

  const out = [];
  for (const app of apps) {
    const at = getDisbursedAt(app);
    if (!at || at < start || at >= end) continue;
    out.push({
      rmId: app.rmId ? String(app.rmId) : null,
      partnerId: app.partnerId ? String(app.partnerId) : null,
      line: lineOfLoanType(app.loanType),
      amount: Number(app.approvedLoanAmount) || 0,
      at,
    });
  }
  return out;
}

function sumAchievement(disbursals, rmIdSet, line) {
  let disbursement = 0;
  let files = 0;
  for (const d of disbursals) {
    if (rmIdSet && !rmIdSet.has(d.rmId)) continue;
    if (!lineCovers(line, d.line)) continue;
    disbursement += d.amount;
    files += 1;
  }
  return { disbursement, files };
}

// ---------------------------------------------------------------------------
// Team helpers
// ---------------------------------------------------------------------------

async function loadUser(id, role) {
  if (!mongoose.isValidObjectId(id)) throw new TargetError("Invalid user id");
  const user = await User.findOne(activeUsersFilter({ _id: toOid(id) })).select(USER_FIELDS).lean();
  if (!user) throw new TargetError("User not found", 404);
  if (role && user.role !== role) throw new TargetError(`User is not an ${role}`);
  return user;
}

function listRsms() {
  return User.find(activeUsersFilter({ role: ROLES.RSM, status: "ACTIVE" }))
    .select(USER_FIELDS)
    .sort({ firstName: 1 })
    .lean();
}

function listAsmsUnderRsm(rsmId) {
  const oid = toOid(rsmId);
  return User.find(
    activeUsersFilter({ role: ROLES.ASM, status: "ACTIVE", $or: [{ rsmId: oid }, { asmId: oid }] })
  )
    .select(USER_FIELDS)
    .sort({ firstName: 1 })
    .lean();
}

function listRmsUnderAsm(asmId, line) {
  return User.find(
    activeUsersFilter({ role: ROLES.RM, status: "ACTIVE", ...rmReportingLineMatch(toOid(asmId), line) })
  )
    .select(USER_FIELDS)
    .sort({ firstName: 1 })
    .lean();
}

function person(u) {
  if (!u) return null;
  return {
    _id: String(u._id),
    name: `${u.firstName || ""} ${u.lastName || ""}`.trim(),
    role: u.role,
    code: u.rsmCode || u.asmCode || u.rmCode || u.employeeId || null,
    email: u.email || null,
    phone: u.phone || null,
    loanLine: u.role === ROLES.ASM ? asmLineOf(u) : undefined,
  };
}

/** RM ids (as strings) whose disbursals count toward a given target holder. */
async function scopeRmIds(level, user, line) {
  if (level === ROLES.RSM) return new Set((await getRmIdsUnderRsm(user._id)).map(String));
  if (level === ROLES.ASM) return new Set((await listRmsUnderAsm(user._id, line)).map((r) => String(r._id)));
  if (level === ROLES.RM) return new Set([String(user._id)]);
  return null;
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

function targetView(t) {
  if (!t) return null;
  return {
    _id: String(t._id),
    level: t.level,
    loanLine: t.loanLine,
    disbursementTarget: t.disbursementTarget,
    fileCountTarget: t.fileCountTarget,
    status: t.status,
    publishedAt: t.publishedAt,
    lockedAt: t.lockedAt,
    assignedBy: t.assignedBy ? String(t.assignedBy) : null,
    updatedAt: t.updatedAt,
  };
}

function progress(target, live) {
  const achieved =
    target?.lockedAt && target.finalAchievedDisbursement != null
      ? { disbursement: target.finalAchievedDisbursement, files: target.finalAchievedFileCount ?? 0 }
      : live;
  const pct = (a, t) => (t > 0 ? round1((a / t) * 100) : null);
  return {
    achieved,
    percent: {
      disbursement: pct(achieved.disbursement, target?.disbursementTarget || 0),
      files: pct(achieved.files, target?.fileCountTarget || 0),
    },
  };
}

function row(user, target, live, loanLine) {
  return { user: person(user), loanLine, target: targetView(target), ...progress(target, live) };
}

function allocationSummary(ownTarget, childRows) {
  const allocated = childRows.reduce(
    (acc, r) => ({
      disbursement: acc.disbursement + (r.target?.disbursementTarget || 0),
      files: acc.files + (r.target?.fileCountTarget || 0),
    }),
    { disbursement: 0, files: 0 }
  );
  const unallocated = ownTarget
    ? {
        disbursement: ownTarget.disbursementTarget - allocated.disbursement,
        files: ownTarget.fileCountTarget - allocated.files,
      }
    : null;
  return { allocated, unallocated };
}

const visibleToHolder = (t, viewerIsAdmin) => (t && (viewerIsAdmin || t.status === "PUBLISHED") ? t : null);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export async function getAdminView({ month, year }) {
  const { start, end } = monthRange(month, year);
  const [disbursals, rsms, targets, locked] = await Promise.all([
    loadDisbursals(start, end),
    listRsms(),
    SalesTarget.find({ level: ROLES.RSM, month, year }).lean(),
    isPeriodLocked(month, year),
  ]);
  const byUser = new Map(targets.map((t) => [String(t.assignedTo), t]));

  const rows = await Promise.all(
    rsms.map(async (rsm) => {
      const rmIds = await scopeRmIds(ROLES.RSM, rsm);
      return row(rsm, byUser.get(String(rsm._id)), sumAchievement(disbursals, rmIds, "ALL"), "ALL");
    })
  );

  const companyTarget = rows.reduce(
    (acc, r) => ({
      disbursementTarget: acc.disbursementTarget + (r.target?.disbursementTarget || 0),
      fileCountTarget: acc.fileCountTarget + (r.target?.fileCountTarget || 0),
    }),
    { disbursementTarget: 0, fileCountTarget: 0 }
  );

  return {
    level: "ADMIN",
    period: { month, year },
    locked,
    own: { user: null, loanLine: "ALL", target: companyTarget, ...progress(companyTarget, sumAchievement(disbursals, null, "ALL")) },
    childLevel: ROLES.RSM,
    children: rows,
  };
}

export async function getRsmView({ rsmId, month, year, viewerIsAdmin = false }) {
  const rsm = await loadUser(rsmId, ROLES.RSM);
  const { start, end } = monthRange(month, year);
  const [disbursals, asms, ownTargetRaw, locked] = await Promise.all([
    loadDisbursals(start, end),
    listAsmsUnderRsm(rsm._id),
    SalesTarget.findOne({ assignedTo: rsm._id, month, year, loanLine: "ALL" }).lean(),
    isPeriodLocked(month, year),
  ]);
  const ownTarget = visibleToHolder(ownTargetRaw, viewerIsAdmin);

  const childTargets = await SalesTarget.find({
    level: ROLES.ASM,
    month,
    year,
    assignedTo: { $in: asms.map((a) => a._id) },
  }).lean();
  const byKey = new Map(childTargets.map((t) => [`${t.assignedTo}_${t.loanLine}`, t]));

  const children = await Promise.all(
    asms.map(async (asm) => {
      const line = asmLineOf(asm);
      const rmIds = await scopeRmIds(ROLES.ASM, asm, line);
      const t = line ? byKey.get(`${asm._id}_${line}`) : null;
      return { ...row(asm, t, sumAchievement(disbursals, rmIds, line || "ALL"), line), lineMissing: !line };
    })
  );

  const ownRmIds = await scopeRmIds(ROLES.RSM, rsm);
  return {
    level: ROLES.RSM,
    period: { month, year },
    locked,
    own: row(rsm, ownTarget, sumAchievement(disbursals, ownRmIds, "ALL"), "ALL"),
    ...allocationSummary(ownTarget, children),
    childLevel: ROLES.ASM,
    children,
  };
}

export async function getAsmView({ asmId, month, year, viewerIsAdmin = false }) {
  const asm = await loadUser(asmId, ROLES.ASM);
  const line = asmLineOf(asm);
  if (!line) throw new TargetError("This ASM has no loan type (asmType) set. Fix the ASM profile first.");

  const { start, end } = monthRange(month, year);
  const [disbursals, rms, ownTargetRaw, locked] = await Promise.all([
    loadDisbursals(start, end),
    listRmsUnderAsm(asm._id, line),
    SalesTarget.findOne({ assignedTo: asm._id, month, year, loanLine: line }).lean(),
    isPeriodLocked(month, year),
  ]);
  const ownTarget = visibleToHolder(ownTargetRaw, viewerIsAdmin);

  const childTargets = await SalesTarget.find({
    level: ROLES.RM,
    month,
    year,
    loanLine: line,
    assignedTo: { $in: rms.map((r) => r._id) },
  }).lean();
  const byUser = new Map(childTargets.map((t) => [String(t.assignedTo), t]));

  const children = rms.map((rm) =>
    row(rm, byUser.get(String(rm._id)), sumAchievement(disbursals, new Set([String(rm._id)]), line), line)
  );

  return {
    level: ROLES.ASM,
    period: { month, year },
    locked,
    own: row(asm, ownTarget, sumAchievement(disbursals, new Set(rms.map((r) => String(r._id))), line), line),
    ...allocationSummary(ownTarget, children),
    childLevel: ROLES.RM,
    children,
  };
}

export async function getRmView({ rmId, month, year, viewerIsAdmin = false }) {
  const rm = await loadUser(rmId, ROLES.RM);
  const { start, end } = monthRange(month, year);
  const [disbursals, targets, locked] = await Promise.all([
    loadDisbursals(start, end, [rm._id]),
    SalesTarget.find({ level: ROLES.RM, assignedTo: rm._id, month, year }).lean(),
    isPeriodLocked(month, year),
  ]);

  const asmIds = RM_LINE_FIELDS.map(([f]) => rm[f]).filter(Boolean);
  const asms = await User.find({ _id: { $in: asmIds } }).select(USER_FIELDS).lean();
  const asmById = new Map(asms.map((a) => [String(a._id), a]));

  const lines = [];
  const hasSplitLines = Boolean(rm.businessAsmId || rm.homeLapAsmId);
  for (const [field, line] of RM_LINE_FIELDS) {
    if (!rm[field]) continue;
    if (line === ASM_TYPES.BUSINESS_HOME && hasSplitLines) continue;
    const t = visibleToHolder(targets.find((x) => x.loanLine === line), viewerIsAdmin);
    lines.push({
      ...row(rm, t, sumAchievement(disbursals, null, line), line),
      asm: person(asmById.get(String(rm[field]))),
    });
  }
  // Targets from a line the RM has since been moved off still show, so history isn't lost.
  for (const t of targets) {
    if (lines.some((l) => l.loanLine === t.loanLine)) continue;
    if (!visibleToHolder(t, viewerIsAdmin)) continue;
    lines.push({ ...row(rm, t, sumAchievement(disbursals, null, t.loanLine), t.loanLine), asm: null });
  }

  const total = lines.reduce(
    (acc, l) => ({
      disbursementTarget: acc.disbursementTarget + (l.target?.disbursementTarget || 0),
      fileCountTarget: acc.fileCountTarget + (l.target?.fileCountTarget || 0),
    }),
    { disbursementTarget: 0, fileCountTarget: 0 }
  );

  const byPartner = new Map();
  for (const d of disbursals) {
    const key = d.partnerId || "direct";
    const cur = byPartner.get(key) || { disbursement: 0, files: 0 };
    cur.disbursement += d.amount;
    cur.files += 1;
    byPartner.set(key, cur);
  }
  const partnerDocs = await User.find({
    _id: { $in: [...byPartner.keys()].filter((k) => k !== "direct").map(toOid) },
  })
    .select("firstName lastName partnerCode businessName")
    .lean();
  const partnerById = new Map(partnerDocs.map((p) => [String(p._id), p]));
  const partners = [...byPartner.entries()]
    .map(([id, v]) => {
      const p = partnerById.get(id);
      return {
        partnerId: id === "direct" ? null : id,
        name: p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "Direct / no partner",
        code: p?.partnerCode || null,
        ...v,
      };
    })
    .sort((a, b) => b.disbursement - a.disbursement);

  return {
    level: ROLES.RM,
    period: { month, year },
    locked,
    own: { user: person(rm), loanLine: "ALL", target: total, ...progress(total, sumAchievement(disbursals, null, "ALL")) },
    lines,
    partners,
  };
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

/** Can `actor` ({sub, role}) view the target page of `subjectId` at `subjectRole`? */
export async function canView(actor, subjectId, subjectRole) {
  if (isAdminRole(actor.role)) return true;
  const self = String(actor.sub);
  if (self === String(subjectId)) return actor.role === subjectRole;

  if (actor.role === ROLES.RSM) {
    if (subjectRole === ROLES.ASM) {
      return Boolean(
        await User.exists({ _id: toOid(subjectId), role: ROLES.ASM, $or: [{ rsmId: toOid(self) }, { asmId: toOid(self) }] })
      );
    }
    if (subjectRole === ROLES.RM) {
      return (await getRmIdsUnderRsm(self)).map(String).includes(String(subjectId));
    }
  }
  if (actor.role === ROLES.ASM && subjectRole === ROLES.RM) {
    const asm = await User.findById(self).select("asmType rsmType").lean();
    return Boolean(
      await User.exists({ _id: toOid(subjectId), role: ROLES.RM, ...rmReportingLineMatch(toOid(self), asmLineOf(asm)) })
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Resolve who is splitting and to whom.
 * managerId null → Admin sets RSM targets. RSM → ASM targets. ASM → RM targets.
 */
async function resolveAllocationContext({ managerId, month, year }) {
  if (!managerId) {
    const rsms = await listRsms();
    return {
      childLevel: ROLES.RSM,
      parent: null,
      childLine: () => "ALL",
      children: rsms,
    };
  }

  const manager = await loadUser(managerId);
  if (manager.role === ROLES.RSM) {
    const parent = await SalesTarget.findOne({ assignedTo: manager._id, month, year, loanLine: "ALL" }).lean();
    const asms = await listAsmsUnderRsm(manager._id);
    return { manager, childLevel: ROLES.ASM, parent, childLine: (asm) => asmLineOf(asm), children: asms };
  }
  if (manager.role === ROLES.ASM) {
    const line = asmLineOf(manager);
    if (!line) throw new TargetError("This ASM has no loan type (asmType) set. Fix the ASM profile first.");
    const parent = await SalesTarget.findOne({ assignedTo: manager._id, month, year, loanLine: line }).lean();
    const rms = await listRmsUnderAsm(manager._id, line);
    return { manager, childLevel: ROLES.RM, parent, childLine: () => line, children: rms };
  }
  throw new TargetError("Only Admin, RSM and ASM can assign targets", 403);
}

function cleanNumber(v, label, { integer = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new TargetError(`${label} must be a number ≥ 0`);
  if (integer && !Number.isInteger(n)) throw new TargetError(`${label} must be a whole number`);
  return n;
}

/**
 * Upsert child targets for a manager's team.
 * rows: [{ userId, disbursementTarget, fileCountTarget }]
 * publish: also publishes every existing child target under this parent.
 */
export async function saveAllocations({ actor, managerId = null, month, year, rows = [], publish = false }) {
  if (await isPeriodLocked(month, year)) throw new TargetError("This month is locked. Targets can no longer be changed.", 409);
  if (!Array.isArray(rows)) throw new TargetError("rows must be an array");

  const ctx = await resolveAllocationContext({ managerId, month, year });
  if (ctx.manager && !isAdminRole(actor.role) && ctx.parent?.status !== "PUBLISHED") {
    throw new TargetError("You don't have a published target for this month yet, so there is nothing to split.");
  }
  if (ctx.manager && !ctx.parent) {
    throw new TargetError("Set this manager's own target first, then split it to the team.");
  }

  const childById = new Map(ctx.children.map((c) => [String(c._id), c]));
  const incoming = new Map();
  for (const r of rows) {
    const id = String(r.userId || "");
    const child = childById.get(id);
    if (!child) throw new TargetError(`User ${id} is not in this team`);
    const line = ctx.childLine(child);
    if (!line) throw new TargetError(`${person(child).name} has no loan type set, so a line target can't be assigned.`);
    incoming.set(id, {
      line,
      disbursementTarget: cleanNumber(r.disbursementTarget, "Disbursement target"),
      fileCountTarget: cleanNumber(r.fileCountTarget, "File count target", { integer: true }),
    });
  }

  const existing = await SalesTarget.find({
    level: ctx.childLevel,
    month,
    year,
    assignedTo: { $in: ctx.children.map((c) => c._id) },
  }).lean();
  const existingByKey = new Map(existing.map((t) => [`${t.assignedTo}_${t.loanLine}`, t]));

  if (ctx.parent) {
    let sumAmt = 0;
    let sumFiles = 0;
    for (const child of ctx.children) {
      const id = String(child._id);
      const line = ctx.childLine(child);
      const next = incoming.get(id) || existingByKey.get(`${id}_${line}`);
      if (!next) continue;
      sumAmt += next.disbursementTarget || 0;
      sumFiles += next.fileCountTarget || 0;
    }
    if (sumAmt > ctx.parent.disbursementTarget) {
      throw new TargetError(
        `Total disbursement allocated (₹${sumAmt.toLocaleString("en-IN")}) is more than the target available (₹${ctx.parent.disbursementTarget.toLocaleString("en-IN")}).`
      );
    }
    if (sumFiles > ctx.parent.fileCountTarget) {
      throw new TargetError(
        `Total files allocated (${sumFiles}) is more than the file target available (${ctx.parent.fileCountTarget}).`
      );
    }
  }

  // A holder's target can't drop below what they've already split to their own team.
  for (const [id, next] of incoming) {
    const cur = existingByKey.get(`${id}_${next.line}`);
    if (!cur) continue;
    const [agg] = await SalesTarget.aggregate([
      { $match: { parentTargetId: cur._id } },
      { $group: { _id: null, amt: { $sum: "$disbursementTarget" }, files: { $sum: "$fileCountTarget" } } },
    ]);
    if (agg && (next.disbursementTarget < agg.amt || next.fileCountTarget < agg.files)) {
      throw new TargetError(
        `${person(childById.get(id)).name} has already split ₹${agg.amt.toLocaleString("en-IN")} / ${agg.files} files to their team. Reduce their team's targets first.`
      );
    }
  }

  const now = new Date();
  const touched = [];
  for (const [id, next] of incoming) {
    const set = {
      level: ctx.childLevel,
      assignedBy: toOid(actor.sub),
      parentTargetId: ctx.parent?._id || null,
      disbursementTarget: next.disbursementTarget,
      fileCountTarget: next.fileCountTarget,
    };
    const update = publish
      ? { $set: { ...set, status: "PUBLISHED", publishedAt: now } }
      : { $set: set, $setOnInsert: { status: "DRAFT" } };
    const doc = await SalesTarget.findOneAndUpdate(
      { assignedTo: toOid(id), month, year, loanLine: next.line },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    touched.push(doc);
  }

  if (publish) {
    const untouchedDrafts = existing.filter((t) => t.status === "DRAFT" && !incoming.has(String(t.assignedTo)));
    if (untouchedDrafts.length) {
      await SalesTarget.updateMany(
        { _id: { $in: untouchedDrafts.map((t) => t._id) } },
        { $set: { status: "PUBLISHED", publishedAt: now } }
      );
      touched.push(...untouchedDrafts.map((t) => ({ ...t, status: "PUBLISHED" })));
    }
  }

  emitTargetUpdates(touched.filter((t) => t.status === "PUBLISHED"));
  return { saved: touched.length };
}

export async function copyFromPreviousMonth({ actor, managerId = null, month, year }) {
  const prev = previousPeriod(month, year);
  const ctx = await resolveAllocationContext({ managerId, month, year });
  const prevTargets = await SalesTarget.find({
    level: ctx.childLevel,
    month: prev.month,
    year: prev.year,
    assignedTo: { $in: ctx.children.map((c) => c._id) },
  }).lean();
  const current = await SalesTarget.find({
    level: ctx.childLevel,
    month,
    year,
    assignedTo: { $in: ctx.children.map((c) => c._id) },
  })
    .select("assignedTo")
    .lean();
  const alreadySet = new Set(current.map((t) => String(t.assignedTo)));

  const rows = prevTargets
    .filter((t) => !alreadySet.has(String(t.assignedTo)))
    .map((t) => ({
      userId: String(t.assignedTo),
      disbursementTarget: t.disbursementTarget,
      fileCountTarget: t.fileCountTarget,
    }));
  if (!rows.length) return { saved: 0 };
  return saveAllocations({ actor, managerId, month, year, rows, publish: false });
}

// ---------------------------------------------------------------------------
// Month-end lock
// ---------------------------------------------------------------------------

export async function lockMonth({ month, year }) {
  const targets = await SalesTarget.find({ month, year, lockedAt: null }).lean();
  if (!targets.length) return { locked: 0 };

  const { start, end } = monthRange(month, year);
  const disbursals = await loadDisbursals(start, end);
  const userIds = [...new Set(targets.map((t) => String(t.assignedTo)))];
  const users = await User.find({ _id: { $in: userIds.map(toOid) } }).select(USER_FIELDS).lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const now = new Date();
  const ops = [];
  for (const t of targets) {
    const user = userById.get(String(t.assignedTo)) || { _id: t.assignedTo };
    const rmIds = await scopeRmIds(t.level, user, t.loanLine);
    const a = sumAchievement(disbursals, rmIds, t.loanLine);
    ops.push({
      updateOne: {
        filter: { _id: t._id },
        update: { $set: { lockedAt: now, finalAchievedDisbursement: a.disbursement, finalAchievedFileCount: a.files } },
      },
    });
  }
  await SalesTarget.bulkWrite(ops);
  return { locked: ops.length };
}

// ---------------------------------------------------------------------------
// 12-month trend
// ---------------------------------------------------------------------------

export async function getTrend({ subjectId = null, subjectRole, year }) {
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);

  let targetFilter;
  let rmIds = null;
  let line = "ALL";
  if (!subjectId || isAdminRole(subjectRole)) {
    targetFilter = { level: ROLES.RSM, year };
  } else {
    const user = await loadUser(subjectId, subjectRole);
    if (subjectRole === ROLES.ASM) line = asmLineOf(user) || "ALL";
    targetFilter = { assignedTo: user._id, year, status: "PUBLISHED" };
    rmIds = await scopeRmIds(subjectRole, user, line);
  }

  const [targets, disbursals] = await Promise.all([
    SalesTarget.find(targetFilter).lean(),
    loadDisbursals(start, end, subjectRole === ROLES.RM ? rmIds : null),
  ]);

  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    disbursementTarget: 0,
    fileCountTarget: 0,
    achievedDisbursement: 0,
    achievedFileCount: 0,
  }));
  for (const t of targets) {
    months[t.month - 1].disbursementTarget += t.disbursementTarget || 0;
    months[t.month - 1].fileCountTarget += t.fileCountTarget || 0;
  }
  for (const d of disbursals) {
    if (rmIds && !rmIds.has(d.rmId)) continue;
    if (!lineCovers(line, d.line)) continue;
    const m = months[d.at.getMonth()];
    m.achievedDisbursement += d.amount;
    m.achievedFileCount += 1;
  }
  return { year, months };
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

function emitTargetUpdates(docs) {
  const io = global.io;
  if (!io || !docs?.length) return;
  for (const t of docs) {
    io.to(`user_${String(t.assignedTo)}`).emit("salesTargetUpdated", {
      targetId: String(t._id),
      level: t.level,
      loanLine: t.loanLine,
      month: t.month,
      year: t.year,
      disbursementTarget: t.disbursementTarget,
      fileCountTarget: t.fileCountTarget,
      timestamp: new Date(),
    });
  }
}
