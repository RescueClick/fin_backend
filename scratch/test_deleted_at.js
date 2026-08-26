import mongoose from "mongoose";
import dotenv from "dotenv";
import { Application } from "../src/models/Application.js";
import { activeApplicationsFilter } from "../src/utils/activeApplicationsFilter.js";

dotenv.config();

async function testDeletedAt() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const allApps = await Application.find({}).lean();
  console.log(`Total apps in DB: ${allApps.length}`);

  let hasDeletedAtNull = 0;
  let hasDeletedAtValue = 0;
  let hasNoDeletedAtKey = 0;

  for (const a of allApps) {
    if (a.deletedAt === null) hasDeletedAtNull++;
    else if (a.deletedAt !== undefined) hasDeletedAtValue++;
    else hasNoDeletedAtKey++;
  }

  console.log(`deletedAt === null: ${hasDeletedAtNull}`);
  console.log(`deletedAt has Date value (soft-deleted): ${hasDeletedAtValue}`);
  console.log(`deletedAt field does not exist on doc: ${hasNoDeletedAtKey}`);

  // Test queries
  const q1 = await Application.countDocuments({ deletedAt: null });
  const q2 = await Application.countDocuments({ $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] });
  const q3 = await Application.countDocuments(activeApplicationsFilter({}));

  console.log(`Query { deletedAt: null }: ${q1}`);
  console.log(`Query { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] }: ${q2}`);
  console.log(`Query activeApplicationsFilter: ${q3}`);

  process.exit(0);
}

testDeletedAt();
