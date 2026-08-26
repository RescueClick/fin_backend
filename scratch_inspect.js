import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const UserSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', UserSchema);
const ApplicationSchema = new mongoose.Schema({}, { strict: false });
const Application = mongoose.model('Application', ApplicationSchema);

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.");

  const asms = await User.find({ role: 'ASM' }).lean();
  console.log('=== ASMs ===');
  for (const asm of asms) {
    console.log(`\nASM: ${asm._id} | ${asm.firstName} ${asm.lastName} | emp: ${asm.employeeId} | status: ${asm.status}`);
    const rsms = await User.find({ asmId: asm._id, role: 'RSM' }).lean();
    console.log(`  RSMs count under this ASM: ${rsms.length}`);
    for (const r of rsms) {
      console.log(`    RSM: ${r._id} | ${r.firstName} ${r.lastName} | type: ${r.rsmType} | status: ${r.status} | deletedAt: ${r.deletedAt}`);
      const rms = await User.find({
        role: 'RM',
        $or: [
          { personalRsmId: r._id },
          { businessHomeRsmId: r._id },
          { rsmId: r._id }
        ]
      }).lean();
      console.log(`      RMs under this RSM: ${rms.length}`);
      for (const rm of rms) {
        const partners = await User.find({ role: 'PARTNER', rmId: rm._id }).lean();
        const apps = await Application.find({ rmId: rm._id }).lean();
        console.log(`        RM: ${rm._id} | ${rm.firstName} ${rm.lastName} | emp: ${rm.employeeId} | Partners: ${partners.length} | Apps: ${apps.length}`);
      }
    }

    // Direct RMs under ASM
    const directRms = await User.find({ role: 'RM', asmId: asm._id }).lean();
    console.log(`  Direct RMs with asmId=${asm._id}: ${directRms.length}`);
    for (const rm of directRms) {
      console.log(`    Direct RM: ${rm._id} | ${rm.firstName} ${rm.lastName} | personalRsm: ${rm.personalRsmId} | bizRsm: ${rm.businessHomeRsmId}`);
    }
  }

  console.log('\n=== All RSMs in DB ===');
  const allRsms = await User.find({ role: 'RSM' }).lean();
  for (const r of allRsms) {
    console.log(`RSM: ${r._id} | ${r.firstName} ${r.lastName} | asmId: ${r.asmId} | status: ${r.status} | deletedAt: ${r.deletedAt}`);
  }

  console.log('\n=== All RMs in DB ===');
  const allRms = await User.find({ role: 'RM' }).lean();
  for (const rm of allRms) {
    const partners = await User.find({ role: 'PARTNER', rmId: rm._id }).lean();
    const apps = await Application.find({ rmId: rm._id }).lean();
    console.log(`RM: ${rm._id} | ${rm.firstName} ${rm.lastName} | emp: ${rm.employeeId} | status: ${rm.status} | asmId: ${rm.asmId} | personalRsm: ${rm.personalRsmId} | bizRsm: ${rm.businessHomeRsmId} | Partners: ${partners.length} | Apps: ${apps.length}`);
  }

  console.log('\n=== Application RSM/RM/ASM fields check ===');
  const apps = await Application.find({}).select('appNo customer.firstName customer.lastName loanType status rmId rsmId asmId partnerId').lean();
  console.log(`Total Applications: ${apps.length}`);
  for (const a of apps) {
    console.log(`App: ${a.appNo || a._id} | loan: ${a.loanType} | status: ${a.status} | rmId: ${a.rmId} | rsmId: ${a.rsmId} | asmId: ${a.asmId} | partnerId: ${a.partnerId}`);
  }

  process.exit(0);
}

main().catch(console.error);
