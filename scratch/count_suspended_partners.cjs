require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  const uri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL;
  if (!uri) throw new Error("No Mongo URI in .env");

  await mongoose.connect(uri);
  const User = mongoose.connection.collection("users");

  const suspendedPartners = await User.countDocuments({
    role: "PARTNER",
    status: "SUSPENDED",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  });

  const suspendedIncludingDeleted = await User.countDocuments({
    role: "PARTNER",
    status: "SUSPENDED",
  });

  const byStatus = await User.aggregate([
    {
      $match: {
        role: "PARTNER",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  console.log("suspendedPartners (not deleted):", suspendedPartners);
  console.log("suspendedPartners (all):", suspendedIncludingDeleted);
  console.log("byStatus:", JSON.stringify(byStatus));
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
