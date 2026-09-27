const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function dryRun() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const rms = await db.collection('users').find({ role: 'RM' }).toArray();
  const hlAsms = await db.collection('users').find({
    role: 'ASM',
    status: 'ACTIVE',
    asmType: 'HOME_LAP'
  }).toArray();

  console.log('HL ASMs available:');
  hlAsms.forEach(a => console.log(' -', a.employeeId, a.firstName, a.lastName, 'under RSM:', a.rsmId));

  console.log('\nEvaluating RMs:');
  for (const rm of rms) {
    const parentRsmId = rm.rsmId || rm.asmId;
    const matchingAsm = hlAsms.find(a => String(a.rsmId) === String(parentRsmId) || String(a.asmId) === String(parentRsmId));
    console.log({
      rmName: `${rm.firstName} ${rm.lastName}`,
      rmEmpId: rm.employeeId,
      status: rm.status,
      currentHlAsmId: rm.homeLapAsmId,
      parentRsmId: parentRsmId,
      matchedHlAsm: matchingAsm ? `${matchingAsm.employeeId} (${matchingAsm.firstName} ${matchingAsm.lastName})` : 'NONE'
    });
  }

  await mongoose.disconnect();
}

dryRun().catch(console.error);
