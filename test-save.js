import mongoose from "mongoose";
import { User } from "./src/models/User.js";
import dotenv from "dotenv";
dotenv.config();

async function test() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Find a test user or any user to see if save works
    const user = await User.findOne({});
    if (user) {
        console.log("Found user:", user.email, "Phone:", user.phone);
        // try to validate
        try {
            await user.validate();
            console.log("Validation passed!");
        } catch(e) {
            console.error("Validation failed:", e.message);
        }
    } else {
        console.log("No users found");
    }

  } catch (err) {
    console.error(err);
  } finally {
    mongoose.disconnect();
  }
}

test();
