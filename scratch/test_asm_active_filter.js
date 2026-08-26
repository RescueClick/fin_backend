import mongoose from "mongoose";
import dotenv from "dotenv";
import { Application } from "../src/models/Application.js";
import { User } from "../src/models/User.js";
import { getRmIdsUnderAsm } from "../src/utils/asmHierarchy.js";
import { activeApplicationsFilter } from "../src/utils/activeApplicationsFilter.js";

dotenv.config();

async function testAsmActiveFilter() {
  await mongoose.connect(process.env.MONGO_URI);
  const asmId = "6a65e75844d77ea296313ecf"; // Anil Bagad
  const asmOid = new mongoose.Types.ObjectId(asmId);

  const rsms = await User.find({ asmId, role: "RSM" }).lean();
  const rsmIds = rsms.map((rsm) => rsm._id);
  const rsmOids = rsmIds.map((id) => new mongoose.Types.ObjectId(id));

  const rmIds = await getRmIdsUnderAsm(asmId);
  const rmOids = rmIds.map((id) => new mongoose.Types.ObjectId(id));

  const appAsmMatch = activeApplicationsFilter({
    $or: [
      { asmId: asmOid },
      ...(rsmOids.length ? [{ rsmId: { $in: rsmOids } }] : []),
      ...(rmOids.length ? [{ rmId: { $in: rmOids } }] : []),
    ],
  });

  const apps = await Application.find(appAsmMatch).lean();
  console.log(`Matched Apps using activeApplicationsFilter: ${apps.length}`);

  const distinctCustomerIds = await Application.distinct("customerId", appAsmMatch);
  console.log(`Distinct Customers: ${distinctCustomerIds.length}`);

  process.exit(0);
}

testAsmActiveFilter();
