
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from '../src/models/User.js';

dotenv.config();

async function checkPartners() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const pendingPartners = await User.find({ role: 'PARTNER', status: 'PENDING' }).lean();
    console.log(`Total Pending Partners: ${pendingPartners.length}`);
    
    pendingPartners.forEach(p => {
      console.log(`- ${p.firstName} ${p.lastName} (${p.email}), RM ID: ${p.rmId}, Referred By: ${p.referredBy}`);
    });

    const superAdmin = await User.findOne({ role: 'SUPER_ADMIN' }).lean();
    console.log(`Super Admin ID: ${superAdmin?._id}`);

    await mongoose.disconnect();
  } catch (err) {
    console.error(err);
  }
}

checkPartners();
