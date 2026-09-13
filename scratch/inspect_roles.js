import dotenv from "dotenv";
dotenv.config();
import { connectDB } from "../src/db/db.js";
import { User } from "../src/models/User.js";

async function run() {
  await connectDB(process.env.MONGO_URI);
  const users = await User.find({ role: { $in: ["RSM", "ASM"] } })
    .select("firstName lastName employeeId role asmType rsmType")
    .sort({ employeeId: 1 });
  
  users.forEach(u => console.log(`${u.employeeId} | Role: ${u.role} | Name: ${u.firstName} ${u.lastName} | Type: ${u.asmType || u.rsmType || 'N/A'}`));
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
