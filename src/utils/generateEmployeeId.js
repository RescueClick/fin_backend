// utils/generateEmployeeId.js
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";

/**
 * Generate unique employee/application ID with race condition protection
 * Uses retry logic to handle concurrent requests
 */
export async function generateEmployeeId(role, maxRetries = 10) {
  let prefix;
  let Model;
  let idField;

  switch (role) {
    case "ASM":
      prefix = "TLA";
      Model = User;
      idField = "employeeId";
      break;

    case "RSM":
      prefix = "TLS";
      Model = User;
      idField = "employeeId";
      break;

    case "RM":
      prefix = "TLR";
      Model = User;
      idField = "employeeId";
      break;

    case "PARTNER":
      prefix = "TLP";
      Model = User;
      idField = "employeeId";
      break;

    case "CUSTOMER":
      prefix = "TLC";
      Model = User;
      idField = "employeeId";
      break;

    case "APPLICATION":
      prefix = "TLF";
      Model = Application;
      idField = "appNo";
      break;

    default:
      throw new Error("Invalid role for employee ID");
  }

  // Retry logic to handle race conditions
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Get the highest existing ID for this role
      let last;
      if (role === "APPLICATION") {
        last = await Application.find()
          .sort({ createdAt: -1 })
          .limit(1)
          .select("appNo")
          .lean();
      } else {
        last = await User.find({ role })
          .sort({ createdAt: -1 })
          .limit(1)
          .select("employeeId")
          .lean();
      }

      // Determine next number
      let nextNum = 1;
      if (last.length && last[0]) {
        const existingId = last[0].employeeId || last[0].appNo;
        if (existingId && existingId.startsWith(prefix)) {
          const numPart = existingId.slice(prefix.length);
          const parsed = parseInt(numPart, 10);
          if (!isNaN(parsed)) {
            nextNum = parsed + 1;
          }
        }
      }

      // Generate candidate ID
      const candidateId = `${prefix}${nextNum.toString().padStart(4, "0")}`;

      // ✅ CRITICAL: Check if this ID already exists (handles race conditions)
      let exists = false;
      if (role === "APPLICATION") {
        exists = await Application.findOne({ appNo: candidateId }).lean();
      } else {
        exists = await User.findOne({ 
          [idField]: candidateId,
          role: role !== "APPLICATION" ? role : undefined
        }).lean();
      }

      // If ID doesn't exist, return it
      if (!exists) {
        return candidateId;
      }

      // If ID exists, increment and try again (another request created it)
      console.log(`⚠️ ID ${candidateId} already exists, trying next number...`);
      nextNum++;
      
      // Try next number
      const nextCandidateId = `${prefix}${nextNum.toString().padStart(4, "0")}`;
      let nextExists = false;
      if (role === "APPLICATION") {
        nextExists = await Application.findOne({ appNo: nextCandidateId }).lean();
      } else {
        nextExists = await User.findOne({ 
          [idField]: nextCandidateId,
          role: role !== "APPLICATION" ? role : undefined
        }).lean();
      }

      if (!nextExists) {
        return nextCandidateId;
      }

      // If still exists, wait a bit and retry
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    } catch (error) {
      console.error(`Error generating ${role} ID (attempt ${attempt + 1}):`, error);
      if (attempt === maxRetries - 1) {
        throw new Error(`Failed to generate unique ${role} ID after ${maxRetries} attempts: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }

  // Fallback: Use timestamp-based ID if all retries fail
  const timestamp = Date.now().toString().slice(-6);
  return `${prefix}${timestamp}`;
}
