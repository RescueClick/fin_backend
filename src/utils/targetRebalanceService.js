import { User } from "../models/User.js";
import { Target } from "../models/Target.js";
import { Config } from "../models/Config.js";
import { ROLES } from "../config/roles.js";

const num = (v) => Number(v || 0);

export async function deriveCurrentTargetContext(month, year) {
  const [asmTargets, partnerTargets, policy] = await Promise.all([
    Target.find({ role: ROLES.ASM, month, year }).lean(),
    Target.find({ role: ROLES.PARTNER, month, year }).lean(),
    Config.findOne({ key: "PARTNER_TARGET_POLICY" }).lean(),
  ]);

  const totalCompanyTarget = asmTargets.reduce(
    (sum, t) => sum + num(t.disbursementTarget || t.targetValue),
    0
  );

  let partnerFileCountTarget = num(policy?.value?.fileCountTarget || 4);
  if (partnerTargets.length > 0) {
    const avg =
      partnerTargets.reduce((sum, t) => sum + num(t.fileCountTarget), 0) /
      partnerTargets.length;
    partnerFileCountTarget = Math.max(1, Math.round(avg));
  }

  const assignedBy = asmTargets[0]?.assignedBy || null;
  return { totalCompanyTarget, partnerFileCountTarget, assignedBy };
}

export async function rebalanceHierarchyTargetsReplace({
  month,
  year,
  totalCompanyTarget,
  partnerFileCountTarget,
  assignedBy,
}) {
  const targetMonth = Number(month);
  const targetYear = Number(year);
  const totalTarget = num(totalCompanyTarget);
  const fileCountTarget = Math.max(1, num(partnerFileCountTarget));

  if (!targetMonth || !targetYear || targetMonth < 1 || targetMonth > 12) {
    return { assignments: [], distributionSummary: null };
  }
  if (totalTarget <= 0) {
    return { assignments: [], distributionSummary: null };
  }

  const asms = await User.find({ role: ROLES.ASM }).lean();
  if (!asms.length) return { assignments: [], distributionSummary: null };

  const assignments = [];
  const distributionSummary = {
    totalCompanyTarget: totalTarget,
    asmCount: asms.length,
    rsmCount: 0,
    rmCount: 0,
    partnerCount: 0,
  };

  const asmTarget = Math.round(totalTarget / asms.length);

  for (const asm of asms) {
    const rsms = await User.find({ role: ROLES.RSM, asmId: asm._id }).lean();

    if (!rsms.length) {
      let asmTargetDoc = await Target.findOne({
        assignedTo: asm._id,
        role: ROLES.ASM,
        month: targetMonth,
        year: targetYear,
      });
      if (asmTargetDoc) {
        asmTargetDoc.disbursementTarget = asmTarget;
        asmTargetDoc.targetValue = asmTarget;
        asmTargetDoc.fileCountTarget = 0;
        asmTargetDoc.assignedBy = assignedBy;
        asmTargetDoc.isCalculated = true;
        await asmTargetDoc.save();
      } else {
        asmTargetDoc = await Target.create({
          assignedBy,
          assignedTo: asm._id,
          role: ROLES.ASM,
          month: targetMonth,
          year: targetYear,
          fileCountTarget: 0,
          disbursementTarget: asmTarget,
          targetValue: asmTarget,
          isCalculated: true,
        });
      }
      assignments.push(asmTargetDoc);
      continue;
    }

    const rsmTarget = Math.round(asmTarget / rsms.length);
    distributionSummary.rsmCount += rsms.length;

    for (const rsm of rsms) {
      const rms = await User.find({
        role: ROLES.RM,
        $or: [{ personalRsmId: rsm._id }, { businessHomeRsmId: rsm._id }],
      }).lean();
      const uniqueRms = rms.filter(
        (rm, idx, self) =>
          idx === self.findIndex((x) => String(x._id) === String(rm._id))
      );

      if (!uniqueRms.length) {
        let rsmTargetDoc = await Target.findOne({
          assignedTo: rsm._id,
          role: ROLES.RSM,
          month: targetMonth,
          year: targetYear,
        });
        if (rsmTargetDoc) {
          rsmTargetDoc.disbursementTarget = rsmTarget;
          rsmTargetDoc.targetValue = rsmTarget;
          rsmTargetDoc.fileCountTarget = 0;
          rsmTargetDoc.assignedBy = assignedBy;
          rsmTargetDoc.isCalculated = true;
          await rsmTargetDoc.save();
        } else {
          rsmTargetDoc = await Target.create({
            assignedBy,
            assignedTo: rsm._id,
            role: ROLES.RSM,
            month: targetMonth,
            year: targetYear,
            fileCountTarget: 0,
            disbursementTarget: rsmTarget,
            targetValue: rsmTarget,
            isCalculated: true,
          });
        }
        assignments.push(rsmTargetDoc);
        continue;
      }

      const rmTarget = Math.round(rsmTarget / uniqueRms.length);
      distributionSummary.rmCount += uniqueRms.length;

      for (const rm of uniqueRms) {
        const partners = await User.find({
          role: ROLES.PARTNER,
          rmId: rm._id,
        }).lean();

        if (!partners.length) {
          let rmTargetDoc = await Target.findOne({
            assignedTo: rm._id,
            role: ROLES.RM,
            month: targetMonth,
            year: targetYear,
          });
          if (rmTargetDoc) {
            rmTargetDoc.disbursementTarget = rmTarget;
            rmTargetDoc.targetValue = rmTarget;
            rmTargetDoc.fileCountTarget = 0;
            rmTargetDoc.assignedBy = assignedBy;
            rmTargetDoc.isCalculated = true;
            await rmTargetDoc.save();
          } else {
            rmTargetDoc = await Target.create({
              assignedBy,
              assignedTo: rm._id,
              role: ROLES.RM,
              month: targetMonth,
              year: targetYear,
              fileCountTarget: 0,
              disbursementTarget: rmTarget,
              targetValue: rmTarget,
              isCalculated: true,
            });
          }
          assignments.push(rmTargetDoc);
          continue;
        }

        const partnerDisbursementTarget = Math.round(rmTarget / partners.length);
        distributionSummary.partnerCount += partners.length;

        for (const partner of partners) {
          let partnerTarget = await Target.findOne({
            assignedTo: partner._id,
            role: ROLES.PARTNER,
            month: targetMonth,
            year: targetYear,
          });
          if (partnerTarget) {
            partnerTarget.fileCountTarget = fileCountTarget;
            partnerTarget.disbursementTarget = partnerDisbursementTarget;
            partnerTarget.targetValue = partnerDisbursementTarget;
            partnerTarget.assignedBy = assignedBy;
            partnerTarget.isCalculated = false;
            await partnerTarget.save();
          } else {
            partnerTarget = await Target.create({
              assignedBy,
              assignedTo: partner._id,
              role: ROLES.PARTNER,
              month: targetMonth,
              year: targetYear,
              fileCountTarget,
              disbursementTarget: partnerDisbursementTarget,
              targetValue: partnerDisbursementTarget,
              isCalculated: false,
            });
          }
          assignments.push(partnerTarget);
        }

        const rmActualTarget = partnerDisbursementTarget * partners.length;
        let rmTargetDoc = await Target.findOne({
          assignedTo: rm._id,
          role: ROLES.RM,
          month: targetMonth,
          year: targetYear,
        });
        if (rmTargetDoc) {
          rmTargetDoc.disbursementTarget = rmActualTarget;
          rmTargetDoc.targetValue = rmActualTarget;
          rmTargetDoc.fileCountTarget = 0;
          rmTargetDoc.assignedBy = assignedBy;
          rmTargetDoc.isCalculated = true;
          await rmTargetDoc.save();
        } else {
          rmTargetDoc = await Target.create({
            assignedBy,
            assignedTo: rm._id,
            role: ROLES.RM,
            month: targetMonth,
            year: targetYear,
            fileCountTarget: 0,
            disbursementTarget: rmActualTarget,
            targetValue: rmActualTarget,
            isCalculated: true,
          });
        }
        assignments.push(rmTargetDoc);
      }

      const rsmActualTarget = rmTarget * uniqueRms.length;
      let rsmTargetDoc = await Target.findOne({
        assignedTo: rsm._id,
        role: ROLES.RSM,
        month: targetMonth,
        year: targetYear,
      });
      if (rsmTargetDoc) {
        rsmTargetDoc.disbursementTarget = rsmActualTarget;
        rsmTargetDoc.targetValue = rsmActualTarget;
        rsmTargetDoc.fileCountTarget = 0;
        rsmTargetDoc.assignedBy = assignedBy;
        rsmTargetDoc.isCalculated = true;
        await rsmTargetDoc.save();
      } else {
        rsmTargetDoc = await Target.create({
          assignedBy,
          assignedTo: rsm._id,
          role: ROLES.RSM,
          month: targetMonth,
          year: targetYear,
          fileCountTarget: 0,
          disbursementTarget: rsmActualTarget,
          targetValue: rsmActualTarget,
          isCalculated: true,
        });
      }
      assignments.push(rsmTargetDoc);
    }

    const asmActualTarget = rsmTarget * rsms.length;
    let asmTargetDoc = await Target.findOne({
      assignedTo: asm._id,
      role: ROLES.ASM,
      month: targetMonth,
      year: targetYear,
    });
    if (asmTargetDoc) {
      asmTargetDoc.disbursementTarget = asmActualTarget;
      asmTargetDoc.targetValue = asmActualTarget;
      asmTargetDoc.fileCountTarget = 0;
      asmTargetDoc.assignedBy = assignedBy;
      asmTargetDoc.isCalculated = true;
      await asmTargetDoc.save();
    } else {
      asmTargetDoc = await Target.create({
        assignedBy,
        assignedTo: asm._id,
        role: ROLES.ASM,
        month: targetMonth,
        year: targetYear,
        fileCountTarget: 0,
        disbursementTarget: asmActualTarget,
        targetValue: asmActualTarget,
        isCalculated: true,
      });
    }
    assignments.push(asmTargetDoc);
  }

  return { assignments, distributionSummary };
}

export async function rebalanceHierarchyTargetsAdd({
  month,
  year,
  totalCompanyTarget,
  partnerFileCountTarget,
  assignedBy,
}) {
  const targetMonth = Number(month);
  const targetYear = Number(year);
  const totalTarget = num(totalCompanyTarget);
  const fileCountTarget = Math.max(1, num(partnerFileCountTarget));

  if (!targetMonth || !targetYear || targetMonth < 1 || targetMonth > 12) {
    return { assignments: [], distributionSummary: null };
  }
  if (totalTarget <= 0) {
    return { assignments: [], distributionSummary: null };
  }

  const asms = await User.find({ role: ROLES.ASM }).lean();
  if (!asms.length) return { assignments: [], distributionSummary: null };

  const assignments = [];
  const distributionSummary = {
    totalCompanyTarget: totalTarget,
    asmCount: asms.length,
    rsmCount: 0,
    rmCount: 0,
    partnerCount: 0,
  };

  const asmTarget = Math.round(totalTarget / asms.length);

  for (const asm of asms) {
    const rsms = await User.find({ role: ROLES.RSM, asmId: asm._id }).lean();

    let asmTargetDoc = await Target.findOne({ assignedTo: asm._id, role: ROLES.ASM, month: targetMonth, year: targetYear });
    if (asmTargetDoc) {
      asmTargetDoc.disbursementTarget = (num(asmTargetDoc.disbursementTarget) + asmTarget);
      asmTargetDoc.targetValue = (num(asmTargetDoc.targetValue) + asmTarget);
      asmTargetDoc.assignedBy = assignedBy;
      asmTargetDoc.isCalculated = true;
      await asmTargetDoc.save();
    } else {
      asmTargetDoc = await Target.create({
        assignedBy, assignedTo: asm._id, role: ROLES.ASM, month: targetMonth, year: targetYear,
        fileCountTarget: 0, disbursementTarget: asmTarget, targetValue: asmTarget, isCalculated: true,
      });
    }
    assignments.push(asmTargetDoc);

    if (!rsms.length) continue;

    const rsmTarget = Math.round(asmTarget / rsms.length);
    distributionSummary.rsmCount += rsms.length;

    for (const rsm of rsms) {
      const rms = await User.find({ role: ROLES.RM, $or: [{ personalRsmId: rsm._id }, { businessHomeRsmId: rsm._id }] }).lean();
      const uniqueRms = rms.filter((rm, idx, self) => idx === self.findIndex((x) => String(x._id) === String(rm._id)));

      let rsmTargetDoc = await Target.findOne({ assignedTo: rsm._id, role: ROLES.RSM, month: targetMonth, year: targetYear });
      if (rsmTargetDoc) {
        rsmTargetDoc.disbursementTarget = (num(rsmTargetDoc.disbursementTarget) + rsmTarget);
        rsmTargetDoc.targetValue = (num(rsmTargetDoc.targetValue) + rsmTarget);
        rsmTargetDoc.assignedBy = assignedBy;
        rsmTargetDoc.isCalculated = true;
        await rsmTargetDoc.save();
      } else {
        rsmTargetDoc = await Target.create({
          assignedBy, assignedTo: rsm._id, role: ROLES.RSM, month: targetMonth, year: targetYear,
          fileCountTarget: 0, disbursementTarget: rsmTarget, targetValue: rsmTarget, isCalculated: true,
        });
      }
      assignments.push(rsmTargetDoc);

      if (!uniqueRms.length) continue;

      const rmTarget = Math.round(rsmTarget / uniqueRms.length);
      distributionSummary.rmCount += uniqueRms.length;

      for (const rm of uniqueRms) {
        const partners = await User.find({ role: ROLES.PARTNER, rmId: rm._id }).lean();

        let rmTargetDoc = await Target.findOne({ assignedTo: rm._id, role: ROLES.RM, month: targetMonth, year: targetYear });
        if (rmTargetDoc) {
          rmTargetDoc.disbursementTarget = (num(rmTargetDoc.disbursementTarget) + rmTarget);
          rmTargetDoc.targetValue = (num(rmTargetDoc.targetValue) + rmTarget);
          rmTargetDoc.assignedBy = assignedBy;
          rmTargetDoc.isCalculated = true;
          await rmTargetDoc.save();
        } else {
          rmTargetDoc = await Target.create({
            assignedBy, assignedTo: rm._id, role: ROLES.RM, month: targetMonth, year: targetYear,
            fileCountTarget: 0, disbursementTarget: rmTarget, targetValue: rmTarget, isCalculated: true,
          });
        }
        assignments.push(rmTargetDoc);

        if (!partners.length) continue;

        const partnerDisbursementTarget = Math.round(rmTarget / partners.length);
        distributionSummary.partnerCount += partners.length;

        for (const partner of partners) {
          let partnerTarget = await Target.findOne({ assignedTo: partner._id, role: ROLES.PARTNER, month: targetMonth, year: targetYear });
          if (partnerTarget) {
            partnerTarget.fileCountTarget = fileCountTarget > 0 ? (num(partnerTarget.fileCountTarget) + fileCountTarget) : partnerTarget.fileCountTarget;
            partnerTarget.disbursementTarget = (num(partnerTarget.disbursementTarget) + partnerDisbursementTarget);
            partnerTarget.targetValue = (num(partnerTarget.targetValue) + partnerDisbursementTarget);
            partnerTarget.assignedBy = assignedBy;
            partnerTarget.isCalculated = false;
            await partnerTarget.save();
          } else {
            partnerTarget = await Target.create({
              assignedBy, assignedTo: partner._id, role: ROLES.PARTNER, month: targetMonth, year: targetYear,
              fileCountTarget, disbursementTarget: partnerDisbursementTarget, targetValue: partnerDisbursementTarget, isCalculated: false,
            });
          }
          assignments.push(partnerTarget);
        }
      }
    }
  }

  return { assignments, distributionSummary };
}
