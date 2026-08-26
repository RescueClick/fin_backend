import "dotenv/config.js";
import mongoose from "mongoose";
import { connectDB } from "../db/db.js";
import { User } from "../models/User.js";

async function run() {
  await connectDB(process.env.MONGO_URI);
  const users = await User.find({
    $or: [
      { firstName: /sanjay/i },
      { lastName: /gawai/i },
      { email: /sanjay/i },
      { phone: /9822/i }, // or any match
    ],
  }).lean();

  console.log(`Found ${users.length} user(s) matching 'sanjay' or 'gawai':`);
  users.forEach((u) => {
    console.log({
      id: u._id,
      name: `${u.firstName} ${u.lastName}`,
      email: u.email,
      phone: u.phone,
      role: u.role,
      status: u.status,
      partnerCode: u.partnerCode,
      referralCode: u.referralCode,
      employeeId: u.employeeId,
      isVerified: u.isVerified,
    });
  });

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
