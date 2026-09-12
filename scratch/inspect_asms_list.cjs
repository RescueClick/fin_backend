const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function inspectAsms() {
  await mongoose.connect(process.env.MONGO_URI);
  const usersCol = mongoose.connection.db.collection('users');

  const asms = await usersCol.find({ role: 'ASM' }).toArray();
  console.log(`Found ${asms.length} ASMs:`);
  asms.forEach(a => {
    console.log({
      _id: a._id,
      name: `${a.firstName} ${a.lastName}`,
      asmType: a.asmType,
      rsmType: a.rsmType,
      rsmId: a.rsmId,
      status: a.status
    });
  });

  await mongoose.disconnect();
}

inspectAsms().catch(console.error);
