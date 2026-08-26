import "dotenv/config.js";
import mongoose from "mongoose";
import { connectDB } from "../db/db.js";
import { User } from "../models/User.js";
import { ROLES } from "../config/roles.js";

async function run() {
  await connectDB(process.env.MONGO_URI);

  const allPartners = await User.find({ role: ROLES.PARTNER }).lean();
  console.log(`Total partners in DB: ${allPartners.length}`);

  const missingPartnerCode = allPartners.filter((p) => !p.partnerCode);
  console.log(`Partners missing partnerCode: ${missingPartnerCode.length}`);
  missingPartnerCode.forEach((p) => {
    console.log(`- ${p._id} | ${p.firstName} ${p.lastName} | Email: ${p.email} | Phone: ${p.phone} | Status: ${p.status} | EmpId: ${p.employeeId} | RefCode: ${p.referralCode}`);
  });

  const highestEmpPartner = await User.find({
    role: ROLES.PARTNER,
    employeeId: { $regex: /^TLP\d+$/i },
  })
    .sort({ employeeId: -1 })
    .limit(5)
    .select("employeeId firstName lastName")
    .lean();

  console.log("Highest TLP Employee IDs:", highestEmpPartner);

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
