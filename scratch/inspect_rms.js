import mongoose from "mongoose";
import dotenv from "dotenv";
import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";

dotenv.config();

async function checkDetails() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const rms = await User.find({ role: "RM" }).lean();
  console.log("=== RMS ===");
  for (const rm of rms) {
    const partnerCount = await User.countDocuments({ role: "PARTNER", rmId: rm._id });
    const appCount = await Application.countDocuments({ rmId: rm._id });
    console.log(`RM: ${rm.firstName} ${rm.lastName} (${rm.employeeId}, ID: ${rm._id})`);
    console.log(`   asmId: ${rm.asmId}`);
    console.log(`   personalRsmId: ${rm.personalRsmId}`);
    console.log(`   businessHomeRsmId: ${rm.businessHomeRsmId}`);
    console.log(`   partners: ${partnerCount}, apps: ${appCount}`);
    console.log(`   region: ${rm.region}, createdBy: ${rm.createdBy || 'N/A'}`);
  }

  process.exit(0);
}

checkDetails();
