import "dotenv/config.js";
import mongoose from "mongoose";
import { connectDB } from "../db/db.js";
import { Application } from "../models/Application.js";
import { User } from "../models/User.js";

const PRE_RSM_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "DOC_INCOMPLETE",
  "DOC_SUBMITTED",
  "KYC_PENDING",
  "KYC_COMPLETE",
];

const RSM_ALLOWED_STATUSES = [
  "DOC_COMPLETE",
  "LOGIN",
  "UNDER_REVIEW",
  "APPROVED",
  "AGREEMENT",
  "DISBURSED",
  "REJECTED",
];

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing required env: MONGO_URI");
  }

  await connectDB(process.env.MONGO_URI);

  // 1. Clear rsmId & asmId for all applications in pre-RSM statuses (partner submitted / docs not completed by RM)
  const cleared = await Application.updateMany(
    {
      status: { $in: PRE_RSM_STATUSES },
      $or: [{ rsmId: { $ne: null } }, { asmId: { $ne: null } }],
    },
    {
      $set: { rsmId: null, asmId: null },
    }
  );

  console.log(`✅ Cleared rsmId/asmId from ${cleared.modifiedCount} pre-DOC_COMPLETE applications`);

  // 2. Ensure DOC_COMPLETE and later applications have correct rsmId and asmId based on RM
  const docCompleteApps = await Application.find({
    status: { $in: RSM_ALLOWED_STATUSES },
    rmId: { $ne: null },
  }).populate("rmId", "personalRsmId businessHomeRsmId");

  let fixedCount = 0;
  for (const app of docCompleteApps) {
    const rm = app.rmId;
    if (!rm) continue;

    let targetRsmId = null;
    if (app.loanType === "PERSONAL") {
      targetRsmId = rm.personalRsmId;
    } else {
      targetRsmId = rm.businessHomeRsmId;
    }

    if (targetRsmId) {
      const rsmUser = await User.findById(targetRsmId).select("asmId").lean();
      const targetAsmId = rsmUser?.asmId || null;

      const needsUpdate =
        !app.rsmId ||
        app.rsmId.toString() !== targetRsmId.toString() ||
        (targetAsmId && (!app.asmId || app.asmId.toString() !== targetAsmId.toString()));

      if (needsUpdate) {
        await Application.updateOne(
          { _id: app._id },
          { $set: { rsmId: targetRsmId, asmId: targetAsmId } }
        );
        fixedCount++;
      }
    }
  }

  console.log(`✅ Verified/Updated ${fixedCount} DOC_COMPLETE+ applications to correct RSM/ASM`);

  await mongoose.disconnect();
  console.log("Done!");
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
