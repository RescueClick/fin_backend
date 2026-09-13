const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const User = mongoose.connection.collection("users");

  const rsms = await User.find({ role: "RSM" })
    .project({ email: 1, firstName: 1, lastName: 1, status: 1, employeeId: 1 })
    .toArray();
  console.log("All RSMs:", rsms);

  const target =
    (await User.findOne({ _id: new mongoose.Types.ObjectId("6a8c3ff4f609166f305c1743") })) ||
    (await User.findOne({ email: "sanjaygawai2027@gmail.com" })) ||
    rsms[0];

  console.log("Target user:", target && {
    _id: target._id,
    email: target.email,
    role: target.role,
    status: target.status,
    firstName: target.firstName,
  });

  if (target) {
    const asms = await User.find({
      role: "ASM",
      $or: [{ rsmId: target._id }, { asmId: target._id }],
    })
      .project({ firstName: 1, lastName: 1, status: 1, email: 1, rsmId: 1, asmId: 1 })
      .toArray();
    console.log("Subordinate ASMs:", asms.length, asms);

    const token = jwt.sign(
      { sub: String(target._id), role: target.role, email: target.email },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    console.log("JWT role:", target.role);

    try {
      const res = await axios.get("http://localhost:5000/api/asm/get-rsms", {
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log("get-rsms local:", res.status, Array.isArray(res.data) ? res.data.length : res.data);
    } catch (e) {
      console.log("get-rsms local FAIL:", e.response?.status, e.response?.data || e.message);
    }
  }

  // Also test with admin
  const admin = await User.findOne({ role: "SUPER_ADMIN" });
  if (admin) {
    const token = jwt.sign(
      { sub: String(admin._id), role: admin.role, email: admin.email },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    try {
      const res = await axios.get("http://localhost:5000/api/admin/get-rsm", {
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log("admin get-rsm:", res.status, Array.isArray(res.data) ? res.data.length : res.data);
    } catch (e) {
      console.log("admin get-rsm FAIL:", e.response?.status, e.response?.data || e.message);
    }
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
