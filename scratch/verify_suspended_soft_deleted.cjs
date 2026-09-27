require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(
    process.env.MONGO_URI ||
      process.env.MONGODB_URI ||
      process.env.DATABASE_URL
  );
  const User = mongoose.connection.collection("users");

  const placeholderOwners = await User.find({
    role: { $in: ["SUPER_ADMIN", "ADMIN"] },
  })
    .project({ _id: 1 })
    .toArray();
  const placeholderRmIds = placeholderOwners.map((u) => u._id);

  const list = await User.find({
    role: "PARTNER",
    rmId: {
      $exists: true,
      $ne: null,
      ...(placeholderRmIds.length ? { $nin: placeholderRmIds } : {}),
    },
    $and: [
      { status: { $ne: "PENDING" } },
      {
        $or: [
          { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
          {
            deletedAt: { $exists: true, $ne: null },
            status: { $in: ["SUSPENDED", "INACTIVE"] },
          },
        ],
      },
    ],
  })
    .project({ firstName: 1, lastName: 1, status: 1, deletedAt: 1 })
    .toArray();

  const soft = list.filter((p) => p.deletedAt);
  const active = list.filter((p) => !p.deletedAt && p.status === "ACTIVE");
  const suspendedLive = list.filter(
    (p) => !p.deletedAt && p.status !== "ACTIVE"
  );

  console.log(
    JSON.stringify(
      {
        totalReturned: list.length,
        activeCount: active.length,
        suspendedLiveCount: suspendedLive.length,
        softDeletedInSuspended: soft.length,
        softSample: soft.slice(0, 7).map((p) => ({
          name: `${p.firstName} ${p.lastName}`,
          status: p.status,
        })),
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
