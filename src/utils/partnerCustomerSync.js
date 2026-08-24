/**
 * Resolve customers for a partner without losing forms when User.partnerId was never set.
 * Prefer Application ownership (source of truth) + any User rows already linked by partnerId.
 */
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";
import { ROLES } from "../config/roles.js";
import { activeApplicationsFilter } from "./activeApplicationsFilter.js";
import { activeUsersFilter } from "./activeUsersFilter.js";

export async function findCustomersForPartner(partnerId) {
  const [linked, appCustomerIds, partnerApps] = await Promise.all([
    User.find({
      role: ROLES.CUSTOMER,
      $or: [{ partnerId }, { referredBy: partnerId }],
      ...activeUsersFilter(),
    }).select("_id").lean(),
    Application.distinct("customerId", activeApplicationsFilter({ partnerId })),
    Application.find({ partnerId, ...activeApplicationsFilter() }).select("customerId customer appNo createdAt").lean(),
  ]);

  const idSet = new Set([
    ...linked.map((u) => String(u._id)),
    ...appCustomerIds.filter(Boolean).map(String),
  ]);

  let users = [];
  if (idSet.size > 0) {
    users = await User.find({
      _id: { $in: [...idSet] },
      role: ROLES.CUSTOMER,
    })
      .select("-passwordHash -__v")
      .lean();

    // Auto-heal any soft-deleted customers who have active applications under this partner
    const idsToReactivate = users
      .filter((u) => u.deletedAt != null || u.status === "SUSPENDED")
      .map((u) => u._id);

    if (idsToReactivate.length > 0) {
      await User.updateMany(
        { _id: { $in: idsToReactivate } },
        { $set: { deletedAt: null, status: "ACTIVE", partnerId } }
      );
      users.forEach((u) => {
        if (idsToReactivate.some((id) => id.toString() === u._id.toString())) {
          u.deletedAt = null;
          u.status = "ACTIVE";
          u.partnerId = partnerId;
        }
      });
    }
  }

  // Ensure every active application under this partner has a customer represented
  const existingCustIds = new Set(users.map((u) => String(u._id)));
  for (const app of partnerApps) {
    const cId = app.customerId ? String(app.customerId) : String(app._id);
    if (!existingCustIds.has(cId) && app.customer) {
      existingCustIds.add(cId);
      users.push({
        _id: app.customerId || app._id,
        firstName: app.customer.firstName || "Customer",
        middleName: app.customer.middleName || "",
        lastName: app.customer.lastName || "",
        email: app.customer.email || "",
        phone: app.customer.phone || "",
        role: ROLES.CUSTOMER,
        status: "ACTIVE",
        partnerId,
        rmId: app.customer.rmId || null,
        asmId: app.customer.asmId || null,
        createdAt: app.createdAt,
      });
    }
  }

  return users;
}

/**
 * Keep Customer User linked to the owning partner and current RM.
 * Does not change Application.partnerId (ownership stays with the same partner).
 * Never steals a customer already linked to a different partner.
 */
export async function syncCustomersRmForPartners({
  partnerIds,
  toRmId,
  toAsmId = null,
  session = null,
}) {
  let synced = 0;
  for (const partnerId of partnerIds) {
    let appQuery = Application.find({ partnerId }).select("customerId");
    if (session) appQuery = appQuery.session(session);
    const appRows = await appQuery.lean();
    const fromApps = appRows.map((r) => r.customerId).filter(Boolean);

    const setFields = {
      rmId: toRmId,
      updatedAt: new Date(),
      ...(toAsmId ? { asmId: toAsmId } : {}),
    };

    // Already under this partner — only refresh RM (+ ASM if known)
    const linkedUpdate = await User.updateMany(
      {
        role: ROLES.CUSTOMER,
        partnerId,
      },
      { $set: setFields },
      session ? { session } : undefined
    );
    synced += linkedUpdate.modifiedCount || 0;

    // Apps under this partner but User.partnerId never set — attach without stealing
    if (fromApps.length) {
      const orphanUpdate = await User.updateMany(
        {
          role: ROLES.CUSTOMER,
          _id: { $in: fromApps },
          $or: [
            { partnerId: null },
            { partnerId: { $exists: false } },
            { partnerId },
          ],
        },
        {
          $set: {
            partnerId,
            ...setFields,
          },
        },
        session ? { session } : undefined
      );
      synced += orphanUpdate.modifiedCount || 0;
    }
  }
  return synced;
}
