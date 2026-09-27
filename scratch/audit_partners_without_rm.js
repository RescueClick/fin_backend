import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { ROLES } from "../src/config/roles.js";

async function main() {
  await connectDB(process.env.MONGO_URI);

  const partners = await User.find({
    role: ROLES.PARTNER,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .select("_id firstName lastName employeeId status rmId asmId rsmId")
    .lean();

  const rmIds = [
    ...new Set(
      partners
        .map((p) => (p.rmId ? String(p.rmId) : null))
        .filter(Boolean)
    ),
  ];

  const linkedUsers = await User.find({ _id: { $in: rmIds } })
    .select("_id firstName lastName role status employeeId")
    .lean();
  const byId = Object.fromEntries(linkedUsers.map((u) => [String(u._id), u]));

  const buckets = {
    total: partners.length,
    noRmId: [],
    rmIsSuperAdmin: [],
    rmNotFound: [],
    rmWrongRole: [],
    rmInactive: [],
    validActiveRm: [],
  };

  for (const p of partners) {
    if (!p.rmId) {
      buckets.noRmId.push(p);
      continue;
    }
    const u = byId[String(p.rmId)];
    if (!u) {
      buckets.rmNotFound.push(p);
      continue;
    }
    if (u.role === ROLES.SUPER_ADMIN || u.role === ROLES.ADMIN) {
      buckets.rmIsSuperAdmin.push({ ...p, linkedRole: u.role, linkedName: `${u.firstName} ${u.lastName}` });
      continue;
    }
    if (u.role !== ROLES.RM) {
      buckets.rmWrongRole.push({ ...p, linkedRole: u.role, linkedName: `${u.firstName} ${u.lastName}` });
      continue;
    }
    if (u.status !== "ACTIVE") {
      buckets.rmInactive.push({ ...p, rmName: `${u.firstName} ${u.lastName}`, rmStatus: u.status });
      continue;
    }
    buckets.validActiveRm.push(p);
  }

  console.log(
    JSON.stringify(
      {
        total: buckets.total,
        validActiveRm: buckets.validActiveRm.length,
        noRmId: buckets.noRmId.length,
        rmIsSuperAdmin: buckets.rmIsSuperAdmin.length,
        rmNotFound: buckets.rmNotFound.length,
        rmWrongRole: buckets.rmWrongRole.length,
        rmInactive: buckets.rmInactive.length,
        sampleNoRmId: buckets.noRmId.slice(0, 5).map(brief),
        sampleSuperAdmin: buckets.rmIsSuperAdmin.slice(0, 8).map(brief),
        sampleWrongRole: buckets.rmWrongRole.slice(0, 5).map(brief),
        sampleNotFound: buckets.rmNotFound.slice(0, 5).map(brief),
        sampleInactive: buckets.rmInactive.slice(0, 5).map(brief),
        byStatusMissingRm: summarizeStatus([
          ...buckets.noRmId,
          ...buckets.rmIsSuperAdmin,
          ...buckets.rmNotFound,
          ...buckets.rmWrongRole,
          ...buckets.rmInactive,
        ]),
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

function brief(p) {
  return {
    name: `${p.firstName || ""} ${p.lastName || ""}`.trim(),
    employeeId: p.employeeId,
    status: p.status,
    rmId: p.rmId,
    linkedRole: p.linkedRole,
    linkedName: p.linkedName || p.rmName,
  };
}

function summarizeStatus(list) {
  const out = {};
  for (const p of list) {
    const s = p.status || "NO_STATUS";
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
