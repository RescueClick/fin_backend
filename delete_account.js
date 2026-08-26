import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const UserSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', UserSchema);

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB.');

    const user = await User.findOne({ phone: '7720990081' });

    if (!user) {
        console.log('No user found with phone 7720990081.');
        process.exit(0);
    }

    console.log('Found user:');
    console.log(`  Name  : ${user.firstName} ${user.lastName}`);
    console.log(`  Email : ${user.email}`);
    console.log(`  Phone : ${user.phone}`);
    console.log(`  Role  : ${user.role}`);
    console.log(`  _id   : ${user._id}`);

    const result = await User.deleteOne({ phone: '7720990081' });
    console.log(`\nDeleted count: ${result.deletedCount}`);
    console.log('Account permanently removed.');

    process.exit(0);
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});
