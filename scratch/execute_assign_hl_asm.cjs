const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function executeAssignHlAsm() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const rms = await db.collection('users').find({ role: 'RM' }).toArray();
  const hlAsms = await db.collection('users').find({
    role: 'ASM',
    status: 'ACTIVE',
    asmType: 'HOME_LAP'
  }).toArray();

  console.log(`Found ${rms.length} RMs and ${hlAsms.length} active HOME_LAP ASMs.`);

  let updatedCount = 0;
  for (const rm of rms) {
    const parentRsmId = rm.rsmId || rm.asmId;
    const matchingAsm = hlAsms.find(
      a => String(a.rsmId) === String(parentRsmId) || String(a.asmId) === String(parentRsmId)
    );

    if (matchingAsm) {
      const result = await db.collection('users').updateOne(
        { _id: rm._id },
        {
          $set: {
            homeLapAsmId: matchingAsm._id,
            homeLapRsmId: matchingAsm._id,
          }
        }
      );

      console.log(`Updated RM ${rm.employeeId} (${rm.firstName} ${rm.lastName}) -> Assigned HL/LAP ASM: ${matchingAsm.employeeId} (${matchingAsm.firstName} ${matchingAsm.lastName}) [modifiedCount: ${result.modifiedCount}]`);
      updatedCount++;
    } else {
      console.warn(`No matching HOME_LAP ASM found for RM ${rm.employeeId} (${rm.firstName} ${rm.lastName}) with RSM ${parentRsmId}`);
    }
  }

  console.log(`\nCompleted. Successfully assigned HL/LAP ASM for ${updatedCount} RMs.`);
  await mongoose.disconnect();
}

executeAssignHlAsm().catch(console.error);
