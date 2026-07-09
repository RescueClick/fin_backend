import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { Application } from "../models/Application.js";
import { User } from "../models/User.js";
import { s3, BUCKET_NAME } from "../config/s3.js";
import { DeleteObjectCommand, CopyObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export const cleanupRejectedApps = async () => {
  try {
    const appsToDelete = await Application.find({ 
      deletedAt: { $lte: new Date() },
      isArchived: { $ne: true } 
    });

    for (const app of appsToDelete) {
      const appId = app._id.toString();
      
      // Upload JSON snapshot of the application
      try {
        const appData = JSON.stringify(app.toObject(), null, 2);
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `archive/application_${appId}/data.json`,
          Body: appData,
          ContentType: "application/json"
        }));
        console.log(`Archived JSON data for application ${appId}`);
      } catch (err) {
        console.error(`Failed to archive JSON for ${appId}:`, err.message);
      }

      // Archive and delete uploaded docs physically
      for (const doc of app.docs) {
        if (!doc.url) continue;

        try {
          if (doc.url.startsWith("http")) {
            // S3 URL
            const urlObj = new URL(doc.url);
            let key = decodeURIComponent(urlObj.pathname.substring(1));
            const archiveKey = `archive/application_${appId}/${key.split('/').pop()}`;

            // Copy to archive folder
            await s3.send(new CopyObjectCommand({
              Bucket: BUCKET_NAME,
              CopySource: `${BUCKET_NAME}/${key}`,
              Key: archiveKey
            }));

            // Delete original
            await s3.send(new DeleteObjectCommand({
              Bucket: BUCKET_NAME,
              Key: key
            }));
            console.log(`Archived and deleted S3 file: ${key}`);
          } else {
            // Local file
            const filePath = path.join(process.cwd(), doc.url);
            if (fs.existsSync(filePath)) {
              const archiveDir = path.join(process.cwd(), 'archive', `application_${appId}`);
              if (!fs.existsSync(archiveDir)) {
                fs.mkdirSync(archiveDir, { recursive: true });
              }
              const archivePath = path.join(archiveDir, path.basename(filePath));
              fs.copyFileSync(filePath, archivePath);
              fs.unlinkSync(filePath);
              console.log(`Archived and deleted local file: ${filePath}`);
            }
          }
        } catch (fileErr) {
          console.error(`Error archiving file ${doc.url}:`, fileErr.message);
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
