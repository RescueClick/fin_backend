/**
 * Move partners parked on SUPER_ADMIN/ADMIN (placeholder RM) into Admin assign queue.
 * Sets status=PENDING so they only show in Admin Partner / Assign RM — not ASM/RSM lists.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { ROLES } from "../src/config/roles.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  await connectDB(process.env.MONGO_URI);

  const placeholders = await User.find({
    role: { $in: [ROLES.SUPER_ADMIN, ROLES.ADMIN] },
  })
    .select("_id role firstName lastName")
    .lean();
  const placeholderIds = placeholders.map((u) => u._id);

  const filter = {
    role: ROLES.PARTNER,
    rmId: { $in: placeholderIds },
    status: { $ne: "PENDING" },
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };

  const partners = await User.find(filter)
    .select("_id firstName lastName employeeId status rmId")
    .lean();

  console.log(
    JSON.stringify(
      {
        dryRun: DRY_RUN,
        found: partners.length,
        sample: partners.slice(0, 20).map((p) => ({
          name: `${p.firstName} ${p.lastName}`,
          employeeId: p.employeeId,
          status: p.status,
        })),
      },
      null,
      2
    )
  );

  if (!DRY_RUN && partners.length) {
    const result = await User.updateMany(filter, {
      $set: { status: "PENDING", updatedAt: new Date() },
      $unset: { asmId: "", rsmId: "" },
    });
    console.log(
      JSON.stringify(
        {
          modified: result.modifiedCount,
          matched: result.matchedCount,
          message:
            "Partners moved to Admin assign-RM queue (status=PENDING).",
        },
        null,
        2
      )
    );
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
