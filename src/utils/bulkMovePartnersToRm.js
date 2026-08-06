/**
 * Bulk-move partners from one RM to another without losing open workload.
 * Settled apps (DISBURSED/REJECTED) and DONE/PAID finance stay unchanged.
 */
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";
import { ROLES } from "../config/roles.js";
import {
  buildReassignableApplicationFilter,
  buildReassignmentAudit,
  LOCKED_APPLICATION_STATUSES,
} from "./reassignmentPolicy.js";
import { persistReassignmentAudit } from "./reassignmentAuditService.js";
import {
  findCustomersForPartner,
  syncCustomersRmForPartners,
} from "./partnerCustomerSync.js";
import {
  getRmIdsUnderAsm,
  resolveAsmIdForRm,
} from "./asmHierarchy.js";

export { getRmIdsUnderAsm } from "./asmHierarchy.js";

export const BULK_MOVE_MAX_BATCH = 100;

function toObjectId(id, label = "id") {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    const err = new Error(`Invalid ${label}`);
    err.status = 400;
    throw err;
  }
  return new mongoose.Types.ObjectId(String(id));
}

/**
 * @param {object} opts
 * @param {string[]} opts.partnerIds
 * @param {string} opts.fromRmId
 * @param {string} opts.toRmId
 * @param {string} opts.actorId
 * @param {string} opts.actorRole - SUPER_ADMIN | ASM
 * @param {boolean} [opts.dryRun]
 * @param {import('express').Request} [opts.req]
 */
export async function bulkMovePartnersToRm({
  partnerIds,
  fromRmId,
  toRmId,
  actorId,
  actorRole,
  dryRun = false,
  req = null,
}) {
  if (!Array.isArray(partnerIds) || partnerIds.length === 0) {
    const err = new Error("Select at least one partner");
    err.status = 400;
    throw err;
  }
  if (partnerIds.length > BULK_MOVE_MAX_BATCH) {
    const err = new Error(
      `You can move at most ${BULK_MOVE_MAX_BATCH} partners at a time`
    );
    err.status = 400;
    throw err;
  }
  if (String(fromRmId) === String(toRmId)) {
    const err = new Error("From RM and To RM must be different");
    err.status = 400;
    throw err;
  }

  const fromId = toObjectId(fromRmId, "fromRmId");
  const toId = toObjectId(toRmId, "toRmId");
  const pIds = partnerIds.map((id) => toObjectId(id, "partnerId"));

  const [fromRm, toRm] = await Promise.all([
    User.findOne({ _id: fromId, role: ROLES.RM }).lean(),
    User.findOne({ _id: toId, role: ROLES.RM, status: "ACTIVE" }).lean(),
  ]);

  if (!fromRm) {
    const err = new Error("From RM not found");
    err.status = 404;
    throw err;
  }
  if (!toRm) {
    const err = new Error("To RM not found or inactive");
    err.status = 404;
    throw err;
  }

  if (actorRole === ROLES.ASM) {
    const allowed = await getRmIdsUnderAsm(actorId);
    const allowedSet = new Set(allowed.map(String));
    if (!allowedSet.has(String(fromId)) || !allowedSet.has(String(toId))) {
      const err = new Error(
        "Both RMs must be under your ASM hierarchy"
      );
      err.status = 403;
      throw err;
    }
  }

  const partners = await User.find({
    _id: { $in: pIds },
    role: ROLES.PARTNER,
    rmId: fromId,
    status: { $ne: "PENDING" },
  })
    .select("_id firstName lastName employeeId status rmId region")
    .lean();

  if (partners.length !== pIds.length) {
    const found = new Set(partners.map((p) => String(p._id)));
    const missing = partnerIds.filter((id) => !found.has(String(id)));
    const err = new Error(
      `Some partners are invalid, PENDING, or not under the From RM: ${missing
        .slice(0, 5)
        .join(", ")}`
    );
    err.status = 400;
    throw err;
  }

  const movablePartnerIds = partners.map((p) => p._id);

  const openAppsFilter = buildReassignableApplicationFilter({
    partnerId: { $in: movablePartnerIds },
  });
  const lockedAppsFilter = {
    partnerId: { $in: movablePartnerIds },
    status: { $in: LOCKED_APPLICATION_STATUSES },
  };

  const [openAppCount, lockedAppCount] = await Promise.all([
    Application.countDocuments(openAppsFilter),
    Application.countDocuments(lockedAppsFilter),
  ]);

  let customerCount = 0;
  for (const pid of movablePartnerIds) {
    const custs = await findCustomersForPartner(pid);
    customerCount += custs.length;
  }

  const preview = {
    movedPartners: partners.length,
    movedApplications: openAppCount,
    skippedLockedApplications: lockedAppCount,
    syncedCustomers: customerCount,
    partners: partners.map((p) => ({
      id: p._id,
      name: `${p.firstName || ""} ${p.lastName || ""}`.trim(),
      employeeId: p.employeeId,
      region: p.region || null,
      status: p.status,
    })),
    fromRm: {
      id: fromRm._id,
      name: `${fromRm.firstName || ""} ${fromRm.lastName || ""}`.trim(),
      employeeId: fromRm.employeeId,
    },
    toRm: {
      id: toRm._id,
      name: `${toRm.firstName || ""} ${toRm.lastName || ""}`.trim(),
      employeeId: toRm.employeeId,
    },
  };

  if (dryRun) {
    return { dryRun: true, ...preview, audit: null };
  }

  // Prefer direct asmId; else resolve via RSM so ASM partner lists stay correct
  const newAsmId = await resolveAsmIdForRm(toRm);
  const session = await mongoose.startSession();
  let movedPartners = 0;
  let movedApplications = 0;
  let syncedCustomers = 0;
  let audit = null;

  try {
    await session.withTransaction(async () => {
      // Backfill RM.asmId when missing so populate/match paths also work
      if (newAsmId && !toRm.asmId) {
        await User.updateOne(
          { _id: toId, role: ROLES.RM },
          { $set: { asmId: newAsmId, updatedAt: new Date() } },
          { session }
        );
      }

      const partnerUpdate = await User.updateMany(
        {
          _id: { $in: movablePartnerIds },
          role: ROLES.PARTNER,
          rmId: fromId,
        },
        { $set: { rmId: toId, updatedAt: new Date() } },
        { session }
      );
      movedPartners = partnerUpdate.modifiedCount || 0;

      // Keep customers on the same partner; only refresh RM linkage so counts stay in sync
      syncedCustomers = await syncCustomersRmForPartners({
        partnerIds: movablePartnerIds,
        toRmId: toId,
        session,
      });

      const appSet = {
        rmId: toId,
        "customer.rmId": toId,
      };
      if (newAsmId) {
        appSet.asmId = newAsmId;
        appSet["customer.asmId"] = newAsmId;
      }

      const appUpdate = await Application.updateMany(
        openAppsFilter,
        { $set: appSet },
        { session }
      );
      movedApplications = appUpdate.modifiedCount || 0;

      // Backfill apps that have this partner but missing rmId (common on old DISBURSED files)
      // so Customer / payout screens can still show RM + ASM from the partner's current RM.
      await Application.updateMany(
        {
          partnerId: { $in: movablePartnerIds },
          $or: [{ rmId: null }, { rmId: { $exists: false } }],
        },
        { $set: appSet },
        { session }
      );

      audit = buildReassignmentAudit({
        changedBy: actorId,
        oldUserId: fromId,
        newUserId: toId,
        action: "bulk_move_partners_rm",
      });
      await persistReassignmentAudit(audit, req, session);
    });
  } finally {
    session.endSession();
  }

  return {
    dryRun: false,
    movedPartners,
    movedApplications,
    skippedLockedApplications: lockedAppCount,
    syncedCustomers,
    partners: preview.partners,
    fromRm: preview.fromRm,
    toRm: preview.toRm,
    audit,
    message: `Moved ${movedPartners} partner(s), synced ${syncedCustomers} customer(s), and ${movedApplications} open application(s) to the new RM. ${lockedAppCount} settled application(s) kept historical RM. Customers stay with the same partner.`,
  };
}
