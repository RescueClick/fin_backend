import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";

async function dryRunMigration() {
  await connectDB(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log("--------------------------------------------------");
  console.log("🔬 DRY-RUN DATABASE MIGRATION (NO DATA CHANGED)");
  console.log("--------------------------------------------------");

  // 1. Users with role 'ASM' -> will become 'RSM'
  const oldAsms = await db.collection("users").find({ role: "ASM" }).toArray();
  console.log(`\n1. Senior Managers (${oldAsms.length} users with role: 'ASM' -> 'RSM'):`);
  for (const u of oldAsms) {
    console.log(`   - ${u.firstName} ${u.lastName} (${u.email}) [ID: ${u._id}] -> Role: RSM`);
  }

  // 2. Users with role 'RSM' -> will become 'ASM'
  const oldRsms = await db.collection("users").find({ role: "RSM" }).toArray();
  console.log(`\n2. Specialized Managers (${oldRsms.length} users with role: 'RSM' -> 'ASM'):`);
  for (const u of oldRsms) {
    console.log(`   - ${u.firstName} ${u.lastName} (${u.email}) [ID: ${u._id}] -> Role: ASM, asmType: ${u.rsmType}, parent rsmId: ${u.asmId}`);
  }

  // 3. RMs -> link pointers
  const rms = await db.collection("users").find({ role: "RM" }).toArray();
  console.log(`\n3. Relationship Managers (${rms.length} users):`);
  for (const rm of rms) {
    console.log(`   - ${rm.firstName} ${rm.lastName} [ID: ${rm._id}]:`);
    console.log(`     personalAsmId: ${rm.personalRsmId}`);
    console.log(`     businessAsmId: ${rm.businessRsmId}`);
    console.log(`     homeLapAsmId:  ${rm.homeLapRsmId || "(none)"}`);
    console.log(`     parent rsmId:  ${rm.asmId}`);
  }

  // 4. Applications to swap asmId & rsmId
  const appsWithBoth = await db.collection("applications").find({
    $or: [{ rsmId: { $ne: null } }, { asmId: { $ne: null } }]
  }).toArray();
  console.log(`\n4. Applications (${appsWithBoth.length} applications with rsmId/asmId):`);
  const sample = appsWithBoth.slice(0, 3);
  for (const app of sample) {
    console.log(`   - App ${app.appNo}:`);
    console.log(`     OLD -> rsmId (specialty): ${app.rsmId}, asmId (senior): ${app.asmId}`);
    console.log(`     NEW -> asmId (specialty): ${app.rsmId}, rsmId (senior): ${app.asmId}`);
  }

  // 5. Targets
  const targets = await db.collection("targets").find({ role: { $in: ["ASM", "RSM"] } }).toArray();
  console.log(`\n5. Targets (${targets.length} targets to update role):`);
  const asmTargets = targets.filter(t => t.role === "ASM");
  const rsmTargets = targets.filter(t => t.role === "RSM");
  console.log(`   - Targets with role 'ASM' -> will become 'RSM': ${asmTargets.length}`);
  console.log(`   - Targets with role 'RSM' -> will become 'ASM': ${rsmTargets.length}`);

  console.log("\n--------------------------------------------------");
  console.log("✅ DRY-RUN COMPLETED SUCCESSFULLY");
  console.log("--------------------------------------------------");

  await mongoose.disconnect();
}

dryRunMigration().catch(err => {
  console.error("Dry run failed:", err);
  process.exit(1);
});
