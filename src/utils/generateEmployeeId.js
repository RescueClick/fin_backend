// utils/generateEmployeeId.js
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";

/**
 * Generate unique, strictly linear employee/application ID.
 * Scans all existing IDs with the given prefix globally across the collection
 * to ensure true linearity and prevent Mongo duplicate key errors (E11000).
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
      throw new Error(`Invalid role for employee ID: ${role}`);
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Find all records globally with this prefix (NO role filter, because index is global)
      const existingRecords = await Model.find({
        [idField]: { $regex: `^${prefix}\\d+`, $options: "i" },
      })
        .select(idField)
        .lean();

      let maxNum = 0;
      const regex = new RegExp(`^${prefix}(\\d+)`, "i");

      for (const rec of existingRecords) {
        const val = rec[idField];
        if (typeof val === "string") {
          const match = val.match(regex);
          if (match && match[1]) {
            const parsed = parseInt(match[1], 10);
            if (!isNaN(parsed) && parsed > maxNum) {
              maxNum = parsed;
            }
          }
        }
      }

      // Linear sequence: next number is strictly maxNum + 1
      let candidateNum = maxNum + 1;

      // Verify availability against whole collection until an unused candidate is found
      while (true) {
        const candidateId = `${prefix}${candidateNum.toString().padStart(4, "0")}`;
        const taken = await Model.findOne({ [idField]: candidateId })
          .select("_id")
          .lean();

        if (!taken) {
          return candidateId;
        }

        candidateNum++;
      }
    } catch (err) {
      console.error(`Error in generateEmployeeId for ${role} (attempt ${attempt + 1}):`, err);
      if (attempt === maxRetries - 1) {
        // Fallback to high random suffix if DB query consistently fails
        const timestampSuffix = Date.now().toString().slice(-4);
        return `${prefix}9${timestampSuffix}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }

  return `${prefix}${Date.now().toString().slice(-4)}`;
}
