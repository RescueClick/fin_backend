import "dotenv/config.js";
import mongoose from "mongoose";
import { connectDB } from "../db/db.js";
import { Application } from "../models/Application.js";

const ACTIVE_APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "DOC_INCOMPLETE",
  "DOC_COMPLETE",
  "DOC_SUBMITTED",
  "LOGIN",
  "UNDER_REVIEW",
  "APPROVED",
  "AGREEMENT",
];

const isApplyMode = process.argv.includes("--apply");

function appLabel(app) {
  return `${app._id} (appNo=${app.appNo || "N/A"}, status=${app.status}, createdAt=${app.createdAt?.toISOString?.() || app.createdAt})`;
}

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing required env: MONGO_URI");
  }

  await connectDB(process.env.MONGO_URI);

  const groups = await Application.aggregate([
    {
      $match: {
        deletedAt: null,
        status: { $in: ACTIVE_APPLICATION_STATUSES },
      },
    },
    {
      $group: {
        _id: {
          partnerId: "$partnerId",
          customerId: "$customerId",
          loanType: "$loanType",
        },
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);

  if (!groups.length) {
    console.log("No duplicate active application groups found.");
    return;
  }

  console.log(
    `${isApplyMode ? "APPLY" : "DRY-RUN"}: Found ${groups.length} duplicate group(s).`
  );

  let totalToSoftDelete = 0;
  let softDeleted = 0;

  for (const group of groups) {
    const key = group._id;
    const apps = await Application.find({ _id: { $in: group.ids } })
      .sort({ createdAt: -1, _id: -1 })
      .select("_id appNo status createdAt")
      .lean();

    if (apps.length < 2) continue;

    const keeper = apps[0];
    const duplicates = apps.slice(1);
    totalToSoftDelete += duplicates.length;

    console.log(
      `\nGroup partner=${key.partnerId} customer=${key.customerId} loanType=${key.loanType}`
    );
    console.log(`  Keep: ${appLabel(keeper)}`);
    duplicates.forEach((d) => console.log(`  Delete: ${appLabel(d)}`));

    if (isApplyMode) {
      const idsToDelete = duplicates.map((d) => d._id);
      const result = await Application.updateMany(
        { _id: { $in: idsToDelete }, deletedAt: null },
        { $set: { deletedAt: new Date() } }
      );
      softDeleted += result.modifiedCount || 0;
    }
  }

  console.log("\nCleanup summary:");
  console.log(`- Duplicate groups: ${groups.length}`);
  console.log(`- Candidate rows to soft delete: ${totalToSoftDelete}`);
  if (isApplyMode) {
    console.log(`- Soft deleted rows: ${softDeleted}`);
  } else {
    console.log("- No DB writes done (dry-run mode).");
  }
}

run()
  .catch((err) => {
    console.error("cleanupDuplicateApplications failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.connection.close();
    } catch {
      // ignore close errors
    }
  });

