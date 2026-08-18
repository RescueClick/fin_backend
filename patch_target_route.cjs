const fs = require('fs');
const path = require('path');

const adminRoutesPath = path.join(__dirname, 'src/routes/admin.routes.js');
const targetServicePath = path.join(__dirname, 'src/utils/targetRebalanceService.js');

// 1. Update targetRebalanceService.js
let targetService = fs.readFileSync(targetServicePath, 'utf8');
if (!targetService.includes('export async function rebalanceHierarchyTargetsAdd')) {
    const addFunctionCode = `
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
`;
    fs.appendFileSync(targetServicePath, addFunctionCode);
    console.log('Appended rebalanceHierarchyTargetsAdd to targetRebalanceService.js');
}

// 2. Update admin.routes.js
let adminRoutes = fs.readFileSync(adminRoutesPath, 'utf8');

// Fix the import to include rebalanceHierarchyTargetsAdd
if (!adminRoutes.includes('rebalanceHierarchyTargetsAdd')) {
    adminRoutes = adminRoutes.replace(
        /rebalanceHierarchyTargetsReplace,?\s*} from "\.\.\/utils\/targetRebalanceService\.js";/,
        'rebalanceHierarchyTargetsReplace,\n  rebalanceHierarchyTargetsAdd,\n} from "../utils/targetRebalanceService.js";'
    );
}

// Add the new endpoint
if (!adminRoutes.includes('/target/distribute-hierarchical')) {
    const routeCode = `
// POST /api/admin/target/distribute-hierarchical
// Top-Down target distribution replacing or adding to existing targets
router.post("/target/distribute-hierarchical", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const { month, year, totalCompanyTarget, partnerFileCountTarget, assignmentMode } = req.body;
    const assignerId = req.user.sub;

    if (!month || !year || !totalCompanyTarget) {
      return res.status(400).json({ message: "Month, year, and totalCompanyTarget are required" });
    }

    let distributionResult;

    if (assignmentMode === "add") {
      distributionResult = await rebalanceHierarchyTargetsAdd({
        month,
        year,
        totalCompanyTarget,
        partnerFileCountTarget: partnerFileCountTarget || 0,
        assignedBy: assignerId,
      });
    } else {
      distributionResult = await rebalanceHierarchyTargetsReplace({
        month,
        year,
        totalCompanyTarget,
        partnerFileCountTarget: partnerFileCountTarget || 0,
        assignedBy: assignerId,
      });
    }

    return res.status(200).json({
      message: \`Targets successfully \${assignmentMode === 'add' ? 'added' : 'distributed'}\`,
      totalAssignments: distributionResult.assignments.length,
      distributionSummary: distributionResult.distributionSummary,
    });
  } catch (error) {
    console.error("Error distributing targets:", error);
    return res.status(500).json({ message: "Failed to distribute hierarchical targets" });
  }
});

`;
    // Insert before export default router;
    adminRoutes = adminRoutes.replace('export default router;', routeCode + 'export default router;');
    fs.writeFileSync(adminRoutesPath, adminRoutes, 'utf8');
    console.log('Added /target/distribute-hierarchical to admin.routes.js');
}

console.log('Patch complete.');
