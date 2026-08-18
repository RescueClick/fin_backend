import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import { Application } from "../src/models/Application.js";
import { User } from "../src/models/User.js";

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to Mongo");

    const eids = ["TLC0091", "TLC0090"];

    const users = await User.find({ employeeId: { $in: eids } });
    console.log(`Found ${users.length} users to restore`);

    for (const u of users) {
      u.status = "ACTIVE";
      u.deletedAt = null;
      await u.save();
      console.log(`Restored User ${u.firstName} ${u.lastName} (${u.employeeId})`);
    }

    const appNos = ["TLF0088", "TLF0089"];
    const userIds = users.map(u => u._id);

    const appRes = await Application.updateMany(
      { $or: [{ appNo: { $in: appNos } }, { customerId: { $in: userIds } }] },
      { $set: { deletedAt: null, isArchived: false } }
    );

    console.log(`Restored ${appRes.modifiedCount} applications`);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
