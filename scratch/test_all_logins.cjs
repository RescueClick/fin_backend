const mongoose = require('mongoose');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function testAllLogins() {
  await mongoose.connect(process.env.MONGO_URI);
  const usersCol = mongoose.connection.db.collection('users');

  const admin = await usersCol.findOne({ role: 'SUPER_ADMIN' });
  const rsm = await usersCol.findOne({ role: 'RSM' });
  const asm = await usersCol.findOne({ role: 'ASM' });
  const rm = await usersCol.findOne({ role: 'RM' });
  const partner = await usersCol.findOne({ role: 'PARTNER' });
  const customer = await usersCol.findOne({ role: 'CUSTOMER' });

  console.log('Sample users found:');
  console.log('Admin:', admin?.email, admin?._id);
  console.log('RSM:', rsm?.email, rsm?._id, 'rsmCode:', rsm?.rsmCode);
  console.log('ASM:', asm?.email, asm?._id, 'asmType:', asm?.asmType, 'rsmId:', asm?.rsmId);
  console.log('RM:', rm?.email, rm?._id, 'personalAsmId:', rm?.personalAsmId, 'rsmId:', rm?.rsmId);
  console.log('Partner:', partner?.email, partner?._id, 'rmId:', partner?.rmId);
  console.log('Customer:', customer?.email, customer?._id);

  // Now let's test axios calls to running backend (port 5000)
  const axios = require('axios');
  const backendUrl = 'http://localhost:5000/api';

  // Admin JWT
  const adminToken = jwt.sign(
    { sub: String(admin._id), role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );

  const targets = [
    { role: 'RSM', user: rsm },
    { role: 'ASM', user: asm },
    { role: 'RM', user: rm },
    { role: 'PARTNER', user: partner },
    { role: 'CUSTOMER', user: customer },
  ];

  for (const target of targets) {
    if (!target.user) {
      console.log(`Skipping ${target.role} (no user found in DB)`);
      continue;
    }
    try {
      const res = await axios.post(
        `${backendUrl}/auth/login-as/${target.user._id}`,
        {},
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      console.log(`✅ Login-As ${target.role} SUCCESS:`, {
        status: res.status,
        userRole: res.data.user?.role,
        userName: res.data.user?.firstName,
        hasToken: !!res.data.token,
        parentRole: res.data.parent?.role
      });

      // Now test calling an API with this impersonated token
      const impersonatedToken = res.data.token;
      let testEndpoint = '';
      if (target.role === 'RSM') testEndpoint = '/rsm/dashboard';
      else if (target.role === 'ASM') testEndpoint = '/asm/dashboard';
      else if (target.role === 'RM') testEndpoint = '/rm/dashboard';
      else if (target.role === 'PARTNER') testEndpoint = '/partner/dashboard';
      else if (target.role === 'CUSTOMER') testEndpoint = '/customer/get-applications';

      if (testEndpoint) {
        try {
          const apiRes = await axios.get(`${backendUrl}${testEndpoint}`, {
            headers: { Authorization: `Bearer ${impersonatedToken}` }
          });
          console.log(`   ✅ API test ${testEndpoint} SUCCESS: status ${apiRes.status}`);
        } catch (apiErr) {
          console.error(`   ❌ API test ${testEndpoint} FAILED:`, apiErr.response?.status, apiErr.response?.data || apiErr.message);
        }
      }
    } catch (err) {
      console.error(`❌ Login-As ${target.role} FAILED:`, err.response?.status, err.response?.data || err.message);
    }
  }

  await mongoose.disconnect();
}

testAllLogins().catch(console.error);
