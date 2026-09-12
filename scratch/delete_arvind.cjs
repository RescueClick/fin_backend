const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function removeArvind() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const result = await db.collection('users').deleteOne({
    _id: new mongoose.Types.ObjectId('6aa57eb3dbf770bfe61bc2ed')
  });
  console.log('Deleted Arvind Gaikwad count:', result.deletedCount);

  await mongoose.disconnect();
}
removeArvind();
