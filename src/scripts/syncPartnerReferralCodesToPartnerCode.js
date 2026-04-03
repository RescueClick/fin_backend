/**
 * One-time (or repeatable) fix: set each partner's referralCode = partnerCode (PT-…).
 * Before the User model hook change, partners often had DS… auto referral codes.
 *
 * Usage (from fin_backend):
 *   node src/scripts/syncPartnerReferralCodesToPartnerCode.js           # dry-run
 *   node src/scripts/syncPartnerReferralCodesToPartnerCode.js --apply   # write DB
 */
import "dotenv/config.js";
import mongoose from "mongoose";
import { connectDB } from "../db/db.js";
import { User } from "../models/User.js";
import { ROLES } from "../config/roles.js";

const apply = process.argv.includes("--apply");

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing required env: MONGO_URI");
  }
  await connectDB(process.env.MONGO_URI);

  const partners = await User.find({
    role: ROLES.PARTNER,
    partnerCode: { $exists: true, $nin: [null, ""] },
  })
    .select("_id partnerCode referralCode email firstName lastName")
    .lean();

  const toFix = partners.filter((p) => {
    const pc = String(p.partnerCode || "").trim();
    const rc = String(p.referralCode || "").trim();
    return pc && rc.toUpperCase() !== pc.toUpperCase();
  });

  console.log(
    apply ? `Applying updates for ${toFix.length} partner(s)…` : `Dry-run: ${toFix.length} partner(s) would be updated (use --apply to write).`
  );

  for (const p of toFix) {
    const pc = String(p.partnerCode).trim();
    console.log(
      `  ${p._id}  ${p.email || ""}  referralCode: ${p.referralCode || "(empty)"}  →  ${pc}`
    );
    if (apply) {
      await User.updateOne({ _id: p._id }, { $set: { referralCode: pc } });
    }
  }

  if (!apply && toFix.length > 0) {
    console.log("\nRe-run with --apply to persist.");
  }

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
