import dotenv from "dotenv";
dotenv.config();
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";
import { ROLES } from "../src/config/roles.js";
import { resolveSpecializedAsmForLoanType } from "../src/utils/rmRsmHierarchy.js";

async function run() {
  await connectDB(process.env.MONGO_URI);
  console.log("Connected to MongoDB for hierarchy data repair...");

  // 1. Repair RMs whose asmId is pointing to an RSM
  const rms = await User.find({ role: ROLES.RM }).populate("asmId rsmId personalAsmId businessAsmId homeLapAsmId");
  console.log(`Found ${rms.length} RMs. Checking asmId...`);

  for (const rm of rms) {
    if (rm.asmId && rm.asmId.role === ROLES.RSM) {
      console.log(`RM ${rm.employeeId} (${rm.firstName} ${rm.lastName}) has asmId pointing to RSM ${rm.asmId.employeeId}. Ensuring rsmId is set and clearing asmId...`);
      const updates = { asmId: null };
      if (!rm.rsmId) {
        updates.rsmId = rm.asmId._id;
      }
      await User.updateOne({ _id: rm._id }, { $set: updates });
    }
  }

  // 2. Repair Applications where asmId points to an RSM or was wrongly assigned
  const apps = await Application.find({ asmId: { $ne: null } })
    .populate("asmId", "role employeeId firstName lastName")
    .populate("rmId", "rsmId personalAsmId businessAsmId homeLapAsmId");

  console.log(`Scanning applications for misrouted asmId...`);
  let fixedAppsCount = 0;

  for (const app of apps) {
    if (app.asmId?.role === ROLES.RSM) {
      console.log(`App ${app.appNo} (${app.loanType}, status: ${app.status}) has RSM ${app.asmId.employeeId} as asmId. Resolving true ASM...`);
      const rsmId = app.asmId._id;
      let trueAsmId = null;

      if (app.rmId) {
        trueAsmId = resolveSpecializedAsmForLoanType(app.rmId, app.loanType);
      }

      await Application.updateOne(
        { _id: app._id },
        {
          $set: {
            asmId: trueAsmId || null,
            rsmId: rsmId,
            "customer.asmId": trueAsmId || null,
            "customer.rsmId": rsmId,
          },
        }
      );
      console.log(`  -> Fixed App ${app.appNo}: asmId = ${trueAsmId || 'null (unassigned)'}, rsmId = ${rsmId}`);
      fixedAppsCount++;
    }
  }

  console.log(`\nRepair completed successfully! Fixed ${fixedAppsCount} applications.`);
  process.exit(0);
}

run().catch((err) => {
  console.error("Repair error:", err);
  process.exit(1);
});
