import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { getRmIdsUnderRsm, getRsmScopeIds } from "../src/utils/asmHierarchy.js";

async function testSeniorManagerScope() {
  await connectDB(process.env.MONGO_URI);

  // Pick one of our senior RSMs, e.g. Anil Bagad
  const anil = await User.findOne({ email: "bagadanil08@gmail.com" }).lean();
  console.log(`\nTesting Senior RSM: ${anil.firstName} ${anil.lastName} (Role: ${anil.role})`);

  const scope = await getRsmScopeIds(anil._id);
  console.log(`Subordinate ASMs count: ${scope.asmIds.length}`);
  console.log(`Subordinate RMs count: ${scope.rmIds.length}`);
  console.log(`Subordinate Partners count: ${scope.partnerIds.length}`);

  // Fetch subordinate ASMs details
  const asms = await User.find({ _id: { $in: scope.asmIds } }).lean();
  console.log("\nSubordinate ASMs:");
  for (const a of asms) {
    console.log(` - [${a.role}] ${a.firstName} ${a.lastName} (${a.email}) Type: ${a.asmType || a.rsmType}`);
  }

  // Fetch subordinate RMs details
  const rms = await User.find({ _id: { $in: scope.rmIds } }).lean();
  console.log("\nSubordinate RMs:");
  for (const rm of rms) {
    console.log(` - [${rm.role}] ${rm.firstName} ${rm.lastName} (${rm.email})`);
  }

  await mongoose.disconnect();
}

testSeniorManagerScope();
