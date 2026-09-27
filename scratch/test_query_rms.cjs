const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Register models
require('../src/models/User.js');

async function testQuery() {
  await mongoose.connect(process.env.MONGO_URI);
  const User = mongoose.model('User');

  const list = await User.find({ role: 'RM', $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] })
    .select("-passwordHash -__v")
    .populate({ path: "personalAsmId", select: "firstName lastName employeeId phone email" })
    .populate({ path: "businessAsmId", select: "firstName lastName employeeId phone email" })
    .populate({ path: "homeLapAsmId", select: "firstName lastName employeeId phone email" })
    .populate({ path: "personalRsmId", select: "firstName lastName employeeId phone email" })
    .populate({ path: "businessRsmId", select: "firstName lastName employeeId phone email" })
    .populate({ path: "homeLapRsmId", select: "firstName lastName employeeId phone email" })
    .lean();

  console.log(`Active RMs count: ${list.length}`);
  list.forEach(rm => {
    const personalAsm = rm.personalAsmId || rm.personalRsmId;
    const businessAsm = rm.businessAsmId || rm.businessRsmId;
    const homeLapAsm = rm.homeLapAsmId || rm.homeLapRsmId || null;

    console.log({
      name: `${rm.firstName} ${rm.lastName}`,
      employeeId: rm.employeeId,
      PL: personalAsm ? `${personalAsm.firstName} ${personalAsm.lastName} (${personalAsm.employeeId})` : '—',
      BL: businessAsm ? `${businessAsm.firstName} ${businessAsm.lastName} (${businessAsm.employeeId})` : '—',
      HL_LAP: homeLapAsm ? `${homeLapAsm.firstName} ${homeLapAsm.lastName} (${homeLapAsm.employeeId})` : '—',
    });
  });

  await mongoose.disconnect();
}

testQuery().catch(console.error);
