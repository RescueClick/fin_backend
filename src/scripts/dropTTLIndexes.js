import mongoose from "mongoose";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const dropIndexes = async () => {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      throw new Error("MONGO_URI is missing in environment variables.");
    }

    console.log("Connecting to database...");
    await mongoose.connect(uri);
    console.log("Connected to database successfully.");

    const db = mongoose.connection.db;

    // 1. Drop TTL index from Applications collection
    try {
      console.log("Attempting to drop TTL index from 'applications' collection...");
      await db.collection("applications").dropIndex("deletedAt_1");
      console.log("✅ Successfully dropped TTL index from 'applications'.");
    } catch (err) {
      if (err.code === 27) {
        console.log("⚠️ Index 'deletedAt_1' not found in 'applications'. It may have already been dropped.");
      } else {
        console.error("❌ Error dropping index from 'applications':", err.message);
      }
    }

    // 2. Drop TTL index from Users collection
    try {
      console.log("Attempting to drop TTL index from 'users' collection...");
      await db.collection("users").dropIndex("deletedAt_1");
      console.log("✅ Successfully dropped TTL index from 'users'.");
    } catch (err) {
      if (err.code === 27) {
        console.log("⚠️ Index 'deletedAt_1' not found in 'users'. It may have already been dropped.");
      } else {
        console.error("❌ Error dropping index from 'users':", err.message);
      }
    }

    console.log("Migration complete.");
  } catch (error) {
    console.error("Failed to run migration:", error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

dropIndexes();
