import mongoose from "mongoose";
import dotenv from "dotenv";
import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";

dotenv.config();

async function syncAndAlignHierarchy() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to DB.");

  const anilAsmId = new mongoose.Types.ObjectId("6a65e75844d77ea296313ecf");
  const kanchanPersonalRsmId = new mongoose.Types.ObjectId("6a65e93e44d77ea296314020");
  const rahitBizRsmId = new mongoose.Types.ObjectId("6a65ed3d44d77ea296314292");

  const sunilAsmId = new mongoose.Types.ObjectId("69cd478a5fa30bba81e88a34");
  const sandipPersonalRsmId = new mongoose.Types.ObjectId("6a85627d501a73fa4d1180ec");
  const rohitBizRsmId = new mongoose.Types.ObjectId("69c76d814eb446a1a134154a");

  // 1. Align Anil Bagad's RMs
  const anilRms = ["6a65edd144d77ea2963142e3", "6a7ebfde0c8a252435991f26", "6a7abfa06a57bc1a5b4610e5"];
  for (const rmId of anilRms) {
    const res = await User.updateOne(
      { _id: rmId },
      {
        $set: {
          asmId: anilAsmId,
          personalRsmId: kanchanPersonalRsmId,
          businessHomeRsmId: rahitBizRsmId,
        }
      }
    );
    console.log(`Updated Anil RM ${rmId}:`, res);
  }

  // 2. Align Sunil Bagad's RMs
  const sunilRms = ["6a745681e32b31333093ad31"];
  for (const rmId of sunilRms) {
    const res = await User.updateOne(
      { _id: rmId },
      {
        $set: {
          asmId: sunilAsmId,
          personalRsmId: sandipPersonalRsmId,
          businessHomeRsmId: rohitBizRsmId,
        }
      }
    );
    console.log(`Updated Sunil RM ${rmId}:`, res);
  }

  // 3. Align 6 orphaned partners to Akash Gavle / Anil Bagad RM
  const defaultRm = await User.findById("6a65edd144d77ea2963142e3");
  const orphanedRes = await User.updateMany(
    { rmId: "6a439c6d815f90506104cb6e" },
    { $set: { rmId: defaultRm._id } }
  );
  console.log("Reassigned orphaned partners to Akash Gavle:", orphanedRes);

  // 4. Update all applications to have strictly accurate rsmId and asmId based on loan type
  const apps = await Application.find({}).lean();
  let appUpdated = 0;
  for (const app of apps) {
    if (!app.rmId) continue;
    const rm = await User.findById(app.rmId).lean();
    if (!rm) continue;

    let targetRsmId = null;
    let targetAsmId = rm.asmId || null;

    if (app.loanType === "PERSONAL") {
      targetRsmId = rm.personalRsmId || null;
    } else {
      targetRsmId = rm.businessHomeRsmId || null;
    }

    if (targetRsmId) {
      const rsmDoc = await User.findById(targetRsmId).lean();
      if (rsmDoc?.asmId) targetAsmId = rsmDoc.asmId;
    }

    if (String(app.rsmId) !== String(targetRsmId) || String(app.asmId) !== String(targetAsmId)) {
      await Application.updateOne(
        { _id: app._id },
        { $set: { rsmId: targetRsmId, asmId: targetAsmId } }
      );
      appUpdated++;
    }
  }

  console.log(`Updated ${appUpdated} application file pointers.`);
  process.exit(0);
}

syncAndAlignHierarchy().catch(e => { console.error(e); process.exit(1); });
