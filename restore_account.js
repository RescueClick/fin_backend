import mongoose from 'mongoose';
import dotenv from 'dotenv';
import argon2 from 'argon2';
dotenv.config();

const UserSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', UserSchema);

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB.');

    // Check if already exists
    const existing = await User.findOne({ phone: '7720963396' });
    if (existing) {
        console.log('Account already exists:', existing._id);
        process.exit(0);
    }

    // Recreate with same known details
    const passwordHash = await argon2.hash('Sanjay@1234'); // default restore password

    const restored = await User.create({
        firstName: 'Sanjay',
        lastName: 'Gawai',
        email: 'sanjaygawai1002@gmail.com',
        phone: '7720963396',
        role: 'PARTNER',
        status: 'ACTIVE',
        passwordHash,
        partnerLevel: 'BRONZE',
    });

    console.log('Account restored successfully!');
    console.log('  _id   :', restored._id);
    console.log('  Name  : Sanjay Gawai');
    console.log('  Email : sanjaygawai1002@gmail.com');
    console.log('  Phone : 7720963396');
    console.log('  Role  : PARTNER');
    console.log('  Pass  : Sanjay@1234  (please change after login)');

    process.exit(0);
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});
