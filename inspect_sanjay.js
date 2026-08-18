import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const UserSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', UserSchema);

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB.");

    const sanjay = await User.findById("6a65edd144d77ea2963142e3");
    console.log("Sanjay deletedAt:", sanjay.deletedAt);
    console.log("Sanjay raw doc:", JSON.stringify(sanjay, null, 2));
    process.exit(0);
}

main().catch(console.error);
