import mongoose from "mongoose";
import dotenv from "dotenv";
import { getRmIdsUnderAsm, getAsmScopeIds } from "../src/utils/asmHierarchy.js";

dotenv.config();

import { User } from "../src/models/User.js";
import { Application } from "../src/models/Application.js";

async function inspect() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to DB.");

  const asms = await User.find({ role: "ASM" }).lean();
  console.log(`Found ${asms.length} ASMs:`);

  for (const asm of asms) {
    console.log(`\n==============================================`);
    console.log(`ASM: ${asm.firstName} ${asm.lastName} (ID: ${asm._id}, email: ${asm.email}, empId: ${asm.employeeId})`);
    
    // Direct RSMs under this ASM
    const rsms = await User.find({ role: "RSM", asmId: asm._id }).lean();
    console.log(`  RSMs (${rsms.length}):`);
    rsms.forEach(r => console.log(`    - RSM: ${r.firstName} ${r.lastName} (${r._id}, Type: ${r.rsmType}, Status: ${r.status})`));

    const rsmIds = rsms.map(r => r._id);

    // getRmIdsUnderAsm
    const rmIds = await getRmIdsUnderAsm(asm._id);
    console.log(`  getRmIdsUnderAsm returned ${rmIds.length} RMs:`, rmIds);

    const rms = await User.find({ _id: { $in: rmIds } }).lean();
    rms.forEach(rm => console.log(`    - RM: ${rm.firstName} ${rm.lastName} (${rm._id}, personalRsm: ${rm.personalRsmId}, bizRsm: ${rm.businessHomeRsmId}, directAsm: ${rm.asmId})`));

    // Check all RMs in the system and their links
    const allRms = await User.find({ role: "RM" }).lean();
    console.log(`  Total RMs in DB: ${allRms.length}`);
    for (const rm of allRms) {
      console.log(`    RM ${rm.firstName} ${rm.lastName} (${rm._id}) -> personalRsmId: ${rm.personalRsmId}, bizRsmId: ${rm.businessHomeRsmId}, asmId: ${rm.asmId}`);
    }

    // Partners under this ASM's RMs
    const partners = await User.find({ role: "PARTNER", rmId: { $in: rmIds } }).lean();
    console.log(`  Partners under these RMs (${partners.length}):`);
    
    // Total partners in DB
    const totalPartners = await User.countDocuments({ role: "PARTNER" });
    console.log(`  Total Partners in DB: ${totalPartners}`);

    // Applications under this ASM
    const appsDirectAsm = await Application.countDocuments({ asmId: asm._id });
    const appsViaRsm = await Application.countDocuments({ rsmId: { $in: rsmIds } });
    const appsViaRm = await Application.countDocuments({ rmId: { $in: rmIds } });
    const totalAppsInDb = await Application.countDocuments({});
    console.log(`  Apps -> direct asmId: ${appsDirectAsm}, via rsmId: ${appsViaRsm}, via rmId: ${appsViaRm}, total in DB: ${totalAppsInDb}`);
  }

  process.exit(0);
}

inspect().catch(e => { console.error(e); process.exit(1); });
