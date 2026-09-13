const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const { default: User } = await import("../src/models/User.js");

  const viaModel = await User.find({
    role: "RSM",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).select("firstName email status deletedAt");

  console.log("via mongoose model:", viaModel.length);
  viaModel.forEach((u) =>
    console.log("-", u.firstName, u.email, u.status, u.deletedAt)
  );

  const col = mongoose.connection.collection("users");
  const viaCol = await col
    .find({ role: "RSM" })
    .project({ firstName: 1, email: 1, status: 1, deletedAt: 1 })
    .toArray();
  console.log("via collection:", viaCol.length);
  viaCol.forEach((u) =>
    console.log("*", u.firstName, u.email, u.status, u.deletedAt)
  );

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
