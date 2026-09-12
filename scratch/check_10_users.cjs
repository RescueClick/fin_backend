const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  const usersCol = mongoose.connection.db.collection('users');

  const ids = ['TLS0015', 'TLS0014', 'TLS0013', 'TLA0008', 'TLS0012', 'TLS0011', 'TLA0007', 'TLS0007', 'TLS0006', 'TLA0004'];
  const users = await usersCol.find({ employeeId: { $in: ids } }).toArray();
  console.log(`Found ${users.length} users:`);
  users.forEach(u => {
    console.log({
      _id: u._id.toString(),
      employeeId: u.employeeId,
      name: `${u.firstName} ${u.lastName}`,
      email: u.email,
      role: u.role,
      asmType: u.asmType,
      rsmType: u.rsmType,
      rsmId: u.rsmId?.toString(),
      asmId: u.asmId?.toString()
    });
  });

  await mongoose.disconnect();
}

check().catch(console.error);
