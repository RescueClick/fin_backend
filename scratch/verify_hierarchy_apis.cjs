/**
 * Live API verification: RSM → ASM → RM hierarchy
 */
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BASE = 'http://localhost:5000/api';
const JWT_SECRET = process.env.JWT_SECRET;

const USERS = {
  rsm: {
    id: '6a8c3ff4f609166f305c1743',
    role: 'RSM',
    email: 'sanjaygawai2027@gmail.com',
    name: 'Sanjay Gawai',
    expectedAsms: ['Sandip Chaughule', 'Akash Gawale'],
    expectedRm: 'Gauri Pawar',
  },
  asm: {
    id: '6a8d36dcb346b8a87530a3cb',
    role: 'ASM',
    email: 'sandip@test.com',
    name: 'Sandip Chaughule',
    expectedRm: 'Gauri Pawar',
  },
};

function token(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function pass(msg) {
  console.log(`  ✅ PASS: ${msg}`);
}
function fail(msg) {
  console.log(`  ❌ FAIL: ${msg}`);
}
function info(msg) {
  console.log(`  ℹ️  ${msg}`);
}

async function get(url, tok) {
  const res = await axios.get(`${BASE}${url}`, {
    headers: { Authorization: `Bearer ${tok}` },
    validateStatus: () => true,
  });
  return res;
}

async function testRsm() {
  console.log('\n========== RSM (Sanjay Gawai) ==========');
  const tok = token(USERS.rsm);

  // 1) Dashboard used by /rsm/dashboard frontend (AsmDashboard → /asm/dashboard)
  const dash = await get('/asm/dashboard', tok);
  if (dash.status !== 200) {
    fail(`/asm/dashboard returned ${dash.status}: ${JSON.stringify(dash.data)}`);
    return false;
  }
  const totals = dash.data.totals || {};
  info(`totalASMs=${totals.totalASMs}, totalRSMs=${totals.totalRSMs}, totalRMs=${totals.totalRMs}, totalPartners=${totals.totalPartners}`);

  let ok = true;
  if (Number(totals.totalASMs) === 2) pass('totalASMs === 2 (Sandip + Akash)');
  else {
    fail(`totalASMs expected 2, got ${totals.totalASMs}`);
    ok = false;
  }

  if (Number(totals.totalRMs) >= 1) pass(`totalRMs >= 1 (got ${totals.totalRMs})`);
  else {
    fail(`totalRMs expected >= 1, got ${totals.totalRMs}`);
    ok = false;
  }

  const topAsm = dash.data.topASMPerformers || dash.data.topRSMPerformers || [];
  info(`topASMPerformers count=${topAsm.length}`);
  if (Array.isArray(dash.data.topASMPerformers) || Array.isArray(dash.data.topRSMPerformers)) {
    pass('top ASM performers array present in response');
  } else {
    fail('missing topASMPerformers / topRSMPerformers');
    ok = false;
  }

  // 2) Subordinate list: get-asms / get-rsms
  const asmsRes = await get('/asm/get-asms', tok);
  const asmsAlt = await get('/asm/get-rsms', tok);
  const asms = Array.isArray(asmsRes.data) ? asmsRes.data : (asmsRes.data?.data || []);
  const asms2 = Array.isArray(asmsAlt.data) ? asmsAlt.data : (asmsAlt.data?.data || []);
  info(`get-asms status=${asmsRes.status} count=${asms.length}`);
  info(`get-rsms status=${asmsAlt.status} count=${asms2.length}`);

  if (asmsRes.status === 200 && asms.length === 2) pass('get-asms returns 2 ASMs');
  else {
    fail(`get-asms expected 2, got status=${asmsRes.status} count=${asms.length}`);
    ok = false;
  }

  const names = asms.map((u) => `${u.firstName} ${u.lastName}`);
  const allAsmRole = asms.every((u) => u.role === 'ASM');
  if (allAsmRole) pass('all subordinates have role=ASM (not RSM)');
  else {
    fail(`subordinate roles: ${asms.map((u) => u.role).join(',')}`);
    ok = false;
  }
  info(`ASM names: ${names.join(', ')}`);

  // 3) RMs under RSM via get-rms
  const rmsRes = await get('/asm/get-rms', tok);
  const rms = Array.isArray(rmsRes.data) ? rmsRes.data : (rmsRes.data?.data || []);
  info(`get-rms status=${rmsRes.status} count=${rms.length}`);
  if (rmsRes.status === 200 && rms.length >= 1) pass(`RSM get-rms returns RMs (count=${rms.length})`);
  else {
    fail(`RSM get-rms failed status=${rmsRes.status} count=${rms.length}`);
    ok = false;
  }

  // 4) Also check /rsm/dashboard for same RSM (fallback mount)
  const rsmDash = await get('/rsm/dashboard', tok);
  info(`/rsm/dashboard status=${rsmDash.status} totalASMs=${rsmDash.data?.totals?.totalASMs} totalRMs=${rsmDash.data?.totals?.totalRMs}`);
  if (rsmDash.status === 200 && Number(rsmDash.data?.totals?.totalASMs) === 2) {
    pass('/rsm/dashboard also returns totalASMs=2');
  } else if (rsmDash.status === 200) {
    fail(`/rsm/dashboard totalASMs expected 2, got ${rsmDash.data?.totals?.totalASMs}`);
    ok = false;
  } else {
    fail(`/rsm/dashboard status ${rsmDash.status}`);
    ok = false;
  }

  return ok;
}

async function testAsm() {
  console.log('\n========== ASM (Sandip Chaughule) ==========');
  const tok = token(USERS.asm);

  // Frontend /asm/dashboard uses RsmDashboard → /rsm/dashboard
  const dash = await get('/rsm/dashboard', tok);
  if (dash.status !== 200) {
    fail(`/rsm/dashboard returned ${dash.status}: ${JSON.stringify(dash.data)}`);
    return false;
  }

  const totals = dash.data.totals || {};
  info(`totalASMs=${totals.totalASMs}, totalRMs=${totals.totalRMs}, totalPartners=${totals.totalPartners}`);

  let ok = true;
  if (Number(totals.totalRMs) >= 1) pass(`ASM totalRMs >= 1 (got ${totals.totalRMs})`);
  else {
    fail(`ASM totalRMs expected >= 1, got ${totals.totalRMs}`);
    ok = false;
  }

  // ASM should NOT primarily be counting peer ASMs as subordinates for RM dashboard
  // (totalASMs under an ASM may be 0)
  info(`ASM totalASMs field=${totals.totalASMs} (expected 0 or undefined for line ASM)`);

  // my-rms endpoint
  const rmsRes = await get('/rsm/my-rms', tok);
  const rmsAlt = await get('/asm/get-rms', tok);
  const rms1 = Array.isArray(rmsRes.data) ? rmsRes.data : (rmsRes.data?.data || rmsRes.data?.rms || []);
  const rms2 = Array.isArray(rmsAlt.data) ? rmsAlt.data : (rmsAlt.data?.data || []);
  info(`my-rms status=${rmsRes.status} count=${Array.isArray(rms1) ? rms1.length : 'n/a'} keys=${Object.keys(rmsRes.data || {}).join(',')}`);
  info(`asm/get-rms status=${rmsAlt.status} count=${rms2.length}`);

  if (rmsAlt.status === 200 && rms2.length >= 1) {
    const allRm = rms2.every((u) => u.role === 'RM');
    if (allRm) pass(`ASM get-rms returns only RMs (count=${rms2.length})`);
    else {
      fail(`ASM get-rms has non-RM roles: ${rms2.map((u) => u.role).join(',')}`);
      ok = false;
    }
    info(`RM names: ${rms2.map((u) => `${u.firstName} ${u.lastName}`).join(', ')}`);
  } else {
    fail(`ASM get-rms status=${rmsAlt.status} count=${rms2.length}`);
    ok = false;
  }

  // ASM should NOT get ASMs as subordinates via get-asms (should be empty or unauthorized)
  const asmsRes = await get('/asm/get-asms', tok);
  const asms = Array.isArray(asmsRes.data) ? asmsRes.data : (asmsRes.data?.data || []);
  info(`ASM calling get-asms status=${asmsRes.status} count=${asms.length}`);
  if (asmsRes.status === 200 && asms.length === 0) {
    pass('ASM get-asms returns 0 (ASM does not manage ASMs)');
  } else if (asmsRes.status === 200 && asms.length > 0) {
    fail(`ASM get-asms returned ${asms.length} subordinates — ASM should manage RMs only`);
    ok = false;
  } else {
    info(`ASM get-asms status ${asmsRes.status} (acceptable if forbidden)`);
  }

  // Also /asm/dashboard for ASM user
  const asmDash = await get('/asm/dashboard', tok);
  info(`/asm/dashboard (for ASM user) status=${asmDash.status} totalASMs=${asmDash.data?.totals?.totalASMs} totalRMs=${asmDash.data?.totals?.totalRMs}`);
  if (asmDash.status === 200) {
    if (Number(asmDash.data?.totals?.totalRMs) >= 1) pass('/asm/dashboard for ASM returns RMs');
    else {
      fail(`/asm/dashboard for ASM totalRMs=${asmDash.data?.totals?.totalRMs}`);
      ok = false;
    }
    // Bug check: if ASM dashboard treats ASMs as subordinates incorrectly
    if (Number(asmDash.data?.totals?.totalASMs) > 0) {
      fail(`/asm/dashboard for ASM reports totalASMs=${asmDash.data.totals.totalASMs} — should be 0 (ASM manages RMs)`);
      ok = false;
    } else {
      pass('/asm/dashboard for ASM has totalASMs=0');
    }
  }

  return ok;
}

async function testHealth() {
  console.log('\n========== Health ==========');
  try {
    const res = await axios.get('http://localhost:5000/health');
    if (res.data?.status === 'ok') {
      pass('API server healthy on :5000');
      return true;
    }
    fail(`health unexpected: ${JSON.stringify(res.data)}`);
    return false;
  } catch (e) {
    fail(`API not reachable: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('HIERARCHY VERIFICATION — RSM → ASM → RM');
  const healthy = await testHealth();
  if (!healthy) process.exit(1);

  const rsmOk = await testRsm();
  const asmOk = await testAsm();

  console.log('\n========== SUMMARY ==========');
  console.log(`RSM tests: ${rsmOk ? 'PASS' : 'FAIL'}`);
  console.log(`ASM tests: ${asmOk ? 'PASS' : 'FAIL'}`);
  console.log(`Overall:   ${rsmOk && asmOk ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(rsmOk && asmOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
