const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function checkAdmins() {
  await mongoose.connect(process.env.MONGO_URI);
  const users = await mongoose.connection.db.collection('users').find({
    role: { $in: ['SUPER_ADMIN', 'ADMIN'] }
  }).toArray();
  console.log('Admin users found:', users.map(u => ({ id: u._id, email: u.email, role: u.role, status: u.status })));
  await mongoose.disconnect();
}

checkAdmins().catch(console.error);
