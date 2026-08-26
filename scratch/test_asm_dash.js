import mongoose from "mongoose";
import dotenv from "dotenv";
import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";
import { getRmIdsUnderAsm } from "../src/utils/asmHierarchy.js";
import { activeApplicationsFilter } from "../src/utils/activeApplicationsFilter.js";

dotenv.config();

async function testAsmDash(asmId, name) {
  const rsms = await User.find({ asmId, role: "RSM" }).lean();
  const rsmIds = rsms.map((rsm) => rsm._id);
  const rsmOids = rsmIds.map((id) => new mongoose.Types.ObjectId(id));
  const asmOid = new mongoose.Types.ObjectId(asmId);

  const rmIds = await getRmIdsUnderAsm(asmId);
  const rmOids = rmIds.map((id) => new mongoose.Types.ObjectId(id));

  const partners = await User.find({
    rmId: { $in: rmIds },
    role: "PARTNER",
    status: { $ne: "PENDING" },
  }).lean();

  const totalRSMs = rsms.length;
  const totalRMs = rmIds.length;
  const totalPartners = partners.length;
  const activePartners = await User.countDocuments({
    rmId: { $in: rmIds },
    role: "PARTNER",
    status: "ACTIVE",
  });

  const appAsmMatch = activeApplicationsFilter({
    $or: [
      { asmId: asmOid },
      ...(rsmOids.length ? [{ rsmId: { $in: rsmOids } }] : []),
      ...(rmOids.length ? [{ rmId: { $in: rmOids } }] : []),
    ],
  });

  const customers = await Application.distinct("customerId", appAsmMatch);
  const totalCustomers = customers.length;

  const inProcessApplications = await Application.countDocuments({
    ...appAsmMatch,
    status: { $in: ["UNDER_REVIEW", "APPROVED", "AGREEMENT"] },
  });

  const revenueAgg = await Application.aggregate([
    {
      $match: {
        ...appAsmMatch,
        status: "DISBURSED",
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: { $ifNull: ["$approvedLoanAmount", 0] } },
      },
    },
  ]);
  const totalRevenue = revenueAgg[0]?.total || 0;

  console.log(`\n=== DASHBOARD STATS FOR: ${name} (${asmId}) ===`);
  console.log(`  Total RSMs: ${totalRSMs}`);
  console.log(`  Total RMs: ${totalRMs}`);
  console.log(`  Total Partners: ${totalPartners}`);
  console.log(`  Active Partners: ${activePartners}`);
  console.log(`  Total Customers: ${totalCustomers}`);
  console.log(`  In-process Applications: ${inProcessApplications}`);
  console.log(`  Total Revenue: ₹${(totalRevenue / 100000).toFixed(2)}L`);
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  await testAsmDash("6a65e75844d77ea296313ecf", "Anil Bagad");
  await testAsmDash("69cd478a5fa30bba81e88a34", "Sunil Bagad");
  process.exit(0);
}

run();
