import 'dotenv/config';
import { connectDB } from '../src/db/db.js';
import { User } from '../src/models/User.js';
import { Application } from '../src/models/Application.js';

async function main() {
  await connectDB(process.env.MONGO_URI);
  const asmId = '6a8d36dcb346b8a87530a3cb';

  const statuses = await Application.aggregate([
    { $match: { $or: [{ asmId: new User.base.Types.ObjectId(asmId) }, { rsmId: new User.base.Types.ObjectId(asmId) }] } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  console.log('Statuses for ASM Sandip Chaughule:', statuses);

  const missingRm = await Application.countDocuments({
    $or: [{ asmId }, { rsmId: asmId }],
    rmId: null
  });
  console.log('Applications with missing rmId:', missingRm);

  // Check recent applications
  const recent = await Application.find({
    $or: [{ asmId }, { rsmId: asmId }]
  }).sort({ updatedAt: -1 }).limit(10).select('appNo loanType status asmId rsmId rmId updatedAt').lean();
  console.log('Recent 10 applications:', recent);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
