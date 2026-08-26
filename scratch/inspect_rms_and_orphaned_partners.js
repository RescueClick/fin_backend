import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";

async function inspectRMAndPartners() {
  await connectDB(process.env.MONGO_URI);

  const activeRms = await User.find({ role: "RM", deletedAt: null }).lean();
  console.log("Active RMs in DB:");
  activeRms.forEach(rm => console.log(`• RM: ${rm.firstName} ${rm.lastName} (${rm.email}) [ID: ${rm._id}]`));

  const deletedRM = await User.findById("6a439c6d815f90506104cb6e").lean();
  console.log("\nLookup of 6a439c6d815f90506104cb6e:", deletedRM ? `${deletedRM.firstName} ${deletedRM.lastName} (deletedAt: ${deletedRM.deletedAt})` : "NOT FOUND IN DB");

  const unlinkedCount = await User.countDocuments({
    role: "PARTNER",
    deletedAt: null,
    $or: [{ rmId: "6a439c6d815f90506104cb6e" }, { rmId: null }, { rmId: { $exists: false } }]
  });
  console.log(`\nPartners pointing to missing/deleted RM or null: ${unlinkedCount}`);

  await mongoose.disconnect();
}

inspectRMAndPartners().catch(console.error);
