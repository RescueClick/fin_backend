import mongoose from "mongoose";
import dotenv from "dotenv";
import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";

dotenv.config();

async function auditPartnersAndApps() {
  await mongoose.connect(process.env.MONGO_URI);

  const partners = await User.find({ role: "PARTNER" }).lean();
  console.log(`Total Partners: ${partners.length}`);

  const partnerByRm = {};
  let withoutRm = 0;

  for (const p of partners) {
    if (!p.rmId) {
      withoutRm++;
    } else {
      partnerByRm[p.rmId] = (partnerByRm[p.rmId] || 0) + 1;
    }
  }

  console.log(`Partners without RM: ${withoutRm}`);
  console.log("Partners by RM:", partnerByRm);

  // Applications
  const apps = await Application.find({}).lean();
  console.log(`Total Applications: ${apps.length}`);
  const appByRm = {};
  const appByRsm = {};
  const appByAsm = {};
  let appWithoutRm = 0;
  let appWithoutRsm = 0;
  let appWithoutAsm = 0;

  for (const a of apps) {
    if (!a.rmId) appWithoutRm++;
    else appByRm[a.rmId] = (appByRm[a.rmId] || 0) + 1;

    if (!a.rsmId) appWithoutRsm++;
    else appByRsm[a.rsmId] = (appByRsm[a.rsmId] || 0) + 1;

    if (!a.asmId) appWithoutAsm++;
    else appByAsm[a.asmId] = (appByAsm[a.asmId] || 0) + 1;
  }

  console.log("Applications without RM:", appWithoutRm);
  console.log("Applications by RM:", appByRm);
  console.log("Applications by RSM:", appByRsm);
  console.log("Applications by ASM:", appByAsm);

  process.exit(0);
}

auditPartnersAndApps();
