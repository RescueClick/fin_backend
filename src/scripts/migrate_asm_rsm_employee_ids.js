import "dotenv/config.js";
import mongoose from "mongoose";
import { connectDB } from "../db/db.js";
import { User } from "../models/User.js";
import { ROLES } from "../config/roles.js";

async function migrateAsmRsmEmployeeIds() {
  try {
    console.log("Connecting to database...");
    await connectDB(process.env.MONGO_URI);
    console.log("Connected successfully.\n");

    // 1. Fetch all ASMs and RSMs sorted chronologically by creation date
    const asms = await User.find({ role: ROLES.ASM }).sort({ createdAt: 1 });
    const rsms = await User.find({ role: ROLES.RSM }).sort({ createdAt: 1 });

    console.log(`Found ${asms.length} ASM(s) and ${rsms.length} RSM(s).\n`);

    console.log("=== CURRENT STATE BEFORE MIGRATION ===");
    console.log("ASMs:");
    asms.forEach((u, i) => {
      console.log(`  ${i + 1}. ${u.firstName} ${u.lastName} | ID: ${u.employeeId} | Created: ${u.createdAt?.toISOString()}`);
    });
    console.log("\nRSMs:");
    rsms.forEach((u, i) => {
      console.log(`  ${i + 1}. ${u.firstName} ${u.lastName} | ID: ${u.employeeId} | Created: ${u.createdAt?.toISOString()}`);
    });
    console.log("======================================\n");

    // 2. Stage 1: Assign temporary unique employeeIds to prevent duplicate index collisions
    console.log("Stage 1: Assigning temporary placeholder IDs...");
    for (let i = 0; i < asms.length; i++) {
      await User.updateOne(
        { _id: asms[i]._id },
        { $set: { employeeId: `_TEMP_ASM_${i}_${Date.now()}` } }
      );
    }
    for (let i = 0; i < rsms.length; i++) {
      await User.updateOne(
        { _id: rsms[i]._id },
        { $set: { employeeId: `_TEMP_RSM_${i}_${Date.now()}` } }
      );
    }
    console.log("Temporary IDs assigned successfully.\n");

    // 3. Stage 2: Assign standardized TLA IDs to ASMs
    console.log("Stage 2: Assigning standardized TLA codes to ASMs...");
    const updatedAsms = [];
    for (let i = 0; i < asms.length; i++) {
      const newId = `TLA${(i + 1).toString().padStart(4, "0")}`;
      await User.updateOne(
        { _id: asms[i]._id },
        { $set: { employeeId: newId } }
      );
      updatedAsms.push({ name: `${asms[i].firstName} ${asms[i].lastName}`, oldId: asms[i].employeeId, newId });
    }

    // 4. Stage 3: Assign standardized TLS IDs to RSMs
    console.log("Stage 3: Assigning standardized TLS codes to RSMs...");
    const updatedRsms = [];
    for (let i = 0; i < rsms.length; i++) {
      const newId = `TLS${(i + 1).toString().padStart(4, "0")}`;
      await User.updateOne(
        { _id: rsms[i]._id },
        { $set: { employeeId: newId } }
      );
      updatedRsms.push({ name: `${rsms[i].firstName} ${rsms[i].lastName}`, oldId: rsms[i].employeeId, newId });
    }

    console.log("\n=== MIGRATION COMPLETED SUCCESSFULLY ===");
    console.log("Updated ASMs (TLA):");
    updatedAsms.forEach((u) => {
      console.log(`  ✓ ${u.name.padEnd(25)} : ${u.oldId} -> ${u.newId}`);
    });
    console.log("\nUpdated RSMs (TLS):");
    updatedRsms.forEach((u) => {
      console.log(`  ✓ ${u.name.padEnd(25)} : ${u.oldId} -> ${u.newId}`);
    });
    console.log("=========================================\n");

    await mongoose.disconnect();
    console.log("Database disconnected.");
    process.exit(0);
  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  }
}

migrateAsmRsmEmployeeIds();
