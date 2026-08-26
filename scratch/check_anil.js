import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";

async function checkAnil() {
  await connectDB(process.env.MONGO_URI);
  const u = await User.findById("6a439c6d815f90506104cb6e").lean();
  console.log("Anil user:", { name: `${u?.firstName} ${u?.lastName}`, role: u?.role, email: u?.email });
  await mongoose.disconnect();
}
checkAnil().catch(console.error);
