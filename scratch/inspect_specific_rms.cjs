const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function inspectRms() {
  await mongoose.connect(process.env.MONGO_URI);
  const usersCol = mongoose.connection.db.collection('users');

  const rms = await usersCol.find({ role: 'RM' }).toArray();
  console.log(`Found ${rms.length} RMs in database:`);
  rms.forEach(rm => {
    console.log({
      _id: rm._id,
      name: `${rm.firstName} ${rm.lastName}`,
      employeeId: rm.employeeId,
      status: rm.status,
      deletedAt: rm.deletedAt,
      rsmId: rm.rsmId,
      asmId: rm.asmId,
      personalAsmId: rm.personalAsmId,
      businessAsmId: rm.businessAsmId,
      homeLapAsmId: rm.homeLapAsmId,
      personalRsmId: rm.personalRsmId,
      businessRsmId: rm.businessRsmId,
      homeLapRsmId: rm.homeLapRsmId,
    });
  });

  await mongoose.disconnect();
}

inspectRms().catch(console.error);
