const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function inspectRsms() {
  await mongoose.connect(process.env.MONGO_URI);
  const rsms = await mongoose.connection.db.collection('users').find({
    role: 'RSM',
    status: 'ACTIVE'
  }).toArray();

  rsms.forEach(r => {
    console.log({
      _id: r._id,
      name: `${r.firstName} ${r.lastName}`,
      role: r.role,
      rsmType: r.rsmType,
      asmType: r.asmType,
      rsmId: r.rsmId,
      asmId: r.asmId
    });
  });
  await mongoose.disconnect();
}
inspectRsms();
