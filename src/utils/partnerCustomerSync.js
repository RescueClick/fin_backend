/**
 * Resolve customers for a partner without losing forms when User.partnerId was never set.
 * Prefer Application ownership (source of truth) + any User rows already linked by partnerId.
 */
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";
import { ROLES } from "../config/roles.js";

export async function findCustomersForPartner(partnerId) {
  const [linked, appCustomerIds] = await Promise.all([
    User.find({ role: ROLES.CUSTOMER, partnerId }).select("_id").lean(),
    Application.distinct("customerId", { partnerId }),
  ]);

  const idSet = new Set([
    ...linked.map((u) => String(u._id)),
    ...appCustomerIds.filter(Boolean).map(String),
  ]);

  if (idSet.size === 0) return [];

  return User.find({
    _id: { $in: [...idSet] },
    role: ROLES.CUSTOMER,
  })
    .select("-passwordHash -__v")
    .lean();
}

/**
 * Keep Customer User linked to the owning partner and current RM.
 * Does not change Application.partnerId (ownership stays with the same partner).
 */
export async function syncCustomersRmForPartners({
  partnerIds,
  toRmId,
  session = null,
}) {
  let synced = 0;
  for (const partnerId of partnerIds) {
    let appQuery = Application.find({ partnerId }).select("customerId");
    if (session) appQuery = appQuery.session(session);
    const appRows = await appQuery.lean();
    const fromApps = appRows.map((r) => r.customerId).filter(Boolean);

    const result = await User.updateMany(
      {
        role: ROLES.CUSTOMER,
        $or: [{ partnerId }, { _id: { $in: fromApps } }],
      },
      {
        $set: {
          partnerId,
          rmId: toRmId,
          updatedAt: new Date(),
        },
      },
      session ? { session } : undefined
    );
    synced += result.modifiedCount || 0;
  }
  return synced;
}
