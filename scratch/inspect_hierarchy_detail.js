import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";

async function inspectCurrent() {
  await connectDB(process.env.MONGO_URI);

  console.log("=== CURRENT ASMs ===");
  const asms = await User.find({ role: "ASM" }).lean();
  for (const a of asms) {
    console.log(`ASM [${a._id}]: ${a.firstName} ${a.lastName} (${a.email}), adminId: ${a.adminId}`);
  }

  console.log("\n=== CURRENT RSMs ===");
  const rsms = await User.find({ role: "RSM" }).lean();
  for (const r of rsms) {
    console.log(`RSM [${r._id}]: ${r.firstName} ${r.lastName} (${r.email}), rsmType: ${r.rsmType}, asmId: ${r.asmId}`);
  }

  console.log("\n=== CURRENT RMs ===");
  const rms = await User.find({ role: "RM" }).lean();
  for (const rm of rms) {
    console.log(`RM [${rm._id}]: ${rm.firstName} ${rm.lastName} (${rm.email})
   personalRsmId: ${rm.personalRsmId}
   businessRsmId: ${rm.businessRsmId}
   homeLapRsmId:  ${rm.homeLapRsmId}
   businessHomeRsmId: ${rm.businessHomeRsmId}
   asmId: ${rm.asmId}`);
  }

  console.log("\n=== APPLICATION COUNTS WITH RSM/ASM ===");
  const countWithRsm = await Application.countDocuments({ rsmId: { $ne: null } });
  const countWithAsm = await Application.countDocuments({ asmId: { $ne: null } });
  console.log(`Total apps with rsmId: ${countWithRsm}`);
  console.log(`Total apps with asmId: ${countWithAsm}`);

  await mongoose.disconnect();
}

inspectCurrent();
