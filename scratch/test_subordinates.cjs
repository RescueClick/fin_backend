const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function t() {
  await mongoose.connect(process.env.MONGO_URI);
  const managerId = '6a8c3ff4f609166f305c1743';
  const res = await mongoose.connection.db.collection('users').find({
    $or: [
      { rsmId: new mongoose.Types.ObjectId(managerId) },
      { asmId: new mongoose.Types.ObjectId(managerId) }
    ]
  }).toArray();
  console.log('Subordinates count:', res.length);
  res.forEach(r => console.log(r.firstName, r.lastName, r.role, r.employeeId));
  await mongoose.disconnect();
}
t();
