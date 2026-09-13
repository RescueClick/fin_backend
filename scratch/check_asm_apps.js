import dotenv from "dotenv";
dotenv.config();
import { connectDB } from "../src/db/db.js";
import { Application } from "../src/models/Application.js";
import { User } from "../src/models/User.js";

async function run() {
  await connectDB(process.env.MONGO_URI);
  const apps = await Application.find({ asmId: { $ne: null } })
    .select("appNo loanType status asmId")
    .populate("asmId", "role employeeId firstName lastName");
  
  let count = 0;
  for (const app of apps) {
    if (app.asmId?.role === "RSM") {
      console.log(`App ${app.appNo} (${app.loanType}, ${app.status}) has RSM as asmId: ${app.asmId.employeeId} (${app.asmId.firstName} ${app.asmId.lastName})`);
      count++;
    }
  }
  console.log(`Total apps with RSM as asmId: ${count}`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
