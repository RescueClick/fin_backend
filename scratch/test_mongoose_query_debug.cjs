const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { User } = require('../src/models/User.js');
const { ROLES } = require('../src/config/roles.js');

async function testQuery() {
  await mongoose.connect(process.env.MONGO_URI);
  mongoose.set('debug', true);

  const managerId = '6a8c3ff4f609166f305c1743';
  const userBase = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };

  console.log('--- Test with User model ---');
  const query = User.find({
    $or: [{ rsmId: managerId }, { asmId: managerId }],
    role: { $in: [ROLES.ASM, ROLES.RSM] },
    ...userBase,
  });

  console.log('Filter:', JSON.stringify(query.getFilter(), null, 2));
  const subordinates = await query.lean();

  console.log('Count:', subordinates.length);
  await mongoose.disconnect();
}
testQuery();
