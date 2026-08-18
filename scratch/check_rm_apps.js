import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import { Application } from "../src/models/Application.js";
import { User } from "../src/models/User.js";

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to Mongo");

    const rms = await User.find({ role: "RM" }).select("_id firstName lastName employeeId").lean();
    console.log(`FOUND ${rms.length} RMs:`);
    rms.forEach(r => console.log(` - RM: ${r.firstName} ${r.lastName} (${r.employeeId}) ID: ${r._id}`));

    const apps = await Application.find(
      { isArchived: { $ne: true }, deletedAt: null }
    ).select("_id appNo rmId partnerId customerId customer").lean();

    console.log(`\nFOUND ${apps.length} ACTIVE APPLICATIONS:`);
    for (const app of apps) {
      const partner = app.partnerId ? await User.findById(app.partnerId).select("firstName lastName rmId employeeId").lean() : null;
      console.log(`App: ${app.appNo} (_id: ${app._id})`);
      console.log(`  - app.rmId: ${app.rmId}`);
      console.log(`  - app.partnerId: ${app.partnerId} (Partner ${partner?.firstName} ${partner?.lastName}, Partner's rmId: ${partner?.rmId})`);
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
