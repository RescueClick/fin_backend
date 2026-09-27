import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { ROLES } from "../src/config/roles.js";
import { activeUsersFilter } from "../src/utils/activeUsersFilter.js";
import { rmReportingLineMatch, normalizeRsmTypeValue } from "../src/utils/rmRsmHierarchy.js";

function toObjectId(id) {
  return new mongoose.Types.ObjectId(String(id));
}

async function loadRsmReportingScope(rsmId) {
  const rsm = await User.findById(rsmId).select("role rsmType asmType").lean();
  if (rsm?.role === ROLES.RSM) {
    return { $or: [{ rsmId: toObjectId(rsmId) }, { asmId: toObjectId(rsmId) }] };
  }
  return rmReportingLineMatch(rsmId, normalizeRsmTypeValue(rsm?.rsmType || rsm?.asmType));
}

/** Fixed logic mirroring /rsm/get-partners */
async function simulateFixed(managerId) {
  const scope = await loadRsmReportingScope(managerId);
  const rms = await User.find(
    activeUsersFilter({
      role: ROLES.RM,
      ...scope,
    })
  )
    .select("_id firstName lastName employeeId")
    .lean();
  const rmIds = rms.map((rm) => rm._id);
  const rmMap = Object.fromEntries(rms.map((rm) => [String(rm._id), rm]));

  const rsmOid = toObjectId(managerId);
  const scopeOr = [
    ...(rmIds.length ? [{ rmId: { $in: rmIds } }] : []),
    { asmId: rsmOid },
    { rsmId: rsmOid },
  ];
  if (!scopeOr.length) {
    return { partnersListed: 0, withRmName: 0, withoutRmName: 0, rmsInScope: 0 };
  }

  const partners = await User.find(
    activeUsersFilter({
      role: ROLES.PARTNER,
      $or: scopeOr,
    })
  )
    .select("firstName lastName employeeId status rmId")
    .lean();

  const missingRmIds = [
    ...new Set(
      partners
        .map((p) => (p.rmId ? String(p.rmId) : null))
        .filter((id) => id && !rmMap[id])
    ),
  ];
  if (missingRmIds.length) {
    const extraRms = await User.find({
      _id: { $in: missingRmIds },
      role: ROLES.RM,
    })
      .select("_id firstName lastName employeeId")
      .lean();
    for (const rm of extraRms) rmMap[String(rm._id)] = rm;
  }

  let withName = 0;
  let withoutName = 0;
  for (const partner of partners) {
    const rm = partner.rmId ? rmMap[String(partner.rmId)] || null : null;
    if (rm) withName++;
    else withoutName++;
  }

  return {
    partnersListed: partners.length,
    withRmName: withName,
    withoutRmName: withoutName,
    rmsInScope: rms.length,
  };
}

async function main() {
  await connectDB(process.env.MONGO_URI);
  const managers = await User.find({
    role: { $in: [ROLES.ASM, ROLES.RSM] },
    status: "ACTIVE",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .select("_id firstName lastName role employeeId")
    .lean();

  const results = [];
  for (const m of managers) {
    const sim = await simulateFixed(m._id);
    results.push({
      name: `${m.firstName} ${m.lastName}`,
      role: m.role,
      ...sim,
    });
  }
  results.sort((a, b) => b.withoutRmName - a.withoutRmName);
  console.log(JSON.stringify({ results, totalWithout: results.reduce((s, r) => s + r.withoutRmName, 0) }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
