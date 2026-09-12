const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const JWT_SECRET = process.env.JWT_SECRET;
const sanjayToken = jwt.sign(
  { sub: '6a8c3ff4f609166f305c1743', role: 'RSM', email: 'sanjaygawai2027@gmail.com' },
  JWT_SECRET,
  { expiresIn: '7d' }
);

async function run() {
  const res = await axios.get('http://localhost:5000/api/asm/get-rsms', {
    headers: { Authorization: `Bearer ${sanjayToken}` }
  });
  console.log('Status:', res.status);
  console.log('Headers:', res.headers);
  console.log('Data:', JSON.stringify(res.data, null, 2));
}

run().catch(console.error);
