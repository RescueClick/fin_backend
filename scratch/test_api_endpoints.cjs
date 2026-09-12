const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Sanjay Gawai
const sanjayToken = jwt.sign(
  { sub: '6a8c3ff4f609166f305c1743', role: 'RSM', email: 'sanjaygawai2027@gmail.com' },
  JWT_SECRET,
  { expiresIn: '7d' }
);

// Admin token (Anil Bagad super admin)
const adminToken = jwt.sign(
  { sub: '6a439c6d815f90506104cb6e', role: 'SUPER_ADMIN', email: 'bagadanil09@gmail.com' },
  JWT_SECRET,
  { expiresIn: '7d' }
);

async function testEndpoints() {
  const backendurl = 'http://localhost:5000/api';
  console.log('Testing Sanjay Gawai calling /asm/get-rsms:');
  try {
    const res = await axios.get(`${backendurl}/asm/get-rsms`, {
      headers: { Authorization: `Bearer ${sanjayToken}` }
    });
    console.log('Sanjay /asm/get-rsms returned count:', res.data.length);
    console.log('Names:', res.data.map(u => `${u.firstName} ${u.lastName} (${u.role || u.asmType})`));
  } catch (err) {
    console.error('Error Sanjay /asm/get-rsms:', err.response?.status, err.response?.data || err.message);
  }

  console.log('\nTesting Sanjay Gawai calling /rsm/my-asms:');
  try {
    const res = await axios.get(`${backendurl}/rsm/my-asms`, {
      headers: { Authorization: `Bearer ${sanjayToken}` }
    });
    console.log('Sanjay /rsm/my-asms returned count:', res.data.length);
    console.log('Names:', res.data.map(u => `${u.firstName} ${u.lastName} (${u.role || u.asmType})`));
  } catch (err) {
    console.error('Error Sanjay /rsm/my-asms:', err.response?.status, err.response?.data || err.message);
  }

  console.log('\nTesting Admin calling /asm/get-rsms:');
  try {
    const res = await axios.get(`${backendurl}/asm/get-rsms`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log('Admin /asm/get-rsms returned count:', res.data.length);
    console.log('Names:', res.data.map(u => `${u.firstName} ${u.lastName} (${u.role || u.asmType})`));
  } catch (err) {
    console.error('Error Admin /asm/get-rsms:', err.response?.status, err.response?.data || err.message);
  }

  console.log('\nTesting Admin calling /admin/get-asms:');
  try {
    const res = await axios.get(`${backendurl}/admin/get-asms`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log('Admin /admin/get-asms returned count:', res.data.length);
    console.log('Names:', res.data.map(u => `${u.firstName} ${u.lastName} (${u.role || u.asmType})`));
  } catch (err) {
    console.error('Error Admin /admin/get-asms:', err.response?.status, err.response?.data || err.message);
  }

  console.log('\nTesting Admin calling /admin/get-rsms:');
  try {
    const res = await axios.get(`${backendurl}/admin/get-rsms`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log('Admin /admin/get-rsms returned count:', res.data.length);
    console.log('Names:', res.data.map(u => `${u.firstName} ${u.lastName} (${u.role || u.asmType})`));
  } catch (err) {
    console.error('Error Admin /admin/get-rsms:', err.response?.status, err.response?.data || err.message);
  }
}

testEndpoints();
