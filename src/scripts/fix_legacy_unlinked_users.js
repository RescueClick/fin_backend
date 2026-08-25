import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../db/db.js";
import { User } from "../models/User.js";
import { ROLES } from "../config/roles.js";

async function fixUnlinkedUsers() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI");
  }

  await connectDB(process.env.MONGO_URI);
  console.log("--------------------------------------------------");
  console.log("🛠️ FIXING UNLINKED LEGACY CUSTOMERS & PARTNERS");
  console.log("--------------------------------------------------");

  // 1. Get active RMs
  const activeRms = await User.find({ role: ROLES.RM, status: "ACTIVE", deletedAt: null }).lean();
  if (activeRms.length === 0) {
    throw new Error("No active RMs found in database!");
  }
  console.log(`Found ${activeRms.length} active RMs:`);
  activeRms.forEach((rm, i) => console.log(`  [${i + 1}] ${rm.firstName} ${rm.lastName} (${rm.email}) [ID: ${rm._id}]`));

  const defaultRm = activeRms[0]; // Prem Jadhav

  // 2. Find default company partner (or create/find first active partner under default RM)
  let defaultPartner = await User.findOne({
    role: ROLES.PARTNER,
    status: "ACTIVE",
    rmId: defaultRm._id,
    deletedAt: null,
  }).lean();

  if (!defaultPartner) {
    defaultPartner = await User.findOne({
      role: ROLES.PARTNER,
      status: "ACTIVE",
      deletedAt: null,
    }).lean();
  }

  console.log(`\nDefault Partner for unlinked customers: ${defaultPartner?.firstName} ${defaultPartner?.lastName} [ID: ${defaultPartner?._id}]`);

  // 3. Fix 6 legacy customers (rmId: null, partnerId: null)
  const unlinkedCustomers = await User.find({
    role: { $in: [ROLES.CUSTOMER, "USER"] },
    deletedAt: null,
    rmId: null,
    partnerId: null,
  });

  console.log(`\nFound ${unlinkedCustomers.length} unlinked legacy customers.`);
  let fixedCustomers = 0;
  for (const cust of unlinkedCustomers) {
    cust.rmId = defaultRm._id;
    if (defaultPartner) {
      cust.partnerId = defaultPartner._id;
    }
    await cust.save();
    console.log(`  ✅ Fixed Customer: ${cust.firstName} ${cust.lastName} (${cust.email}) ➔ Assigned rmId: ${defaultRm._id}`);
    fixedCustomers++;
  }

  // 4. Fix 21 legacy partners pointing to Super Admin (6a439c6d815f90506104cb6e) or null
  const superAdminId = "6a439c6d815f90506104cb6e";
  const unlinkedPartners = await User.find({
    role: ROLES.PARTNER,
    deletedAt: null,
    $or: [
      { rmId: superAdminId },
      { rmId: null },
      { rmId: { $exists: false } },
    ],
  });

  console.log(`\nFound ${unlinkedPartners.length} unlinked legacy partners.`);
  let fixedPartners = 0;
  for (let i = 0; i < unlinkedPartners.length; i++) {
    const partner = unlinkedPartners[i];
    // Distribute evenly between available active RMs
    const assignedRm = activeRms[i % activeRms.length];
    partner.rmId = assignedRm._id;
    await partner.save();
    console.log(`  ✅ Fixed Partner: ${partner.firstName} ${partner.lastName} (${partner.email}) ➔ Assigned to RM: ${assignedRm.firstName} ${assignedRm.lastName}`);
    fixedPartners++;
  }

  console.log("\n==================================================");
  console.log(`🎉 SYNC COMPLETE!`);
  console.log(`• Customers Fixed: ${fixedCustomers}`);
  console.log(`• Partners Fixed: ${fixedPartners}`);
  console.log("==================================================");

  await mongoose.disconnect();
}

fixUnlinkedUsers().catch(err => {
  console.error("Migration error:", err);
  process.exit(1);
});
