const axios = require('axios');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function checkGetRm() {
  const adminToken = jwt.sign(
    { sub: '6a439c6d815f90506104cb6e', role: 'SUPER_ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );

  const res = await axios.get('http://localhost:5000/api/admin/get-rm', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  console.log('GET /admin/get-rm returned:', JSON.stringify(res.data, null, 2));
}

checkGetRm().catch(console.error);
