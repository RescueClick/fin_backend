import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import { Application } from "../src/models/Application.js";
import { User } from "../src/models/User.js";

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to Mongo");

    const users = await User.find({
      $or: [
        { employeeId: { $in: ["TLC0091", "TLC0090", "TLC0092", "TLC0089"] } },
        { firstName: { $in: ["Audrey", "Snj"] } }
      ]
    }).lean();
    console.log("USERS FOUND:", JSON.stringify(users, null, 2));

    const userIds = users.map(u => u._id);

    const apps = await Application.find({
      $or: [
        { appNo: { $in: ["TLC0091", "TLC0090", "TLC0092", "TLC0089"] } },
        { customerId: { $in: userIds } },
        { "customer.employeeId": { $in: ["TLC0091", "TLC0090", "TLC0092", "TLC0089"] } },
        { "customer.firstName": { $in: ["Audrey", "Snj"] } }
      ]
    }).lean();

    console.log("APPLICATIONS FOUND:", JSON.stringify(apps.map(a => ({
      _id: a._id,
      appNo: a.appNo,
      status: a.status,
      deletedAt: a.deletedAt,
      isArchived: a.isArchived,
      customerId: a.customerId,
      partnerId: a.partnerId,
      rmId: a.rmId,
      customer: a.customer
    })), null, 2));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
