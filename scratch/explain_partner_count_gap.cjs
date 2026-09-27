require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  const uri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL;
  await mongoose.connect(uri);
  const User = mongoose.connection.collection("users");

  // Admin dashboard totalPartners logic
  const adminDashboardTotal = await User.countDocuments({
    role: "PARTNER",
    status: { $ne: "PENDING" },
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  });

  const adminActive = await User.countDocuments({
    role: "PARTNER",
    status: "ACTIVE",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  });

  // How /get-rms-for-transfer counts (NO deletedAt, NO status filter)
  const rms = await User.find({ role: "RM" }).project({ _id: 1, firstName: 1, lastName: 1, status: 1, deletedAt: 1 }).toArray();

  let sumRmRaw = 0; // all partners by rmId
  let sumRmNotDeleted = 0;
  let sumRmActive = 0;
  let sumRmNonPendingNotDeleted = 0;
  let sumRmIncludingDeletedPending = 0;

  const buckets = {
    activeNotDeleted: 0,
    pendingNotDeleted: 0,
    suspendedNotDeleted: 0,
    inactiveNotDeleted: 0,
    softDeleted: 0,
    other: 0,
  };

  for (const rm of rms) {
    const partners = await User.find({ role: "PARTNER", rmId: rm._id })
      .project({ status: 1, deletedAt: 1 })
      .toArray();
    sumRmRaw += partners.length;
    for (const p of partners) {
      const deleted = p.deletedAt != null;
      if (deleted) {
        buckets.softDeleted += 1;
      } else if (p.status === "ACTIVE") {
        buckets.activeNotDeleted += 1;
        sumRmActive += 1;
        sumRmNotDeleted += 1;
        sumRmNonPendingNotDeleted += 1;
      } else if (p.status === "PENDING") {
        buckets.pendingNotDeleted += 1;
        sumRmNotDeleted += 1;
      } else if (p.status === "SUSPENDED") {
        buckets.suspendedNotDeleted += 1;
        sumRmNotDeleted += 1;
        sumRmNonPendingNotDeleted += 1;
      } else if (p.status === "INACTIVE") {
        buckets.inactiveNotDeleted += 1;
        sumRmNotDeleted += 1;
        sumRmNonPendingNotDeleted += 1;
      } else {
        buckets.other += 1;
        sumRmNotDeleted += 1;
      }
    }
  }

  // Partners not under any RM
  const allPartnersNotDeleted = await User.countDocuments({
    role: "PARTNER",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  });

  const partnersWithRm = await User.countDocuments({
    role: "PARTNER",
    rmId: { $exists: true, $ne: null },
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  });

  // New admin Partner list filter: ACTIVE + real RM only
  const placeholders = await User.find({ role: { $in: ["SUPER_ADMIN", "ADMIN"] } })
    .project({ _id: 1 })
    .toArray();
  const placeholderIds = placeholders.map((u) => u._id);

  const adminPartnerPageStyle = await User.aggregate([
    {
      $match: {
        role: "PARTNER",
        status: { $ne: "PENDING" },
        rmId: { $exists: true, $ne: null, $nin: placeholderIds },
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "rmId",
        foreignField: "_id",
        as: "rm",
      },
    },
    { $unwind: "$rm" },
    { $match: { "rm.role": "RM" } },
    { $count: "n" },
  ]).toArray();

  console.log(
    JSON.stringify(
      {
        adminDashboardTotalPartners: adminDashboardTotal,
        adminDashboardActivePartners: adminActive,
        sumAcrossAllRMs_rawNoFilters: sumRmRaw,
        sumAcrossAllRMs_notDeleted: sumRmNotDeleted,
        sumAcrossAllRMs_activeOnly: sumRmActive,
        sumAcrossAllRMs_nonPendingNotDeleted: sumRmNonPendingNotDeleted,
        breakdownOnRmLists: buckets,
        allPartnersNotDeleted,
        partnersWithAnyRmIdNotDeleted: partnersWithRm,
        gap_371_vs_343_explained: {
          assumedUserRmSum: 371,
          adminShows: 343,
          difference: 371 - 343,
          pendingOnRms: buckets.pendingNotDeleted,
          softDeletedOnRms: buckets.softDeleted,
          pendingPlusSoftDeleted: buckets.pendingNotDeleted + buckets.softDeleted,
        },
        adminPartnerPageRealRmCount: adminPartnerPageStyle[0]?.n || 0,
        rmCount: rms.length,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
