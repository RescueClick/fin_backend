import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const UserSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model("User", UserSchema);
const ApplicationSchema = new mongoose.Schema({}, { strict: false });
const Application = mongoose.model("Application", ApplicationSchema);

async function repair() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.");

  // 1. Get all active RSMs by type and ASM
  const activeRsms = await User.find({ role: "RSM", status: "ACTIVE" }).lean();
  console.log(`Found ${activeRsms.length} active RSMs:`);
  for (const r of activeRsms) {
    console.log(`  RSM ${r._id} | ${r.firstName} ${r.lastName} (${r.employeeId}) | Type: ${r.rsmType} | ASM: ${r.asmId}`);
  }

  // 2. Scan and repair all RMs whose personalRsmId or businessHomeRsmId is missing/suspended/deleted
  const allRms = await User.find({ role: "RM" }).lean();
  console.log(`\nChecking ${allRms.length} RMs for valid RSM links...`);

  for (const rm of allRms) {
    let needsUpdate = false;
    const updateFields = {};

    // Check personalRsmId
    let pRsm = rm.personalRsmId ? await User.findById(rm.personalRsmId).lean() : null;
    if (!pRsm || pRsm.status === "SUSPENDED" || pRsm.deletedAt) {
      // Find active personal RSM under RM's ASM
      let repPersonal = activeRsms.find(r => r.rsmType === "PERSONAL" && String(r.asmId) === String(rm.asmId));
      if (!repPersonal) {
        repPersonal = activeRsms.find(r => r.rsmType === "PERSONAL");
      }
      if (repPersonal) {
        console.log(`  RM ${rm.firstName} ${rm.lastName} (${rm.employeeId}) had invalid personalRsmId (${rm.personalRsmId}) -> updating to ${repPersonal.firstName} ${repPersonal.lastName} (${repPersonal._id})`);
        updateFields.personalRsmId = repPersonal._id;
        needsUpdate = true;
      }
    }

    // Check businessHomeRsmId
    let bRsm = rm.businessHomeRsmId ? await User.findById(rm.businessHomeRsmId).lean() : null;
    if (!bRsm || bRsm.status === "SUSPENDED" || bRsm.deletedAt) {
      // Find active business/home RSM under RM's ASM
      let repBiz = activeRsms.find(r => r.rsmType === "BUSINESS_HOME" && String(r.asmId) === String(rm.asmId));
      if (!repBiz) {
        repBiz = activeRsms.find(r => r.rsmType === "BUSINESS_HOME");
      }
      if (repBiz) {
        console.log(`  RM ${rm.firstName} ${rm.lastName} (${rm.employeeId}) had invalid businessHomeRsmId (${rm.businessHomeRsmId}) -> updating to ${repBiz.firstName} ${repBiz.lastName} (${repBiz._id})`);
        updateFields.businessHomeRsmId = repBiz._id;
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      await User.updateOne({ _id: rm._id }, { $set: updateFields });
      console.log(`  ✅ Updated RM ${rm._id}`);
    }
  }

  // 3. Scan and repair all Applications
  const applications = await Application.find({}).lean();
  console.log(`\nChecking ${applications.length} Applications for missing or stale rsmId / asmId...`);

  let repairedCount = 0;
  for (const app of applications) {
    let targetRsmId = null;
    let targetAsmId = app.asmId || null;
    let needsAppUpdate = false;

    // Resolve RM
    let rm = app.rmId ? await User.findById(app.rmId).lean() : null;
    if (!rm && app.partnerId) {
      const partner = await User.findById(app.partnerId).lean();
      if (partner?.rmId) {
        rm = await User.findById(partner.rmId).lean();
        if (rm) {
          app.rmId = rm._id;
          needsAppUpdate = true;
        }
      }
    }

    if (rm) {
      if (app.loanType === "PERSONAL") {
        targetRsmId = rm.personalRsmId || null;
      } else {
        targetRsmId = rm.businessHomeRsmId || null;
      }

      if (targetRsmId) {
        const rsmDoc = await User.findById(targetRsmId).lean();
        if (rsmDoc && rsmDoc.status !== "SUSPENDED" && !rsmDoc.deletedAt) {
          if (rsmDoc.asmId) targetAsmId = rsmDoc.asmId;
        } else {
          // If the mapped RSM is inactive, find active replacement
          const rType = app.loanType === "PERSONAL" ? "PERSONAL" : "BUSINESS_HOME";
          const fallbackRsm = activeRsms.find(r => r.rsmType === rType && String(r.asmId) === String(rm.asmId)) ||
                              activeRsms.find(r => r.rsmType === rType);
          if (fallbackRsm) {
            targetRsmId = fallbackRsm._id;
            targetAsmId = fallbackRsm.asmId || null;
          }
        }
      }

      if (!targetAsmId && rm.asmId) {
        targetAsmId = rm.asmId;
      }
    }

    const currentRsmStr = app.rsmId ? String(app.rsmId) : null;
    const targetRsmStr = targetRsmId ? String(targetRsmId) : null;
    const currentAsmStr = app.asmId ? String(app.asmId) : null;
    const targetAsmStr = targetAsmId ? String(targetAsmId) : null;

    // Check if current rsmId is inactive
    let currentRsmIsInvalid = false;
    if (app.rsmId) {
      const curRsmDoc = await User.findById(app.rsmId).lean();
      if (!curRsmDoc || curRsmDoc.status === "SUSPENDED" || curRsmDoc.deletedAt) {
        currentRsmIsInvalid = true;
      }
    } else {
      currentRsmIsInvalid = true;
    }

    if (currentRsmIsInvalid || currentRsmStr !== targetRsmStr || currentAsmStr !== targetAsmStr || needsAppUpdate) {
      const setFields = {};
      if (targetRsmId) setFields.rsmId = targetRsmId;
      if (targetAsmId) setFields.asmId = targetAsmId;
      if (needsAppUpdate && app.rmId) setFields.rmId = app.rmId;

      if (Object.keys(setFields).length) {
        await Application.updateOne({ _id: app._id }, { $set: setFields });
        console.log(`  🔧 Fixed App ${app.appNo || app._id} (Loan: ${app.loanType}, Status: ${app.status}) -> rsmId: ${setFields.rsmId}, asmId: ${setFields.asmId}`);
        repairedCount++;
      }
    }
  }

  console.log(`\n🎉 Repair complete! Fixed ${repairedCount} applications.`);
  process.exit(0);
}

repair().catch(err => {
  console.error("Repair failed:", err);
  process.exit(1);
});
