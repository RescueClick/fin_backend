import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB.");

    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(collections.map(c => c.name));

    process.exit(0);
}

main().catch(console.error);
