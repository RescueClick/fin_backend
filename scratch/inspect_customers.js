import mongoose from "mongoose";
import dotenv from "dotenv";
import { Application } from "../src/models/Application.js";
import { User } from "../src/models/User.js";

dotenv.config();

async function inspectCustomers() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const apps = await Application.find({}).lean();
  console.log(`Total Applications in DB: ${apps.length}`);

  let withCustomerId = 0;
  let withoutCustomerId = 0;
  const distinctCustomerIds = new Set();
  const distinctPhones = new Set();

  for (const app of apps) {
    if (app.customerId) {
      withCustomerId++;
      distinctCustomerIds.add(String(app.customerId));
    } else {
      withoutCustomerId++;
    }
    const phone = app.applicantDetails?.personalDetails?.phone || 
                  app.applicantDetails?.phone || 
                  app.customerPhone || 
                  app.phone || 
                  (app.customerId ? String(app.customerId) : null);
    if (phone) distinctPhones.add(String(phone));
  }

  console.log(`Apps with customerId: ${withCustomerId}`);
  console.log(`Apps without customerId: ${withoutCustomerId}`);
  console.log(`Distinct customerId count: ${distinctCustomerIds.size}`);
  console.log(`Distinct phones/customer identifiers across apps: ${distinctPhones.size}`);

  // Check how Admin calculates it
  const adminCustomerAccounts = await User.countDocuments({ role: "CUSTOMER" });
  console.log(`User.countDocuments({ role: "CUSTOMER" }): ${adminCustomerAccounts}`);

  process.exit(0);
}

inspectCustomers();
