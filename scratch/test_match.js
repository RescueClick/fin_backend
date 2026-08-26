import mongoose from "mongoose";
import dotenv from "dotenv";
import { Application } from "../src/models/Application.js";
import { User } from "../src/models/User.js";
import { getRmIdsUnderAsm } from "../src/utils/asmHierarchy.js";

dotenv.config();

async function testMatch() {
  await mongoose.connect(process.env.MONGO_URI);
  const asmId = "6a65e75844d77ea296313ecf"; // Anil Bagad
  const asmOid = new mongoose.Types.ObjectId(asmId);

  const rsms = await User.find({ asmId, role: "RSM" }).lean();
  const rsmIds = rsms.map((rsm) => rsm._id);
  const rsmOids = rsmIds.map((id) => new mongoose.Types.ObjectId(id));

  const rmIds = await getRmIdsUnderAsm(asmId);
  const rmOids = rmIds.map((id) => new mongoose.Types.ObjectId(id));

  console.log("asmOid:", asmOid);
  console.log("rsmOids:", rsmOids);
  console.log("rmOids:", rmOids);

  const appAsmMatch = {
    $or: [
      { asmId: asmOid },
      ...(rsmOids.length ? [{ rsmId: { $in: rsmOids } }] : []),
      ...(rmOids.length ? [{ rmId: { $in: rmOids } }] : []),
    ],
    deletedAt: null,
  };

  const apps = await Application.find(appAsmMatch).lean();
  console.log(`Application.find(appAsmMatch).length: ${apps.length}`);

  const distinctCustomerIds = await Application.distinct("customerId", appAsmMatch);
  console.log(`Application.distinct("customerId", appAsmMatch).length: ${distinctCustomerIds.length}`);

  console.log("Distinct customerIds:", distinctCustomerIds);

  // Check all customer IDs in the apps
  const rawCustomerIds = apps.map(a => a.customerId);
  console.log(`Raw customerIds in matched apps: ${rawCustomerIds.length}`);
  const uniqueRaw = new Set(rawCustomerIds.map(String));
  console.log(`Unique raw customerIds: ${uniqueRaw.size}`);

  process.exit(0);
}

testMatch();
