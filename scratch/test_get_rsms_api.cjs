const jwt = require('jsonwebtoken');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function testApi() {
  const secret = process.env.JWT_SECRET;
  
  // Create token for Sanjay Gawai (RSM)
  // _id: 6a8c3ff4f609166f305c1743
  const sanjayToken = jwt.sign(
    { sub: '6a8c3ff4f609166f305c1743', role: 'RSM', email: 'sanjaygawai2027@gmail.com' },
    secret,
    { expiresIn: '1h' }
  );

  try {
    const res = await axios.get('http://localhost:5000/api/asm/get-rsms', {
      headers: { Authorization: `Bearer ${sanjayToken}` }
    });
    console.log('Result for Sanjay Gawai (RSM): count =', res.data.length);
    console.log(res.data.map(u => ({ id: u._id, name: `${u.firstName} ${u.lastName}`, role: u.role, employeeId: u.employeeId })));
  } catch (err) {
    console.error('Error with Sanjay token:', err.response?.data || err.message);
  }

  // Create token for Super Admin
  const adminToken = jwt.sign(
    { sub: '6a439c6d815f90506104cb6e', role: 'SUPER_ADMIN', email: 'bagadanil09@gmail.com' },
    secret,
    { expiresIn: '1h' }
  );

  try {
    const res = await axios.get('http://localhost:5000/api/asm/get-rsms', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log('\nResult for Super Admin: count =', res.data.length);
    console.log(res.data.map(u => ({ id: u._id, name: `${u.firstName} ${u.lastName}`, role: u.role, employeeId: u.employeeId })));
  } catch (err) {
    console.error('Error with Admin token:', err.response?.data || err.message);
  }
}

testApi();
