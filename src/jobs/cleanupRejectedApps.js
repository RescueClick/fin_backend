import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { Application } from "../models/Application.js";
import { User } from "../models/User.js";
import { s3, BUCKET_NAME } from "../config/s3.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";

export const cleanupRejectedApps = async () => {
  try {
    const appsToDelete = await Application.find({ 
      deletedAt: { $lte: new Date() },
      isArchived: { $ne: true } 
    });

    for (const app of appsToDelete) {
      // Delete uploaded docs physically
      for (const doc of app.docs) {
        if (!doc.url) continue;

        try {
          if (doc.url.startsWith("http")) {
            // S3 URL
            const urlObj = new URL(doc.url);
            // If virtual-hosted style: https://bucket.s3.region.amazonaws.com/uploads/...
            // The pathname is /uploads/... so the key is uploads/...
            let key = urlObj.pathname.substring(1); 
            await s3.send(new DeleteObjectCommand({
              Bucket: BUCKET_NAME,
              Key: decodeURIComponent(key)
            }));
            console.log(`Deleted S3 file: ${key}`);
          } else {
            // Local file
            const filePath = path.join(process.cwd(), doc.url);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.log(`Deleted local file: ${filePath}`);
            }
          }
        } catch (fileErr) {
          console.error(`Error deleting file ${doc.url}:`, fileErr.message);
        }
      }

      // Soft delete application by wiping docs and marking as archived
      app.docs = [];
      app.isArchived = true;
      await app.save();
      
      console.log("Archived application, wiped documents, kept user intact:", app._id);
    }
  } catch (err) {
    console.error("Cleanup job error:", err);
  }
};
