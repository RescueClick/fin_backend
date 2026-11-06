import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config({ path: "./.env" });

async function run() {
  console.log("Connecting to MongoDB Atlas...");
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected successfully.");

  const db = mongoose.connection.db;

  // 1. Fetch Users
  const allUsers = await db.collection("users").find().toArray();
  console.log(`Fetched ${allUsers.length} total users.`);

  const userMap = new Map();
  allUsers.forEach(u => userMap.set(String(u._id), u));

  const partners = allUsers.filter(u => (u.role || "").toUpperCase() === "PARTNER");
  const rms = allUsers.filter(u => (u.role || "").toUpperCase() === "RM");
  const rsms = allUsers.filter(u => (u.role || "").toUpperCase() === "RSM");
  const asms = allUsers.filter(u => (u.role || "").toUpperCase() === "ASM");

  console.log(`Counts: RSMs=${rsms.length}, ASMs=${asms.length}, RMs=${rms.length}, Partners=${partners.length}`);

  // Map RM to RSM
  const rmToRsmMap = new Map();
  for (const rm of rms) {
    let rsmObj = null;
    if (rm.rsmId && userMap.has(String(rm.rsmId))) {
      rsmObj = userMap.get(String(rm.rsmId));
    } else if (rm.personalRsmId && userMap.has(String(rm.personalRsmId))) {
      rsmObj = userMap.get(String(rm.personalRsmId));
    } else if (rm.businessHomeRsmId && userMap.has(String(rm.businessHomeRsmId))) {
      rsmObj = userMap.get(String(rm.businessHomeRsmId));
    } else if (rm.businessRsmId && userMap.has(String(rm.businessRsmId))) {
      rsmObj = userMap.get(String(rm.businessRsmId));
    } else if (rm.homeLapRsmId && userMap.has(String(rm.homeLapRsmId))) {
      rsmObj = userMap.get(String(rm.homeLapRsmId));
    } else if (rm.asmId && userMap.has(String(rm.asmId))) {
      const asm = userMap.get(String(rm.asmId));
      if (asm && asm.rsmId && userMap.has(String(asm.rsmId))) {
        rsmObj = userMap.get(String(asm.rsmId));
      }
    }
    if (rsmObj) {
      rmToRsmMap.set(String(rm._id), rsmObj);
    }
  }

  // 2. Fetch Applications
  const applications = await db.collection("applications").find().toArray();
  console.log(`Fetched ${applications.length} applications.`);

  // Group applications by partnerId
  const appsByPartner = new Map();
  for (const app of applications) {
    if (!app.partnerId) continue;
    const pid = String(app.partnerId);
    if (!appsByPartner.has(pid)) {
      appsByPartner.set(pid, []);
    }
    appsByPartner.get(pid).push(app);
  }

  // 3. Fetch Latest Follow-Ups for Partners
  console.log("Fetching latest follow-ups...");
  const latestFollowUps = await db.collection("followups").aggregate([
    { $match: { followUpType: "PARTNER" } },
    { $sort: { lastCall: -1, updatedAt: -1, createdAt: -1 } },
    {
      $group: {
        _id: { $ifNull: ["$partnerId", "$targetId"] },
        latestStatus: { $first: "$status" },
        latestRemarks: { $first: "$remarks" },
        latestLastCall: { $first: "$lastCall" },
      }
    }
  ]).toArray();

  const followUpMap = new Map();
  for (const f of latestFollowUps) {
    if (f._id) {
      followUpMap.set(String(f._id), f);
    }
  }
  console.log(`Mapped ${followUpMap.size} partner follow-ups.`);

  // 4. Build Working Partners Data
  const workingPartnersList = [];

  for (const [pid, appList] of appsByPartner.entries()) {
    const partner = userMap.get(pid);
    if (!partner) continue;

    // Resolve RM
    let rmObj = partner.rmId && userMap.has(String(partner.rmId)) ? userMap.get(String(partner.rmId)) : null;

    // Resolve RSM
    let rsmObj = null;
    if (rmObj) {
      rsmObj = rmToRsmMap.get(String(rmObj._id)) || null;
    }
    if (!rsmObj && partner.rsmId && userMap.has(String(partner.rsmId))) {
      rsmObj = userMap.get(String(partner.rsmId));
    }
    // Fallback: check app's rsmId or rmId
    if (!rsmObj) {
      for (const app of appList) {
        if (app.rsmId && userMap.has(String(app.rsmId))) {
          rsmObj = userMap.get(String(app.rsmId));
          break;
        }
        if (app.rmId && rmToRsmMap.has(String(app.rmId))) {
          rsmObj = rmToRsmMap.get(String(app.rmId));
          break;
        }
      }
    }

    // App statistics
    let totalApps = appList.length;
    let completedApps = 0;
    let leads = 0;
    let disbursed = 0;
    let approved = 0;
    let underReview = 0;
    let docIncomplete = 0;
    let docComplete = 0;
    let rejected = 0;
    let totalRequestedAmount = 0;
    let totalDisbursedAmount = 0;

    for (const a of appList) {
      const st = (a.status || "").toUpperCase();
      if (st === "LEAD") {
        leads++;
      } else {
        completedApps++;
      }

      if (st === "DISBURSED") {
        disbursed++;
        const amt = a.approvedLoanAmount || a.disbursedAmount || a.sanctionedAmount || a.customer?.loanAmount || 0;
        totalDisbursedAmount += Number(amt) || 0;
      } else if (st === "APPROVED") {
        approved++;
      } else if (st === "UNDER_REVIEW" || st === "SUBMITTED") {
        underReview++;
      } else if (st === "DOC_INCOMPLETE") {
        docIncomplete++;
      } else if (st === "DOC_COMPLETE") {
        docComplete++;
      } else if (st === "REJECTED") {
        rejected++;
      }

      const reqAmt = a.customer?.loanAmount || a.loanAmount || 0;
      totalRequestedAmount += Number(reqAmt) || 0;
    }

    // Follow-up info
    const fu = followUpMap.get(pid);
    const lastCallDate = fu?.latestLastCall ? new Date(fu.latestLastCall).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "";
    const callStatus = fu?.latestStatus || "N/A";
    const callRemarks = fu?.latestRemarks || "";

    const joinDateFormatted = partner.createdAt ? new Date(partner.createdAt).toISOString().split("T")[0] : "";

    workingPartnersList.push({
      // RSM info
      rsmName: rsmObj ? `${rsmObj.firstName || ""} ${rsmObj.lastName || ""}`.trim() : "Unassigned RSM",
      rsmEmployeeId: rsmObj ? (rsmObj.employeeId || "NO_ID") : "N/A",
      rsmPhone: rsmObj ? (rsmObj.phone || "") : "",
      rsmEmail: rsmObj ? (rsmObj.email || "") : "",
      rsmStatus: rsmObj ? (rsmObj.status || "ACTIVE") : "N/A",

      // RM info
      rmName: rmObj ? `${rmObj.firstName || ""} ${rmObj.lastName || ""}`.trim() : "Unassigned RM",
      rmEmployeeId: rmObj ? (rmObj.employeeId || "NO_ID") : "N/A",
      rmPhone: rmObj ? (rmObj.phone || "") : "",
      rmEmail: rmObj ? (rmObj.email || "") : "",
      rmStatus: rmObj ? (rmObj.status || "ACTIVE") : "N/A",

      // Partner info
      partnerName: `${partner.firstName || ""} ${partner.lastName || ""}`.trim(),
      partnerEmployeeId: partner.employeeId || partner.partnerCode || "NO_ID",
      partnerPhone: partner.phone || "",
      partnerEmail: partner.email || "",
      partnerCity: partner.city || "",
      partnerState: partner.region || partner.state || "",
      partnerChannel: partner.partnerChannelType || "GENERAL",
      partnerStatus: partner.status || "ACTIVE",
      joinDate: joinDateFormatted,

      // Loan performance stats
      totalApps,
      completedApps,
      leads,
      disbursed,
      approved,
      underReview,
      docIncomplete,
      docComplete,
      rejected,
      totalRequestedAmount,
      totalDisbursedAmount,

      // Follow-up
      callStatus,
      callRemarks,
      lastCallDate,
    });
  }

  // Sort by RSM Name, then RM Name, then Total Apps descending
  workingPartnersList.sort((a, b) => {
    if (a.rsmName !== b.rsmName) return a.rsmName.localeCompare(b.rsmName);
    if (a.rmName !== b.rmName) return a.rmName.localeCompare(b.rmName);
    return b.totalApps - a.totalApps;
  });

  console.log(`\nTotal Working Partners extracted: ${workingPartnersList.length}`);

  // 5. Group by RSM
  const rsmGroups = new Map();
  for (const wp of workingPartnersList) {
    const key = `${wp.rsmName} (${wp.rsmEmployeeId})`;
    if (!rsmGroups.has(key)) rsmGroups.set(key, []);
    rsmGroups.get(key).push(wp);
  }

  console.log("\nSummary by RSM:");
  for (const [rsmKey, list] of rsmGroups.entries()) {
    const totalApps = list.reduce((s, p) => s + p.totalApps, 0);
    const totalDisb = list.reduce((s, p) => s + p.disbursed, 0);
    const totalDisbAmt = list.reduce((s, p) => s + p.totalDisbursedAmount, 0);
    console.log(`  * ${rsmKey}: ${list.length} Working Partners | ${totalApps} Total Applications | ${totalDisb} Disbursed Loans (₹${totalDisbAmt.toLocaleString('en-IN')})`);
  }

  // 6. CSV Generator
  const headers = [
    "RSM Name",
    "RSM ID",
    "RSM Phone",
    "RSM Email",
    "RM Name",
    "RM ID",
    "RM Phone",
    "Partner Name",
    "Partner ID",
    "Partner Phone",
    "Partner Email",
    "City",
    "Channel Type",
    "Account Status",
    "Total Apps",
    "Completed Apps",
    "Leads",
    "Disbursed Loans",
    "Approved Loans",
    "Under Review / In Progress",
    "Incomplete Docs",
    "Rejected Loans",
    "Total Disbursed Amount (INR)",
    "Total Requested Amount (INR)",
    "Last Call Status",
    "Last Call Remarks",
    "Last Call Date",
    "Partner Join Date"
  ];

  function escapeVal(v) {
    if (v === null || v === undefined) return '""';
    const str = String(v).replace(/"/g, '""');
    return `"${str}"`;
  }

  function toCsv(rows) {
    const lines = [headers.map(h => `"${h}"`).join(",")];
    for (const r of rows) {
      lines.push([
        escapeVal(r.rsmName),
        escapeVal(r.rsmEmployeeId),
        escapeVal(r.rsmPhone),
        escapeVal(r.rsmEmail),
        escapeVal(r.rmName),
        escapeVal(r.rmEmployeeId),
        escapeVal(r.rmPhone),
        escapeVal(r.partnerName),
        escapeVal(r.partnerEmployeeId),
        escapeVal(r.partnerPhone),
        escapeVal(r.partnerEmail),
        escapeVal(r.partnerCity),
        escapeVal(r.partnerChannel),
        escapeVal(r.partnerStatus),
        escapeVal(r.totalApps),
        escapeVal(r.completedApps),
        escapeVal(r.leads),
        escapeVal(r.disbursed),
        escapeVal(r.approved),
        escapeVal(r.underReview),
        escapeVal(r.docIncomplete),
        escapeVal(r.rejected),
        escapeVal(r.totalDisbursedAmount),
        escapeVal(r.totalRequestedAmount),
        escapeVal(r.callStatus),
        escapeVal(r.callRemarks),
        escapeVal(r.lastCallDate),
        escapeVal(r.joinDate)
      ].join(","));
    }
    return lines.join("\n");
  }

  // File outputs
  const scratchDir = "./scratch";
  if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });

  const downloadsDir = "C:\\Users\\sanja\\Downloads";

  // Master CSV
  const masterCsvContent = toCsv(workingPartnersList);
  const masterScratch = path.join(scratchDir, "all_working_partners_by_rsm.csv");
  fs.writeFileSync(masterScratch, masterCsvContent, "utf8");
  console.log(`Saved master CSV to: ${masterScratch}`);

  const masterDownloads = path.join(downloadsDir, "all_working_partners_by_rsm.csv");
  try {
    fs.writeFileSync(masterDownloads, masterCsvContent, "utf8");
    console.log(`Saved master CSV to Downloads: ${masterDownloads}`);
  } catch (e) {
    console.error("Could not write directly to Downloads:", e.message);
  }

  // RSM specific CSVs
  for (const [rsmKey, list] of rsmGroups.entries()) {
    const safeName = rsmKey.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
    const rsmCsv = toCsv(list);

    const rsmScratchPath = path.join(scratchDir, `working_partners_${safeName}.csv`);
    fs.writeFileSync(rsmScratchPath, rsmCsv, "utf8");
    console.log(`Saved RSM CSV: ${rsmScratchPath} (${list.length} rows)`);

    const rsmDownloadsPath = path.join(downloadsDir, `working_partners_${safeName}.csv`);
    try {
      fs.writeFileSync(rsmDownloadsPath, rsmCsv, "utf8");
      console.log(`Saved RSM CSV to Downloads: ${rsmDownloadsPath}`);
    } catch (e) {
      console.error(`Could not write ${safeName} to Downloads:`, e.message);
    }
  }

  // Also write full JSON breakdown
  const fullJson = {
    generatedAt: new Date().toISOString(),
    totalWorkingPartners: workingPartnersList.length,
    rsmBreakdown: Array.from(rsmGroups.entries()).map(([rsmKey, list]) => {
      const first = list[0];
      return {
        rsmTitle: rsmKey,
        rsmName: first.rsmName,
        rsmEmployeeId: first.rsmEmployeeId,
        rsmPhone: first.rsmPhone,
        rsmEmail: first.rsmEmail,
        workingPartnersCount: list.length,
        totalApps: list.reduce((s, p) => s + p.totalApps, 0),
        disbursedLoansCount: list.reduce((s, p) => s + p.disbursed, 0),
        disbursedAmountSum: list.reduce((s, p) => s + p.totalDisbursedAmount, 0),
        partners: list.map(p => ({
          partnerName: p.partnerName,
          partnerId: p.partnerEmployeeId,
          partnerPhone: p.partnerPhone,
          rmName: p.rmName,
          rmId: p.rmEmployeeId,
          totalApps: p.totalApps,
          disbursed: p.disbursed,
          callStatus: p.callStatus,
        }))
      };
    })
  };

  fs.writeFileSync(path.join(scratchDir, "working_partners_detailed.json"), JSON.stringify(fullJson, null, 2), "utf8");

  await mongoose.disconnect();
  console.log("\nFinished completely and successfully!");
}

run().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
