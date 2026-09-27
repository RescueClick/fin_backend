/**
 * Smoke-test ASM + RSM read endpoints (no status mutations).
 * Usage: node scratch/smoke_asm_rsm.cjs [baseUrl]
 */
const path = require("path");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const BASE = (process.argv[2] || process.env.SMOKE_API_URL || "http://localhost:5000").replace(/\/$/, "");
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET");
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error("Missing MONGO_URI");
  process.exit(1);
}

function tokenFor(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, email: user.email || "" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function hit(label, method, urlPath, token, body) {
  const url = `${BASE}${urlPath}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, 200);
    }
    const ms = Date.now() - started;
    const ok = res.status >= 200 && res.status < 300;
    const msg =
      (data && typeof data === "object" && (data.message || data.error)) ||
      (typeof data === "string" ? data : "");
    console.log(
      `${ok ? "PASS" : "FAIL"} [${res.status}] ${ms}ms  ${label}` +
        (ok ? "" : `  → ${String(msg).slice(0, 160)}`)
    );
    return { ok, status: res.status, data, label };
  } catch (err) {
    console.log(`FAIL [NET] ${label}  → ${err.message}`);
    return { ok: false, status: 0, data: null, label, error: err.message };
  }
}

async function pickUsers(db) {
  const users = db.collection("users");
  const asm = await users.findOne({
    role: "ASM",
    status: "ACTIVE",
  });
  const rsm = await users.findOne({
    role: "RSM",
    status: "ACTIVE",
  });
  return { asm, rsm };
}

async function findAppForManager(db, manager) {
  const apps = db.collection("applications");
  const filter =
    manager.role === "ASM"
      ? {
          $or: [{ asmId: manager._id }, { rsmId: manager._id }],
          deletedAt: null,
          status: { $nin: ["DISBURSED"] },
        }
      : {
          rsmId: manager._id,
          deletedAt: null,
          status: { $nin: ["DISBURSED"] },
        };
  return apps.findOne(filter, { projection: { _id: 1, appNo: 1, status: 1, asmId: 1, rsmId: 1 } });
}

async function runFor(roleLabel, user, db) {
  if (!user) {
    console.log(`\nSKIP ${roleLabel}: no ACTIVE user found`);
    return [];
  }
  const token = tokenFor(user);
  const prefix = roleLabel === "ASM" ? "/api/asm" : "/api/rsm";
  console.log(
    `\n=== ${roleLabel}: ${user.firstName || ""} ${user.lastName || ""} (${user._id}) type=${user.asmType || user.rsmType || "?"} ===`
  );

  const results = [];
  results.push(await hit("profile", "GET", `${prefix}/profile`, token));
  results.push(await hit("dashboard", "GET", `${prefix}/dashboard`, token));
  results.push(
    await hit(
      "applications",
      "GET",
      roleLabel === "ASM" ? `${prefix}/get-customers` : `${prefix}/applications`,
      token
    )
  );
  results.push(await hit("my-rms", "GET", roleLabel === "ASM" ? `${prefix}/get-rm` : `${prefix}/my-rms`, token));
  results.push(await hit("partners", "GET", `${prefix}/get-partners`, token));
  results.push(await hit("rms follow-ups", "GET", `${prefix}/rms/follow-ups`, token));
  results.push(await hit("leads hierarchy", "GET", `/api/leads/hierarchy`, token));

  if (roleLabel === "ASM") {
    results.push(await hit("get-rsms/asms", "GET", `${prefix}/get-rsms`, token));
  } else {
    results.push(await hit("my-asms", "GET", `${prefix}/my-asms`, token));
  }

  // Application detail / routing access
  const app = await findAppForManager(db, user);
  if (app) {
    console.log(`  using app ${app.appNo || app._id} status=${app.status}`);
    results.push(
      await hit(
        "application detail",
        "GET",
        `/api/rsm/applications/${app._id}`,
        token
      )
    );
    results.push(
      await hit(
        "transition same-status",
        "POST",
        `${prefix}/applications/${app._id}/transition`,
        token,
        { to: app.status, note: "smoke: no-op routing check" }
      )
    );
  } else {
    console.log("  no in-scope application for detail smoke");
  }

  return results;
}

async function main() {
  console.log(`Smoke ASM/RSM against ${BASE}`);
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const { asm, rsm } = await pickUsers(db);

  const all = [];
  all.push(...(await runFor("ASM", asm, db)));
  all.push(...(await runFor("RSM", rsm, db)));

  await mongoose.disconnect();

  const failed = all.filter((r) => !r.ok);
  console.log(`\n==== SUMMARY: ${all.length - failed.length}/${all.length} passed ====`);
  if (failed.length) {
    failed.forEach((f) => console.log(` - ${f.label}: ${f.status} ${f.error || ""}`));
    process.exit(1);
  }
  console.log("ASM and RSM smoke tests OK — no errors.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
