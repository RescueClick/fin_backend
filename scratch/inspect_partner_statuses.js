import mongoose from "mongoose";
import dotenv from "dotenv";
import { User } from "../src/models/User.js";

dotenv.config();

async function inspectPartnerStatuses() {
  await mongoose.connect(process.env.MONGO_URI);

  const allPartners = await User.find({ role: "PARTNER" }).lean();
  console.log(`Total Partners with role: PARTNER -> ${allPartners.length}`);

  const statusCount = {};
  const deletedAtCount = { hasDeletedAt: 0, noDeletedAt: 0 };
  const rmLinkCount = { hasRmId: 0, noRmId: 0, rmDetails: {} };

  for (const p of allPartners) {
    statusCount[p.status || "NO_STATUS"] = (statusCount[p.status || "NO_STATUS"] || 0) + 1;
    if (p.deletedAt) deletedAtCount.hasDeletedAt++;
    else deletedAtCount.noDeletedAt++;

    if (p.rmId) {
      rmLinkCount.hasRmId++;
      rmLinkCount.rmDetails[p.rmId] = (rmLinkCount.rmDetails[p.rmId] || 0) + 1;
    } else {
      rmLinkCount.noRmId++;
    }
  }

  console.log("Status breakdown:", statusCount);
  console.log("DeletedAt breakdown:", deletedAtCount);
  console.log("RM breakdown:", rmLinkCount);

  process.exit(0);
}

inspectPartnerStatuses();
