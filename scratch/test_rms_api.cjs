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

async function testRms() {
  const backendurl = 'http://localhost:5000/api';
  try {
    const res = await axios.get(`${backendurl}/asm/get-rm`, {
      headers: { Authorization: `Bearer ${sanjayToken}` }
    });
    console.log('/asm/get-rm count:', res.data.length);
    console.log('/asm/get-rm items:', res.data.map(r => ({
      name: `${r.firstName} ${r.lastName}`,
      role: r.role,
      rsm: r.rsmId ? `${r.rsmId.firstName} ${r.rsmId.lastName}` : null,
      personalAsm: r.personalAsmId,
      businessAsm: r.businessAsmId,
    })));
  } catch (err) {
    console.error('Error /asm/get-rm:', err.response?.data || err.message);
  }

  try {
    const res2 = await axios.get(`${backendurl}/rsm/my-rms`, {
      headers: { Authorization: `Bearer ${sanjayToken}` }
    });
    console.log('/rsm/my-rms count:', res2.data.length);
    console.log('/rsm/my-rms items:', res2.data.map(r => ({
      name: `${r.firstName} ${r.lastName}`,
      role: r.role,
      rsm: r.rsmId ? `${r.rsmId.firstName} ${r.rsmId.lastName}` : null,
    })));
  } catch (err) {
    console.error('Error /rsm/my-rms:', err.response?.data || err.message);
  }
}

testRms();
