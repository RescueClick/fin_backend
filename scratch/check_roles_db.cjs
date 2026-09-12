const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  const users = await mongoose.connection.db.collection('users').find({
    role: { $in: ['RSM', 'ASM', 'RM', 'SUPER_ADMIN'] }
  }).toArray();

  console.log('=== USERS (RSM, ASM, RM, SUPER_ADMIN) ===');
  users.forEach(u => {
    console.log(JSON.stringify({
      _id: u._id.toString(),
      name: `${u.firstName} ${u.lastName}`,
      role: u.role,
      employeeId: u.employeeId,
      email: u.email,
      phone: u.phone,
      asmType: u.asmType,
      rsmType: u.rsmType,
      rsmId: u.rsmId ? u.rsmId.toString() : null,
      asmId: u.asmId ? u.asmId.toString() : null,
      personalAsmId: u.personalAsmId ? u.personalAsmId.toString() : null,
      businessAsmId: u.businessAsmId ? u.businessAsmId.toString() : null,
      homeLapAsmId: u.homeLapAsmId ? u.homeLapAsmId.toString() : null,
      personalRsmId: u.personalRsmId ? u.personalRsmId.toString() : null,
      businessRsmId: u.businessRsmId ? u.businessRsmId.toString() : null,
      homeLapRsmId: u.homeLapRsmId ? u.homeLapRsmId.toString() : null,
      status: u.status,
      deletedAt: u.deletedAt
    }, null, 2));
  });
  await mongoose.disconnect();
}
check();
