import "dotenv/config";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connectDB } from "../src/db/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function backupDatabase() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI in .env");
  }

  await connectDB(process.env.MONGO_URI);
  console.log("Connected to MongoDB for backup...");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(__dirname, "../backups", `backup_${timestamp}`);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();

  console.log(`Found ${collections.length} collections. Starting backup to ${backupDir}...`);

  const summary = {};

  for (const col of collections) {
    const colName = col.name;
    // Skip system collections if any
    if (colName.startsWith("system.")) continue;

    const data = await db.collection(colName).find({}).toArray();
    summary[colName] = data.length;
    const filePath = path.join(backupDir, `${colName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    console.log(`✓ Backed up '${colName}': ${data.length} records`);
  }

  const summaryPath = path.join(backupDir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({ timestamp, summary }, null, 2), "utf-8");

  console.log("\n==================================================");
  console.log(`✅ BACKUP SUCCESSFULLY COMPLETED TO: ${backupDir}`);
  console.log("==================================================");

  await mongoose.disconnect();
}

backupDatabase().catch(err => {
  console.error("Backup failed:", err);
  process.exit(1);
});
