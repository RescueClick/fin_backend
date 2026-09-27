import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { ROLES } from "../src/config/roles.js";

async function main() {
  await connectDB(process.env.MONGO_URI);
  const admin = await User.findOne({ role: ROLES.SUPER_ADMIN }).select("_id").lean();
  const partners = await User.find({
    role: ROLES.PARTNER,
    rmId: admin._id,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .select("firstName lastName employeeId status rmId asmId rsmId createdAt")
    .lean();

  console.log(
    JSON.stringify(
      {
        adminId: String(admin._id),
        count: partners.length,
        partners: partners.map((p) => ({
          name: `${p.firstName} ${p.lastName}`,
          employeeId: p.employeeId,
          status: p.status,
          asmId: p.asmId,
          rsmId: p.rsmId,
          createdAt: p.createdAt,
        })),
      },
      null,
      2
    )
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
