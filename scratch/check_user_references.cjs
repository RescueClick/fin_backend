const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function checkReferences() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const users = await db.collection('users').find({
    role: { $in: ['RSM', 'ASM', 'RM'] }
  }).toArray();

  console.log('=== USER REFERENCES AUDIT ===');
  for (const u of users) {
    const appsCountAsAsm = await db.collection('applications').countDocuments({ asmId: u._id });
    const appsCountAsRsm = await db.collection('applications').countDocuments({ rsmId: u._id });
    const appsCountAsRm = await db.collection('applications').countDocuments({ rmId: u._id });
    const partnersCount = await db.collection('users').countDocuments({
      role: 'PARTNER',
      $or: [{ rsmId: u._id }, { asmId: u._id }, { rmId: u._id }]
    });
    const subordinatesCount = await db.collection('users').countDocuments({
      $or: [
        { rsmId: u._id }, { asmId: u._id },
        { personalAsmId: u._id }, { businessAsmId: u._id }, { homeLapAsmId: u._id },
        { personalRsmId: u._id }, { businessRsmId: u._id }, { homeLapRsmId: u._id }
      ]
    });

    console.log({
      name: `${u.firstName} ${u.lastName}`,
      role: u.role,
      asmType: u.asmType,
      status: u.status,
      employeeId: u.employeeId,
      deletedAt: u.deletedAt ? true : false,
      appsAsAsm: appsCountAsAsm,
      appsAsRsm: appsCountAsRsm,
      appsAsRm: appsCountAsRm,
      partners: partnersCount,
      subordinates: subordinatesCount
    });
  }

  await mongoose.disconnect();
}
checkReferences();
