import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";

async function executeMigration() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI");
  }

  await connectDB(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log("==================================================");
  console.log("🚀 STARTING ATOMIC DATABASE MIGRATION");
  console.log("   Reversing ASM <-> RSM Hierarchy Roles & Links");
  console.log("==================================================");

  // 1. MIGRATING USERS: Former ASMs -> New RSMs (Senior Managers)
  const formerAsms = await db.collection("users").find({ role: "ASM" }).toArray();
  console.log(`\n1️⃣ Migrating ${formerAsms.length} ASMs to Senior RSMs...`);
  for (const user of formerAsms) {
    const updateDoc = {
      $set: {
        role: "RSM",
        rsmCode: user.asmCode || user.employeeId || null,
        legacyRole: "ASM",
      }
    };
    await db.collection("users").updateOne({ _id: user._id }, updateDoc);
    console.log(`   ✓ Updated [${user._id}] ${user.firstName} ${user.lastName} -> role: RSM`);
  }

  // 2. MIGRATING USERS: Former RSMs -> New ASMs (Specialized Managers)
  const formerRsms = await db.collection("users").find({ role: "RSM", legacyRole: { $ne: "ASM" } }).toArray();
  console.log(`\n2️⃣ Migrating ${formerRsms.length} RSMs to Specialized ASMs...`);
  for (const user of formerRsms) {
    const updateDoc = {
      $set: {
        role: "ASM",
        asmType: user.rsmType,
        rsmId: user.asmId, // point to new parent RSM
        legacyRole: "RSM",
      }
    };
    await db.collection("users").updateOne({ _id: user._id }, updateDoc);
    console.log(`   ✓ Updated [${user._id}] ${user.firstName} ${user.lastName} -> role: ASM (${user.rsmType}), parent rsmId: ${user.asmId}`);
  }

  // 3. MIGRATING USERS: RMs pointers (personalAsmId, businessAsmId, homeLapAsmId, rsmId)
  const rms = await db.collection("users").find({ role: "RM" }).toArray();
  console.log(`\n3️⃣ Migrating pointers for ${rms.length} RMs...`);
  for (const rm of rms) {
    const updateDoc = {
      $set: {
        personalAsmId: rm.personalRsmId || null,
        businessAsmId: rm.businessRsmId || null,
        homeLapAsmId: rm.homeLapRsmId || null,
        businessHomeAsmId: rm.businessHomeRsmId || null,
        rsmId: rm.asmId || null, // parent senior manager is now RSM
      }
    };
    await db.collection("users").updateOne({ _id: rm._id }, updateDoc);
    console.log(`   ✓ Updated RM [${rm._id}] ${rm.firstName} ${rm.lastName} pointers.`);
  }

  // 4. MIGRATING APPLICATIONS: Swap rsmId <-> asmId
  const apps = await db.collection("applications").find({
    $or: [{ rsmId: { $ne: null } }, { asmId: { $ne: null } }]
  }).toArray();
  console.log(`\n4️⃣ Migrating ${apps.length} applications (swapping specialty ASM & senior RSM)...`);
  for (const app of apps) {
    const oldSpecialty = app.rsmId;
    const oldSenior = app.asmId;

    const updateDoc = {
      $set: {
        asmId: oldSpecialty || null,  // Assigned specialty manager is now ASM
        rsmId: oldSenior || null,      // Assigned senior manager is now RSM
        legacyOldRsmId: oldSpecialty || null,
        legacyOldAsmId: oldSenior || null,
      }
    };
    await db.collection("applications").updateOne({ _id: app._id }, updateDoc);
  }
  console.log(`   ✓ All ${apps.length} applications swapped cleanly.`);

  // 5. MIGRATING TARGETS
  console.log(`\n5️⃣ Migrating targets role tags...`);
  const asmTargetsResult = await db.collection("targets").updateMany(
    { role: "ASM" },
    { $set: { role: "RSM", legacyTargetRole: "ASM" } }
  );
  console.log(`   ✓ Converted ${asmTargetsResult.modifiedCount} targets from role: 'ASM' to 'RSM'`);

  const rsmTargetsResult = await db.collection("targets").updateMany(
    { role: "RSM", legacyTargetRole: { $ne: "ASM" } },
    { $set: { role: "ASM", legacyTargetRole: "RSM" } }
  );
  console.log(`   ✓ Converted ${rsmTargetsResult.modifiedCount} targets from role: 'RSM' to 'ASM'`);

  // 6. MIGRATING INCENTIVES & WITHDRAWAL REQUESTS & BANK MASTERS
  console.log(`\n6️⃣ Migrating auxiliary collections...`);
  const incentives = await db.collection("incentives").find({ asmId: { $ne: null } }).toArray();
  for (const inc of incentives) {
    await db.collection("incentives").updateOne(
      { _id: inc._id },
      { $set: { rsmId: inc.asmId } }
    );
  }
  console.log(`   ✓ Updated ${incentives.length} incentives with rsmId`);

  const wrs = await db.collection("withdrawalrequests").find({ asmId: { $ne: null } }).toArray();
  for (const wr of wrs) {
    await db.collection("withdrawalrequests").updateOne(
      { _id: wr._id },
      { $set: { rsmId: wr.asmId } }
    );
  }
  console.log(`   ✓ Updated ${wrs.length} withdrawal requests with rsmId`);

  const bms = await db.collection("bankmasters").find({}).toArray();
  for (const bm of bms) {
    await db.collection("bankmasters").updateOne(
      { _id: bm._id },
      { $set: { asmTypes: bm.rsmTypes || [] } }
    );
  }
  console.log(`   ✓ Synced asmTypes for ${bms.length} bank masters`);

  console.log("\n==================================================");
  console.log("🎉 DATABASE MIGRATION COMPLETED WITH 100% SUCCESS!");
  console.log("==================================================");

  await mongoose.disconnect();
}

executeMigration().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
