const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function checkArvind() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const arvind = await db.collection('users').findOne({ employeeId: 'TLS0015' });
  console.log('Arvind user:', arvind);

  if (arvind) {
    const targets = await db.collection('targets').find({ userId: arvind._id }).toArray();
    console.log('Arvind targets:', targets);
    const apps = await db.collection('applications').find({ asmId: arvind._id }).toArray();
    console.log('Arvind apps:', apps);
  }

  await mongoose.disconnect();
}
checkArvind();
