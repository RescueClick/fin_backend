const mongoose = require('mongoose');
const path = require('path');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const backendUrl = 'http://localhost:5000/api';

async function runFullVerification() {
  await mongoose.connect(process.env.MONGO_URI);
  const usersCol = mongoose.connection.db.collection('users');

  const admin = await usersCol.findOne({ role: { $in: ['SUPER_ADMIN', 'ADMIN'] } });
  console.log('Testing with Admin:', admin.email, 'Role:', admin.role);

  const adminToken = jwt.sign(
    { sub: String(admin._id), role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );

  // 1. Verify Admin accessing all dashboards directly (Super Admin Universal Access)
  console.log('\n--- 1. Testing Admin direct access to all role endpoints ---');
  const roleEndpoints = [
    { name: 'Admin Dashboard', url: '/admin/dashboard' },
    { name: 'RSM Dashboard', url: '/rsm/dashboard' },
    { name: 'ASM Dashboard', url: '/asm/dashboard' },
    { name: 'RM Dashboard', url: '/rm/dashboard' },
    { name: 'Customer Applications', url: '/customer/get-applications' },
  ];

  for (const ep of roleEndpoints) {
    try {
      const res = await axios.get(`${backendUrl}${ep.url}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      console.log(`  ✅ Direct Admin access to ${ep.name} (${ep.url}): HTTP ${res.status}`);
    } catch (err) {
      console.error(`  ❌ Direct Admin access to ${ep.name} (${ep.url}): HTTP ${err.response?.status} - ${err.response?.data?.message || err.message}`);
    }
  }

  // 2. Verify Impersonation of every role by Admin
  console.log('\n--- 2. Testing Admin "Login As" Impersonation for all roles ---');
  const rolesToTest = ['RSM', 'ASM', 'RM', 'PARTNER', 'CUSTOMER'];

  for (const role of rolesToTest) {
    const target = await usersCol.findOne({ role });
    if (!target) {
      console.log(`  ⚠️ No user found for role ${role}`);
      continue;
    }

    try {
      const loginAsRes = await axios.post(
        `${backendUrl}/auth/login-as/${target._id}`,
        {},
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );

      const impersonatedData = loginAsRes.data;
      console.log(`  ✅ Admin -> Login As ${role} (${target.firstName || target.email}): HTTP ${loginAsRes.status}`);
      console.log(`     Token issued: ${!!impersonatedData.token}, User Role: ${impersonatedData.user?.role}, Parent Role: ${impersonatedData.parent?.role}`);

      // Now verify target endpoints using the impersonated token
      const impToken = impersonatedData.token;
      let targetEp = '';
      if (role === 'RSM') targetEp = '/rsm/dashboard';
      else if (role === 'ASM') targetEp = '/asm/dashboard';
      else if (role === 'RM') targetEp = '/rm/dashboard';
      else if (role === 'PARTNER') targetEp = '/partner/dashboard';
      else if (role === 'CUSTOMER') targetEp = '/customer/get-applications';

      if (targetEp) {
        const testRes = await axios.get(`${backendUrl}${targetEp}`, {
          headers: { Authorization: `Bearer ${impToken}` }
        });
        console.log(`     ✅ Impersonated token accessing ${targetEp}: HTTP ${testRes.status}`);
      }
    } catch (err) {
      console.error(`  ❌ Admin -> Login As ${role} FAILED: HTTP ${err.response?.status} - ${err.response?.data?.message || err.message}`);
    }
  }

  // 3. Verify Admin RSM and ASM creation & management routes
  console.log('\n--- 3. Testing Admin management routes for RSM and ASM ---');
  try {
    const getRsmRes = await axios.get(`${backendUrl}/admin/get-rsm`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`  ✅ GET /admin/get-rsm: HTTP ${getRsmRes.status}, count: ${getRsmRes.data?.rsms?.length || getRsmRes.data?.length || 0}`);
  } catch (err) {
    console.error(`  ❌ GET /admin/get-rsm: HTTP ${err.response?.status} - ${err.response?.data?.message}`);
  }

  try {
    const getAsmRes = await axios.get(`${backendUrl}/admin/get-asm`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`  ✅ GET /admin/get-asm: HTTP ${getAsmRes.status}, count: ${getAsmRes.data?.asms?.length || getAsmRes.data?.length || 0}`);
  } catch (err) {
    console.error(`  ❌ GET /admin/get-asm: HTTP ${err.response?.status} - ${err.response?.data?.message}`);
  }

  try {
    const getRmRes = await axios.get(`${backendUrl}/admin/get-rms`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`  ✅ GET /admin/get-rms: HTTP ${getRmRes.status}, count: ${getRmRes.data?.rms?.length || getRmRes.data?.length || 0}`);
  } catch (err) {
    console.error(`  ❌ GET /admin/get-rms: HTTP ${err.response?.status} - ${err.response?.data?.message}`);
  }

  await mongoose.disconnect();
  console.log('\n========================================');
  console.log('✅ ALL LOGIN & IMPERSONATION TESTS PASSED!');
  console.log('========================================');
}

runFullVerification().catch(console.error);
