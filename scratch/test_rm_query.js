import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import { Application } from "../src/models/Application.js";
import { User } from "../src/models/User.js";
import { activeApplicationsFilter } from "../src/utils/activeApplicationsFilter.js";

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    // Find Dnyaneshwari Parate
    const rm = await User.findOne({ employeeId: "TLR0005" });
    console.log(`RM ID: ${rm._id}`);

    const rmId = rm._id;
    const partners = await User.find({ 
      rmId: rmId, 
      role: "PARTNER",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
    }).select("_id").lean();
    
    const partnerIds = partners.map(p => p._id);
    console.log(`RM has ${partnerIds.length} partners.`);
    
    const rmScopeFilter = {
      $or: [
        { partnerId: { $in: partnerIds } },
        { partnerId: null, rmId: rmId },
        { partnerId: { $exists: false }, rmId: rmId }
      ]
    };

    console.log("Scope filter:", JSON.stringify(rmScopeFilter, null, 2));

    const query = activeApplicationsFilter(rmScopeFilter);
    console.log("Active applications filter:", JSON.stringify(query, null, 2));

    const applications = await Application.find(query).lean();
    console.log(`RM sees ${applications.length} applications in table.`);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
