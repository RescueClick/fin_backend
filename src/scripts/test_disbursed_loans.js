import "dotenv/config.js";
import mongoose from "mongoose";
import { connectDB } from "../db/db.js";
import { Application } from "../models/Application.js";
import { activeApplicationsFilter } from "../utils/activeApplicationsFilter.js";
import { getDisbursedAt } from "../utils/asmHierarchy.js";

async function run() {
  await connectDB(process.env.MONGO_URI);

  const filter = activeApplicationsFilter({
    status: "DISBURSED",
  });

  const apps = await Application.find(filter)
    .populate("customerId", "firstName lastName email phone")
    .populate("partnerId", "firstName lastName employeeId partnerCode email phone")
    .populate("rmId", "firstName lastName employeeId phone email")
    .lean();

  console.log(`Found ${apps.length} DISBURSED application(s):`);
  let total = 0;
  apps.forEach((a) => {
    const amt = Number(a.approvedLoanAmount || a.requestedAmount || 0);
    total += amt;
    const dDate = getDisbursedAt(a);
    console.log({
      id: a._id,
      appNo: a.appNo,
      customer: `${a.customerId?.firstName || a.customer?.firstName} ${a.customerId?.lastName || a.customer?.lastName}`,
      partner: `${a.partnerId?.firstName} ${a.partnerId?.lastName} (${a.partnerId?.partnerCode || a.partnerId?.employeeId})`,
      amount: amt,
      disbursedAt: dDate,
    });
  });

  console.log(`Total Disbursed Volume: ₹${total.toLocaleString("en-IN")}`);

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
