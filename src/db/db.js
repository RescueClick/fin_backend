import mongoose from "mongoose";

export async function connectDB(uri) {
  console.log("Connecting to MongoDB...");
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  console.log("✓ MongoDB connected");
}
