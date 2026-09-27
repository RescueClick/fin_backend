import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";
import { ROLES } from "../src/config/roles.js";
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

async function simulateGetPartners(managerId) {
  const scope = await loadRsmReportingScope(managerId);
  const rms = await User.find({ role: ROLES.RM, ...scope })
    .select("_id firstName lastName employeeId")
    .lean();
  const rmIds = rms.map((rm) => rm._id);
  const rmMap = Object.fromEntries(rms.map((rm) => [String(rm._id), rm]));

  const rsmOid = toObjectId(managerId);
  const userBase = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
  const query = {
    role: ROLES.PARTNER,
    $or: [
      ...(rmIds.length ? [{ rmId: { $in: rmIds } }] : []),
      { asmId: rsmOid },
      { rsmId: rsmOid },
    ],
    ...userBase,
  };

  const partners = await User.find(query).select("firstName lastName employeeId status rmId asmId rsmId").lean();

  let withName = 0;
  let withoutName = 0;
  const missingSamples = [];
  const rmIdOutsideScope = [];

  for (const partner of partners) {
    const rm = rmMap[String(partner.rmId)] || null;
    if (rm) withName++;
    else {
      withoutName++;
      if (missingSamples.length < 10) {
        const linked = partner.rmId
          ? await User.findById(partner.rmId).select("firstName lastName role status").lean()
          : null;
        missingSamples.push({
          partner: `${partner.firstName} ${partner.lastName}`,
          employeeId: partner.employeeId,
          status: partner.status,
          rmId: partner.rmId,
          linked: linked
            ? `${linked.firstName} ${linked.lastName} (${linked.role}/${linked.status})`
            : null,
          matchedViaAsmId: partner.asmId && String(partner.asmId) === String(managerId),
          matchedViaRsmId: partner.rsmId && String(partner.rsmId) === String(managerId),
        });
      }
      if (partner.rmId && !rmMap[String(partner.rmId)]) {
        rmIdOutsideScope.push(String(partner.rmId));
      }
    }
  }

  return {
    managerId: String(managerId),
    rmsInScope: rms.length,
    partnersListed: partners.length,
    withRmName: withName,
    withoutRmName: withoutName,
    uniqueOutsideRmIds: [...new Set(rmIdOutsideScope)].length,
    missingSamples,
  };
}

async function main() {
  await connectDB(process.env.MONGO_URI);

  const managers = await User.find({
    role: { $in: [ROLES.ASM, ROLES.RSM] },
    status: "ACTIVE",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .select("_id firstName lastName role employeeId asmType rsmType")
    .lean();

  const results = [];
  for (const m of managers) {
    const sim = await simulateGetPartners(m._id);
    results.push({
      name: `${m.firstName} ${m.lastName}`,
      role: m.role,
      type: m.asmType || m.rsmType,
      employeeId: m.employeeId,
      ...sim,
    });
  }

  results.sort((a, b) => b.withoutRmName - a.withoutRmName);
  console.log(
    JSON.stringify(
      {
        managersChecked: results.length,
        worst: results.slice(0, 8).map((r) => ({
          name: r.name,
          role: r.role,
          type: r.type,
          partnersListed: r.partnersListed,
          withRmName: r.withRmName,
          withoutRmName: r.withoutRmName,
          rmsInScope: r.rmsInScope,
          missingSamples: r.missingSamples,
        })),
        totals: {
          partnersListedSum: results.reduce((s, r) => s + r.partnersListed, 0),
          withoutRmNameSum: results.reduce((s, r) => s + r.withoutRmName, 0),
        },
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
