const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function verifyAsms() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const asms = await db.collection('users').find({
    role: 'ASM',
    status: 'ACTIVE'
  }).toArray();

  console.log(`Active ASMs (${asms.length}):`);
  for (const a of asms) {
    const parentRsm = await db.collection('users').findOne({ _id: a.rsmId });
    console.log(`- ${a.firstName} ${a.lastName} (${a.asmType}) -> Parent RSM: ${parentRsm?.firstName} ${parentRsm?.lastName}`);
  }

  await mongoose.disconnect();
}
verifyAsms();
