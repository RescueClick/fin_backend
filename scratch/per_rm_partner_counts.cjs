require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  const uri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL;
  await mongoose.connect(uri);
  const User = mongoose.connection.collection("users");

  // List each RM with different count methods
  const rms = await User.find({ role: "RM" })
    .project({ firstName: 1, lastName: 1, employeeId: 1, status: 1, deletedAt: 1 })
    .toArray();

  const rows = [];
  for (const rm of rms) {
    const raw = await User.countDocuments({ role: "PARTNER", rmId: rm._id });
    const notDeleted = await User.countDocuments({
      role: "PARTNER",
      rmId: rm._id,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });
    const active = await User.countDocuments({
      role: "PARTNER",
      rmId: rm._id,
      status: "ACTIVE",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });
    const nonPending = await User.countDocuments({
      role: "PARTNER",
      rmId: rm._id,
      status: { $ne: "PENDING" },
    });
    rows.push({
      name: `${rm.firstName || ""} ${rm.lastName || ""}`.trim(),
      employeeId: rm.employeeId,
      rmStatus: rm.status,
      rmDeleted: !!rm.deletedAt,
      rawAll: raw,
      notDeleted,
      active,
      nonPendingNoDeleteFilter: nonPending,
    });
  }

  // PENDING partners — who owns them?
  const pending = await User.aggregate([
    {
      $match: {
        role: "PARTNER",
        status: "PENDING",
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
    {
      $project: {
        firstName: 1,
        lastName: 1,
        rmRole: { $arrayElemAt: ["$rm.role", 0] },
        rmName: {
          $concat: [
            { $ifNull: [{ $arrayElemAt: ["$rm.firstName", 0] }, ""] },
            " ",
            { $ifNull: [{ $arrayElemAt: ["$rm.lastName", 0] }, ""] },
          ],
        },
      },
    },
  ]).toArray();

  const pendingByRmRole = {};
  for (const p of pending) {
    const k = p.rmRole || "NONE";
    pendingByRmRole[k] = (pendingByRmRole[k] || 0) + 1;
  }

  console.log(JSON.stringify({
    perRm: rows,
    sums: {
      rawAll: rows.reduce((s, r) => s + r.rawAll, 0),
      notDeleted: rows.reduce((s, r) => s + r.notDeleted, 0),
      active: rows.reduce((s, r) => s + r.active, 0),
    },
    pendingCount: pending.length,
    pendingByRmRole,
  }, null, 2));

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
