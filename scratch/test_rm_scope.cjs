const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { getRmIdsUnderRsm } = require('../src/utils/asmHierarchy.js');

async function testScope() {
  await mongoose.connect(process.env.MONGO_URI);
  const anilRsmId = '6a65e75844d77ea296313ecf';
  const rmIds = await getRmIdsUnderRsm(anilRsmId);
  console.log('Anil Bagad getRmIdsUnderRsm count:', rmIds.length);
  const db = mongoose.connection.db;
  const rms = await db.collection('users').find({ _id: { $in: rmIds } }).toArray();
  rms.forEach(r => console.log(r.firstName, r.lastName, r.status, 'deletedAt:', r.deletedAt));
  await mongoose.disconnect();
}
testScope();
