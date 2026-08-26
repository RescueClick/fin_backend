import mongoose from "mongoose";
import dotenv from "dotenv";
import { Application } from "../src/models/Application.js";
import { User } from "../src/models/User.js";
import { activeApplicationsFilter } from "../src/utils/activeApplicationsFilter.js";

dotenv.config();

async function testRsmDash() {
  await mongoose.connect(process.env.MONGO_URI);
  const rsmId = "6a65e93e44d77ea296314020"; // Kanchan Ghorpade
  const rsmObjectId = new mongoose.Types.ObjectId(rsmId);

  const rms = await User.find({ role: "RM", personalRsmId: rsmObjectId }).lean();
  const rmIds = rms.map((rm) => rm._id);

  const ltFilter = { loanType: "PERSONAL" };

  const appScope = activeApplicationsFilter({
    $or: [
      { rsmId: rsmObjectId },
      ...(rmIds.length ? [{ rmId: { $in: rmIds }, ...ltFilter }] : []),
    ],
    ...ltFilter,
  });

  const totalCustomers = (await Application.distinct("customerId", appScope)).length;
  const inProcess = await Application.countDocuments({ ...appScope, status: { $in: ["UNDER_REVIEW", "APPROVED", "AGREEMENT"] } });
  const disbursed = await Application.countDocuments({ ...appScope, status: "DISBURSED" });
  const totalApps = await Application.countDocuments(appScope);

  console.log(`\n=== RSM DASHBOARD: Kanchan Ghorpade ===`);
  console.log(`  RMs under Kanchan: ${rms.length}`);
  console.log(`  Total Customers: ${totalCustomers}`);
  console.log(`  Total Apps: ${totalApps}`);
  console.log(`  In-process Apps: ${inProcess}`);
  console.log(`  Disbursed Apps: ${disbursed}`);

  process.exit(0);
}

testRsmDash();
