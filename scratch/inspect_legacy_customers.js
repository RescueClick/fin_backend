import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";

async function inspectLegacyCustomers() {
  await connectDB(process.env.MONGO_URI);

  const activeRms = await User.find({ role: "RM", deletedAt: null }).lean();
  console.log("Active RMs:", activeRms.map(r => ({ id: r._id, name: `${r.firstName} ${r.lastName}`, email: r.email })));

  const legacyCustomers = await User.find({
    role: { $in: ["CUSTOMER", "USER"] },
    deletedAt: null,
    rmId: null,
    partnerId: null
  }).lean();

  console.log(`\nFound ${legacyCustomers.length} legacy customers:`);

  for (const c of legacyCustomers) {
    const apps = await Application.find({
      $or: [{ customerId: c._id }, { userId: c._id }]
    }).lean();

    console.log(`• Customer: ${c.firstName} ${c.lastName} (${c.email}) [ID: ${c._id}]`);
    console.log(`  - Applications count: ${apps.length}`);
    if (apps.length > 0) {
      apps.forEach(a => console.log(`    - App #${a.appNo || a._id}: status=${a.status}, rmId=${a.rmId}, partnerId=${a.partnerId}`));
    }
  }

  await mongoose.disconnect();
}

inspectLegacyCustomers().catch(console.error);
