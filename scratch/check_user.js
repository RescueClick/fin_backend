import mongoose from "mongoose";
import dotenv from "dotenv";
import { User } from "../src/models/User.js";

dotenv.config();

async function checkOldUser() {
  await mongoose.connect(process.env.MONGO_URI);
  const u = await User.findById("6a439c6d815f90506104cb6e").lean();
  console.log("User 6a439c6d815f90506104cb6e:", u);
  process.exit(0);
}

checkOldUser();
