import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";

async function auditHierarchy() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI");
  }

  await connectDB(process.env.MONGO_URI);
  console.log("--------------------------------------------------");
  console.log("🔍 FULL DATABASE HIERARCHY AUDIT");
  console.log("--------------------------------------------------");

  // 1. Fetch all users grouped by role
  const allUsers = await User.find({ deletedAt: null }).lean();
  const admins = allUsers.filter(u => u.role === "ADMIN" || u.role === "SUPERADMIN");
  const asms = allUsers.filter(u => u.role === "ASM");
  const rsms = allUsers.filter(u => u.role === "RSM");
  const rms = allUsers.filter(u => u.role === "RM");
  const partners = allUsers.filter(u => u.role === "PARTNER");
  const customers = allUsers.filter(u => u.role === "CUSTOMER" || u.role === "USER");

  const userMap = new Map(allUsers.map(u => [u._id.toString(), u]));

  console.log(`\n📊 User Counts:`);
  console.log(`• Admins: ${admins.length}`);
  console.log(`• ASMs: ${asms.length}`);
  console.log(`• RSMs: ${rsms.length}`);
  console.log(`• RMs: ${rms.length}`);
  console.log(`• Partners: ${partners.length}`);
  console.log(`• Customers: ${customers.length}`);

  console.log("\n--------------------------------------------------");
  console.log("1️⃣ AUDITING ASMs:");
  const asmsMissingAdmin = asms.filter(a => !a.adminId);
  console.log(`• Total ASMs: ${asms.length}`);
  if (asmsMissingAdmin.length > 0) {
    console.log(`⚠️ ASMs with null adminId: ${asmsMissingAdmin.length}`);
    asmsMissingAdmin.forEach(a => console.log(`   - ASM: ${a.firstName} ${a.lastName} (${a.email}) [ID: ${a._id}]`));
  } else {
    console.log(`✅ All ASMs have an adminId assigned.`);
  }

  console.log("\n--------------------------------------------------");
  console.log("2️⃣ AUDITING RSMs:");
  let rsmIssues = 0;
  for (const rsm of rsms) {
    const asm = rsm.asmId ? userMap.get(rsm.asmId.toString()) : null;
    const missingAsm = !rsm.asmId || !asm;
    const missingType = !rsm.rsmType;
    if (missingAsm || missingType) {
      rsmIssues++;
      console.log(`⚠️ RSM Issue: ${rsm.firstName} ${rsm.lastName} (${rsm.email}) [ID: ${rsm._id}]`);
      if (!rsm.asmId) console.log(`   - Missing asmId (null)`);
      else if (!asm) console.log(`   - Referenced ASM ${rsm.asmId} does not exist or is deleted`);
      if (missingType) console.log(`   - Missing rsmType (should be PERSONAL or BUSINESS_HOME)`);
      else console.log(`   - rsmType: ${rsm.rsmType}`);
    }
  }
  if (rsmIssues === 0) {
    console.log(`✅ All ${rsms.length} RSMs have valid asmId and rsmType.`);
  }

  console.log("\n--------------------------------------------------");
  console.log("3️⃣ AUDITING RMs (Dual RSM Connections):");
  let rmIssues = 0;
  for (const rm of rms) {
    const pRsm = rm.personalRsmId ? userMap.get(rm.personalRsmId.toString()) : null;
    const bhRsm = rm.businessHomeRsmId ? userMap.get(rm.businessHomeRsmId.toString()) : null;

    const hasPIssue = !rm.personalRsmId || !pRsm || pRsm.role !== "RSM";
    const hasBhIssue = !rm.businessHomeRsmId || !bhRsm || bhRsm.role !== "RSM";

    if (hasPIssue || hasBhIssue) {
      rmIssues++;
      console.log(`⚠️ RM Issue: ${rm.firstName} ${rm.lastName} (${rm.email}) [ID: ${rm._id}]`);
      if (!rm.personalRsmId) console.log(`   - Missing personalRsmId (null)`);
      else if (!pRsm) console.log(`   - personalRsmId ${rm.personalRsmId} does not exist`);
      else if (pRsm.rsmType !== "PERSONAL") console.log(`   - personalRsmId has rsmType='${pRsm.rsmType}' (expected PERSONAL)`);

      if (!rm.businessHomeRsmId) console.log(`   - Missing businessHomeRsmId (null)`);
      else if (!bhRsm) console.log(`   - businessHomeRsmId ${rm.businessHomeRsmId} does not exist`);
      else if (bhRsm.rsmType !== "BUSINESS_HOME") console.log(`   - businessHomeRsmId has rsmType='${bhRsm.rsmType}' (expected BUSINESS_HOME)`);
    }
  }
  if (rmIssues === 0) {
    console.log(`✅ All ${rms.length} RMs are properly linked to valid Personal & Business/Home RSMs.`);
  }

  console.log("\n--------------------------------------------------");
  console.log("4️⃣ AUDITING PARTNERS (RM Connection):");
  let partnerIssues = 0;
  const unlinkedPartners = [];
  for (const p of partners) {
    const rm = p.rmId ? userMap.get(p.rmId.toString()) : null;
    if (!p.rmId || !rm || rm.role !== "RM") {
      partnerIssues++;
      unlinkedPartners.push(p);
    }
  }
  if (partnerIssues > 0) {
    console.log(`⚠️ Partners without a valid RM: ${partnerIssues} / ${partners.length}`);
    unlinkedPartners.slice(0, 10).forEach(p => {
      console.log(`   - Partner: ${p.firstName} ${p.lastName} (${p.email}) [ID: ${p._id}] | rmId: ${p.rmId}`);
    });
    if (unlinkedPartners.length > 10) {
      console.log(`   ... and ${unlinkedPartners.length - 10} more.`);
    }
  } else {
    console.log(`✅ All ${partners.length} Partners are properly linked to active RMs.`);
  }

  console.log("\n--------------------------------------------------");
  console.log("5️⃣ AUDITING CUSTOMERS (Partner / RM Connection):");
  let customerIssues = 0;
  const unlinkedCustomers = [];
  for (const c of customers) {
    const rm = c.rmId ? userMap.get(c.rmId.toString()) : null;
    const partner = c.partnerId ? userMap.get(c.partnerId.toString()) : null;
    if (!rm && !partner) {
      customerIssues++;
      unlinkedCustomers.push(c);
    }
  }
  if (customerIssues > 0) {
    console.log(`⚠️ Customers with neither rmId nor partnerId: ${customerIssues} / ${customers.length}`);
    unlinkedCustomers.slice(0, 5).forEach(c => {
      console.log(`   - Customer: ${c.firstName} ${c.lastName} (${c.email}) [ID: ${c._id}]`);
    });
  } else {
    console.log(`✅ All ${customers.length} Customers are linked to either an RM or Partner.`);
  }

  console.log("\n--------------------------------------------------");
  console.log("6️⃣ AUDITING APPLICATIONS (Hierarchy & Routing Status):");
  const allApps = await Application.find({}).lean();
  console.log(`• Total Applications in DB: ${allApps.length}`);

  let appRmMissing = 0;
  let preDocCompleteRsmSet = 0;
  let postDocCompleteRsmMissing = 0;

  const PRE_RSM = ["DRAFT", "SUBMITTED", "DOC_INCOMPLETE", "DOC_SUBMITTED", "KYC_PENDING", "KYC_COMPLETE"];
  const POST_RSM = ["DOC_COMPLETE", "LOGIN", "UNDER_REVIEW", "APPROVED", "AGREEMENT", "DISBURSED", "REJECTED"];

  for (const app of allApps) {
    if (!app.rmId) {
      appRmMissing++;
    }
    if (PRE_RSM.includes(app.status) && app.rsmId) {
      preDocCompleteRsmSet++;
    }
    if (POST_RSM.includes(app.status) && !app.rsmId) {
      postDocCompleteRsmMissing++;
    }
  }

  console.log(`• Applications missing rmId: ${appRmMissing}`);
  console.log(`• Pre-DOC_COMPLETE applications with premature rsmId: ${preDocCompleteRsmSet}`);
  console.log(`• Post-DOC_COMPLETE applications missing rsmId: ${postDocCompleteRsmMissing}`);

  console.log("\n==================================================");
  console.log("🏁 AUDIT COMPLETE");
  console.log("==================================================");

  await mongoose.disconnect();
}

auditHierarchy().catch(err => {
  console.error("Audit error:", err);
  process.exit(1);
});
