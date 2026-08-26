import mongoose from "mongoose";
import dotenv from "dotenv";
import { User } from "../src/models/User.js";

dotenv.config();

async function checkPartners() {
  await mongoose.connect(process.env.MONGO_URI);
  const partners = await User.find({ rmId: "6a439c6d815f90506104cb6e" }).lean();
  console.log(`Found ${partners.length} partners with admin rmId:`);
  for (const p of partners) {
    console.log(`  Partner: ${p.firstName} ${p.lastName} (${p.employeeId || p._id}, phone: ${p.phone}, email: ${p.email})`);
  }
  process.exit(0);
}

checkPartners();
