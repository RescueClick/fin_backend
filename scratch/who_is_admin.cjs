const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function searchAdmins() {
  await mongoose.connect(process.env.MONGO_URI);
  const usersCol = mongoose.connection.db.collection('users');

  const usersWithAdmin = await usersCol.find({
    $or: [
      { role: /admin/i },
      { email: /admin/i }
    ]
  }).project({
    firstName: 1,
    lastName: 1,
    email: 1,
    phone: 1,
    role: 1,
    status: 1,
    employeeId: 1
  }).toArray();

  console.log('Users matching "admin" in role or email:', usersWithAdmin);

  // Group by role to see all distinct roles in the DB
  const roleCounts = await usersCol.aggregate([
    { $group: { _id: "$role", count: { $sum: 1 } } }
  ]).toArray();
  console.log('Role counts across DB:', roleCounts);

  await mongoose.disconnect();
}

searchAdmins().catch(console.error);
