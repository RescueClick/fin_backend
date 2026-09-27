require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(
    process.env.MONGO_URI ||
      process.env.MONGODB_URI ||
      process.env.DATABASE_URL
  );
  const User = mongoose.connection.collection("users");

  const softDeletedByStatus = await User.aggregate([
    { $match: { role: "PARTNER", deletedAt: { $ne: null, $exists: true } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();

  const allPartnerStatuses = await User.aggregate([
    { $match: { role: "PARTNER" } },
    {
      $group: {
        _id: {
          status: "$status",
          deleted: {
            $cond: [
              { $and: [{ $ne: ["$deletedAt", null] }, { $ifNull: ["$deletedAt", false] }] },
              true,
              false,
            ],
          },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ]).toArray();

  const grandTotal = await User.countDocuments({ role: "PARTNER" });

  console.log(
    JSON.stringify(
      {
        grandTotalAllPartnerRecords: grandTotal,
        softDeletedByStatus,
        allPartnerStatuses,
        // closest recipes to 371
        recipes: {
          active_plus_pending: 343 + 18,
          rmRawSum_plus_pending: 350 + 18,
          active_plus_pending_plus_softDeleted7: 343 + 18 + 7,
          allPartnerRecords: grandTotal,
        },
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
