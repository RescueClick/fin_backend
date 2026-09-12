const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const JWT_SECRET = process.env.JWT_SECRET;
const adminToken = jwt.sign(
  { sub: '6a439c6d815f90506104cb6e', role: 'SUPER_ADMIN', email: 'bagadanil09@gmail.com' },
  JWT_SECRET,
  { expiresIn: '7d' }
);

async function testAdmin() {
  const backendurl = 'http://localhost:5000/api';
  try {
    const res = await axios.get(`${backendurl}/admin/get-rms`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log('/admin/get-rms count:', res.data.length);
    res.data.forEach(r => {
      console.log({
        name: `${r.firstName} ${r.lastName}`,
        status: r.status,
        employeeId: r.employeeId,
        rsmName: r.rsmName,
        personalAsmName: r.personalAsmName,
        businessAsmName: r.businessAsmName
      });
    });
  } catch (err) {
    console.error('Error /admin/get-rms:', err.response?.data || err.message);
  }
}

testAdmin();
