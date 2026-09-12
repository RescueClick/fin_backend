const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function checkHierarchyConsistency() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const users = await db.collection('users').find({
    role: { $in: ['RSM', 'ASM', 'RM'] },
    status: 'ACTIVE'
  }).toArray();

  console.log('=== ACTIVE USERS IN HIERARCHY ===');
  users.forEach(u => {
    console.log(`${u.role}: ${u.firstName} ${u.lastName} [${u._id}] - ${u.asmType || u.employeeId}`);
  });

  console.log('\n=== CHECKING RMS PARENTS ===');
  const rms = users.filter(u => u.role === 'RM');
  for (const rm of rms) {
    console.log(`\nRM: ${rm.firstName} ${rm.lastName} (${rm.employeeId})`);
    console.log(`  rsmId: ${rm.rsmId}`);
    console.log(`  personalAsmId: ${rm.personalAsmId}`);
    console.log(`  businessAsmId: ${rm.businessAsmId}`);
    console.log(`  homeLapAsmId: ${rm.homeLapAsmId}`);
  }

  console.log('\n=== CHECKING ASMS PARENTS ===');
  const asms = users.filter(u => u.role === 'ASM');
  for (const asm of asms) {
    console.log(`ASM: ${asm.firstName} ${asm.lastName} (${asm.asmType}, ${asm.employeeId}) -> rsmId: ${asm.rsmId}`);
  }

  await mongoose.disconnect();
}
checkHierarchyConsistency();
