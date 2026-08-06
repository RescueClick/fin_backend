/**
 * Safe hierarchy transfers — never drop customers/apps/payouts on move.
 * Settled finance (DISBURSED/REJECTED apps, DONE payouts, PAID incentives) stays historical.
 */
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";
import { Payout } from "../models/Payout.js";
import { Incentive } from "../models/Incentive.js";
import { ROLES } from "../config/roles.js";
import {
  buildReassignableApplicationFilter,
  REASSIGNABLE_PAYOUT_STATUS,
  REASSIGNABLE_INCENTIVE_STATUS,
  LOCKED_PAYOUT_STATUS,
  LOCKED_INCENTIVE_STATUS,
} from "./reassignmentPolicy.js";
import {
  findCustomersForPartner,
  syncCustomersRmForPartners,
} from "./partnerCustomerSync.js";
import { getRmIdsUnderAsm, resolveAsmIdForRm } from "./asmHierarchy.js";

function oid(id, label = "id") {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    const err = new Error(`Invalid ${label}`);
    err.status = 400;
    throw err;
  }
  return new mongoose.Types.ObjectId(String(id));
}

function sessionOpt(session) {
  return session ? { session } : undefined;
}

/** Application field set when moving open workload to a new RM (+ optional ASM). */
export function buildAppRmHierarchySet(toRmId, toAsmId = null) {
  const set = {
    rmId: toRmId,
    "customer.rmId": toRmId,
  };
  if (toAsmId) {
    set.asmId = toAsmId;
    set["customer.asmId"] = toAsmId;
  }
  return set;
}

/**
 * Move all partners + open apps + customers from old RM → new RM.
 * Also catches apps under those partners with null/wrong rmId (no fatality).
 */
export async function reassignRmWorkload({
  oldRmId,
  newRmId,
  session = null,
}) {
  const fromId = oid(oldRmId, "oldRmId");
  const toId = oid(newRmId, "newRmId");
  if (String(fromId) === String(toId)) {
    const err = new Error("From RM and To RM must be different");
    err.status = 400;
    throw err;
  }

  let toRmQuery = User.findOne({ _id: toId, role: ROLES.RM, status: "ACTIVE" });
  if (session) toRmQuery = toRmQuery.session(session);
  const toRm = await toRmQuery.lean();
  if (!toRm) {
    const err = new Error("New RM not found or inactive");
    err.status = 404;
    throw err;
  }

  const toAsmId = await resolveAsmIdForRm(toRm);
  if (toAsmId && !toRm.asmId) {
    await User.updateOne(
      { _id: toId, role: ROLES.RM },
      { $set: { asmId: toAsmId } },
      sessionOpt(session)
    );
  }

  let partnersQuery = User.find({
    role: ROLES.PARTNER,
    rmId: fromId,
  }).select("_id");
  if (session) partnersQuery = partnersQuery.session(session);
  const partners = await partnersQuery.lean();
  const partnerIds = partners.map((p) => p._id);

  const partnerUpdate = await User.updateMany(
    { role: ROLES.PARTNER, rmId: fromId },
    {
      $set: {
        rmId: toId,
        ...(toAsmId ? { asmId: toAsmId } : {}),
      },
    },
    sessionOpt(session)
  );

  const appSet = buildAppRmHierarchySet(toId, toAsmId);

  // Open apps by old rmId OR by partners under old RM (covers null rmId)
  const openFilter = buildReassignableApplicationFilter({
    $or: [
      { rmId: fromId },
      ...(partnerIds.length ? [{ partnerId: { $in: partnerIds } }] : []),
    ],
  });
  const appUpdate = await Application.updateMany(
    openFilter,
    { $set: appSet },
    sessionOpt(session)
  );

  // Backfill any apps for these partners still missing rmId (incl. settled)
  let backfill = { modifiedCount: 0 };
  if (partnerIds.length) {
    backfill = await Application.updateMany(
      {
        partnerId: { $in: partnerIds },
        $or: [{ rmId: null }, { rmId: { $exists: false } }],
      },
      { $set: appSet },
      sessionOpt(session)
    );
  }

  const syncedCustomers = partnerIds.length
    ? await syncCustomersRmForPartners({
        partnerIds,
        toRmId: toId,
        toAsmId,
        session,
      })
    : 0;

  return {
    movedPartners: partnerUpdate.modifiedCount || 0,
    movedApplications: appUpdate.modifiedCount || 0,
    backfilledMissingRm: backfill.modifiedCount || 0,
    syncedCustomers,
    partnerIds,
    toAsmId,
  };
}

/**
 * Move customers + open apps + pending finance from old partner → new partner.
 * Always syncs rmId/asmId from the NEW partner so hierarchy never orphans.
 */
export async function reassignPartnerWorkload({
  oldPartnerId,
  newPartnerId,
  session = null,
}) {
  const fromId = oid(oldPartnerId, "oldPartnerId");
  const toId = oid(newPartnerId, "newPartnerId");
  if (String(fromId) === String(toId)) {
    const err = new Error("From Partner and To Partner must be different");
    err.status = 400;
    throw err;
  }

  let newPartnerQuery = User.findOne({
    _id: toId,
    role: ROLES.PARTNER,
    status: "ACTIVE",
  });
  if (session) newPartnerQuery = newPartnerQuery.session(session);
  const newPartner = await newPartnerQuery.lean();
  if (!newPartner) {
    const err = new Error("New Partner not found or inactive");
    err.status = 404;
    throw err;
  }

  let toRm = null;
  if (newPartner.rmId) {
    let rmQuery = User.findOne({ _id: newPartner.rmId, role: ROLES.RM });
    if (session) rmQuery = rmQuery.session(session);
    toRm = await rmQuery.lean();
  }
  const toRmId = toRm?._id || newPartner.rmId || null;
  const toAsmId = toRm ? await resolveAsmIdForRm(toRm) : null;

  // All customers tied to old partner (User link OR app ownership)
  const customers = await findCustomersForPartner(fromId);
  const customerIds = customers.map((c) => c._id);

  const customerSet = {
    partnerId: toId,
    ...(toRmId ? { rmId: toRmId } : {}),
    ...(toAsmId ? { asmId: toAsmId } : {}),
  };

  let customerUpdate = { modifiedCount: 0 };
  if (customerIds.length) {
    customerUpdate = await User.updateMany(
      { _id: { $in: customerIds }, role: ROLES.CUSTOMER },
      { $set: customerSet },
      sessionOpt(session)
    );
  }
  // Also catch any still linked only by partnerId
  const linkedUpdate = await User.updateMany(
    { role: ROLES.CUSTOMER, partnerId: fromId },
    { $set: customerSet },
    sessionOpt(session)
  );

  const appSet = {
    partnerId: toId,
    "customer.partnerId": toId,
    ...(toRmId
      ? { rmId: toRmId, "customer.rmId": toRmId }
      : {}),
    ...(toAsmId
      ? { asmId: toAsmId, "customer.asmId": toAsmId }
      : {}),
  };

  const appUpdate = await Application.updateMany(
    buildReassignableApplicationFilter({ partnerId: fromId }),
    { $set: appSet },
    sessionOpt(session)
  );

  // Settled apps keep historical partner for finance, but if rmId was never set, backfill from new partner's RM for visibility
  let settledBackfill = { modifiedCount: 0 };
  if (toRmId) {
    settledBackfill = await Application.updateMany(
      {
        partnerId: fromId,
        status: { $in: ["DISBURSED", "REJECTED"] },
        $or: [{ rmId: null }, { rmId: { $exists: false } }],
      },
      {
        $set: buildAppRmHierarchySet(toRmId, toAsmId),
      },
      sessionOpt(session)
    );
  }

  const payoutUpdate = await Payout.updateMany(
    { partnerId: fromId, payOutStatus: REASSIGNABLE_PAYOUT_STATUS },
    { $set: { partnerId: toId } },
    sessionOpt(session)
  );

  const incentiveSet = {
    partnerId: toId,
    ...(toAsmId ? { asmId: toAsmId } : {}),
  };
  const incentiveUpdate = await Incentive.updateMany(
    { partnerId: fromId, status: REASSIGNABLE_INCENTIVE_STATUS },
    { $set: incentiveSet },
    sessionOpt(session)
  );

  let lockedPayoutQuery = Payout.countDocuments({
    partnerId: fromId,
    payOutStatus: LOCKED_PAYOUT_STATUS,
  });
  let lockedIncentiveQuery = Incentive.countDocuments({
    partnerId: fromId,
    status: LOCKED_INCENTIVE_STATUS,
  });
  if (session) {
    lockedPayoutQuery = lockedPayoutQuery.session(session);
    lockedIncentiveQuery = lockedIncentiveQuery.session(session);
  }
  const [lockedPayoutCount, lockedIncentiveCount] = await Promise.all([
    lockedPayoutQuery,
    lockedIncentiveQuery,
  ]);

  return {
    movedCustomers:
      (customerUpdate.modifiedCount || 0) + (linkedUpdate.modifiedCount || 0),
    movedApplications: appUpdate.modifiedCount || 0,
    settledRmBackfill: settledBackfill.modifiedCount || 0,
    movedPayouts: payoutUpdate.modifiedCount || 0,
    movedIncentives: incentiveUpdate.modifiedCount || 0,
    lockedPayouts: lockedPayoutCount,
    lockedIncentives: lockedIncentiveCount,
    toRmId,
    toAsmId,
  };
}

/**
 * Move full ASM tree (RSM→RM→Partner→Customer + open app asmId) to new ASM.
 * Uses getRmIdsUnderAsm so RSM-linked RMs are never skipped.
 */
export async function reassignAsmWorkload({
  oldAsmId,
  newAsmId,
  session = null,
}) {
  const fromId = oid(oldAsmId, "oldAsmId");
  const toId = oid(newAsmId, "newAsmId");
  if (String(fromId) === String(toId)) {
    const err = new Error("From ASM and To ASM must be different");
    err.status = 400;
    throw err;
  }

  let newAsmQuery = User.findOne({ _id: toId, role: ROLES.ASM, status: "ACTIVE" });
  if (session) newAsmQuery = newAsmQuery.session(session);
  const newAsm = await newAsmQuery.lean();
  if (!newAsm) {
    const err = new Error("New ASM not found or inactive");
    err.status = 404;
    throw err;
  }

  const rsmUpdate = await User.updateMany(
    { role: ROLES.RSM, asmId: fromId },
    { $set: { asmId: toId } },
    sessionOpt(session)
  );

  // Full RM scope (direct asmId + via RSM links)
  const rmIds = await getRmIdsUnderAsm(fromId, session);

  const rmUpdate = await User.updateMany(
    { role: ROLES.RM, _id: { $in: rmIds } },
    { $set: { asmId: toId } },
    sessionOpt(session)
  );

  let partnersQuery = User.find({
    role: ROLES.PARTNER,
    rmId: { $in: rmIds },
  }).select("_id");
  if (session) partnersQuery = partnersQuery.session(session);
  const partners = await partnersQuery.lean();
  const partnerIds = partners.map((p) => p._id);

  const partnerUpdate = await User.updateMany(
    { role: ROLES.PARTNER, rmId: { $in: rmIds } },
    { $set: { asmId: toId } },
    sessionOpt(session)
  );

  let customerUpdate = { modifiedCount: 0 };
  if (partnerIds.length) {
    customerUpdate = await User.updateMany(
      {
        role: ROLES.CUSTOMER,
        $or: [
          { partnerId: { $in: partnerIds } },
          { asmId: fromId },
        ],
      },
      { $set: { asmId: toId } },
      sessionOpt(session)
    );
  } else {
    customerUpdate = await User.updateMany(
      { role: ROLES.CUSTOMER, asmId: fromId },
      { $set: { asmId: toId } },
      sessionOpt(session)
    );
  }

  // Open apps under this ASM / RMs / partners — move asmId for visibility
  const openAppFilter = buildReassignableApplicationFilter({
    $or: [
      { asmId: fromId },
      { rmId: { $in: rmIds } },
      ...(partnerIds.length ? [{ partnerId: { $in: partnerIds } }] : []),
    ],
  });
  const appUpdate = await Application.updateMany(
    openAppFilter,
    { $set: { asmId: toId, "customer.asmId": toId } },
    sessionOpt(session)
  );

  // Pending incentives created under old ASM
  const incentiveUpdate = await Incentive.updateMany(
    { asmId: fromId, status: REASSIGNABLE_INCENTIVE_STATUS },
    { $set: { asmId: toId } },
    sessionOpt(session)
  );

  return {
    movedRsms: rsmUpdate.modifiedCount || 0,
    movedRms: rmUpdate.modifiedCount || 0,
    movedPartners: partnerUpdate.modifiedCount || 0,
    movedCustomers: customerUpdate.modifiedCount || 0,
    movedApplications: appUpdate.modifiedCount || 0,
    movedIncentives: incentiveUpdate.modifiedCount || 0,
    rmIds,
    partnerIds,
  };
}
