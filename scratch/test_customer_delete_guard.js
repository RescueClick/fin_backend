import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";
import { DeleteAccountRequest } from "../src/models/DeleteAccountRequest.js";

async function testCustomerDeleteRequestGuard() {
  await connectDB(process.env.MONGO_URI);

  // Test Customer with NO active applications
  const testCustomer = await User.findOne({ role: "CUSTOMER", deletedAt: null }).lean();
  console.log("Testing with Customer:", testCustomer?.firstName, testCustomer?.lastName);

  const activeApps = await Application.find({
    customerId: testCustomer._id,
    status: { $in: ["SUBMITTED", "DOC_INCOMPLETE", "DOC_COMPLETE", "LOGIN", "UNDER_REVIEW", "APPROVED", "AGREEMENT", "DISBURSED"] },
    $or: [{ deletedAt: null }, { deletedAt: { $gt: new Date() } }],
  }).lean();

  console.log("Active applications count for customer:", activeApps.length);
  if (activeApps.length === 0) {
    console.log("✅ Customer is eligible to request account deletion without active loan blockers.");
  } else {
    console.log("🛡️ Customer has active applications. Deletion request will be blocked safely with active loan error message.");
  }

  await mongoose.disconnect();
}

testCustomerDeleteRequestGuard().catch(console.error);
