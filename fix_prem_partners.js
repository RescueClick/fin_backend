import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const UserSchema = new mongoose.Schema({ rmId: mongoose.Schema.Types.ObjectId, role: String }, { strict: false });
const User = mongoose.model('User', UserSchema);

const AppSchema = new mongoose.Schema({ rmId: mongoose.Schema.Types.ObjectId }, { strict: false });
const Application = mongoose.model('Application', AppSchema);

const AuditSchema = new mongoose.Schema({}, { strict: false, collection: 'reassignmentauditlogs' });
const Audit = mongoose.model('ReassignmentAuditLog', AuditSchema);

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB.");

    const sanjayId = new mongoose.Types.ObjectId("6a65edd144d77ea2963142e3");
    const premId = new mongoose.Types.ObjectId("6a7ebfde0c8a252435991f26");

    // Get the audit logs from today where partners were moved TO Prem Jadhav
    const logs = await Audit.find({ 
        toUserId: premId, 
        entityType: 'PARTNER' 
    });

    const partnerIds = logs.map(l => l.entityId);
    console.log(`Found ${partnerIds.length} partners transferred to Prem in audit logs.`);

    // Check if these partners are currently assigned to Sanjay
    const partnersToMove = await User.find({ _id: { $in: partnerIds }, rmId: sanjayId });
    console.log(`Of those, ${partnersToMove.length} are currently with Sanjay. Moving them to Prem...`);

    const result = await User.updateMany(
        { _id: { $in: partnersToMove.map(p => p._id) } },
        { $set: { rmId: premId } }
    );
    console.log(`Moved ${result.modifiedCount} partners back to Prem Jadhav.`);

    // Also move applications for these partners back to Prem Jadhav
    // Wait, the applications transferred to Prem would also be in the audit logs!
    const appLogs = await Audit.find({ 
        toUserId: premId, 
        entityType: 'APPLICATION' 
    });
    
    const appIds = appLogs.map(l => l.entityId);
    console.log(`Found ${appIds.length} applications transferred to Prem in audit logs.`);

    const appsToMove = await Application.find({ _id: { $in: appIds }, rmId: sanjayId });
    console.log(`Of those, ${appsToMove.length} are currently with Sanjay. Moving them to Prem...`);

    const appResult = await Application.updateMany(
        { _id: { $in: appsToMove.map(a => a._id) } },
        { $set: { rmId: premId } }
    );
    console.log(`Moved ${appResult.modifiedCount} applications back to Prem Jadhav.`);

    process.exit(0);
}

main().catch(console.error);
