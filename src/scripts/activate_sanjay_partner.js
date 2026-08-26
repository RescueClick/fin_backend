import "dotenv/config.js";
import mongoose from "mongoose";
import { connectDB } from "../db/db.js";
import { User } from "../models/User.js";
import { Config } from "../models/Config.js";
import { ROLES } from "../config/roles.js";

async function run() {
  await connectDB(process.env.MONGO_URI);

  // 1. Find Sanjay Gawai (Partner)
  const partnerUser = await User.findOne({
    _id: new mongoose.Types.ObjectId("6a8c3dc27038cfc5ab162d2a"),
    role: ROLES.PARTNER,
  });

  if (!partnerUser) {
    console.error("Sanjay Gawai (Partner) not found!");
    process.exit(1);
  }

  // Generate / assign partner code and employee ID
  const partnerCode = partnerUser.partnerCode || "PT-SG772096";
  const employeeId = partnerUser.employeeId || "TLP0277";

  partnerUser.partnerCode = partnerCode;
  partnerUser.referralCode = partnerCode;
  partnerUser.employeeId = employeeId;
  partnerUser.status = "ACTIVE";
  partnerUser.isVerified = true;
  partnerUser.isEmailVerified = true;
  partnerUser.isPhoneVerified = true;

  await partnerUser.save();
  console.log("✅ Sanjay Gawai (Partner) updated successfully:", {
    id: partnerUser._id,
    name: `${partnerUser.firstName} ${partnerUser.lastName}`,
    role: partnerUser.role,
    email: partnerUser.email,
    phone: partnerUser.phone,
    status: partnerUser.status,
    partnerCode: partnerUser.partnerCode,
    referralCode: partnerUser.referralCode,
    employeeId: partnerUser.employeeId,
  });

  // 2. Set as Default Public Loan Referral Partner in Config
  const payload = {
    partnerId: String(partnerUser._id),
    partnerCode: partnerCode,
  };

  let config = await Config.findOne({ key: "PUBLIC_LOAN_DEFAULT_PARTNER_CODE" });
  if (config) {
    config.value = payload;
    await config.save();
  } else {
    config = await Config.create({
      key: "PUBLIC_LOAN_DEFAULT_PARTNER_CODE",
      value: payload,
    });
  }

  console.log("✅ Config PUBLIC_LOAN_DEFAULT_PARTNER_CODE set to Sanjay Gawai:", payload);

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
