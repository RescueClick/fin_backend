import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { Application } from "../models/Application.js";
import { s3, BUCKET_NAME } from "../config/s3.js";
import { DeleteObjectCommand, CopyObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * Archive rejected apps past grace period.
 * NEVER wipe docs unless JSON snapshot archived successfully.
 * Application + customer User rows are always kept.
 */
export const cleanupRejectedApps = async () => {
  try {
    const appsToDelete = await Application.find({
      deletedAt: { $lte: new Date() },
      isArchived: { $ne: true },
    });

    for (const app of appsToDelete) {
      const appId = app._id.toString();

      let jsonArchived = false;
      try {
        const appData = JSON.stringify(app.toObject(), null, 2);
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `archive/application_${appId}/data.json`,
            Body: appData,
            ContentType: "application/json",
          })
        );
        jsonArchived = true;
        console.log(`Archived JSON data for application ${appId}`);
      } catch (err) {
        console.error(
          `Failed to archive JSON for ${appId} — skipping wipe to prevent data loss:`,
          err.message
        );
        continue;
      }

      if (!jsonArchived) continue;

      let docsArchiveFailed = false;
      for (const doc of app.docs || []) {
        if (!doc.url) continue;

        try {
          if (doc.url.startsWith("http")) {
            const urlObj = new URL(doc.url);
            let key = decodeURIComponent(urlObj.pathname.substring(1));
            const archiveKey = `archive/application_${appId}/${key.split("/").pop()}`;

            await s3.send(
              new CopyObjectCommand({
                Bucket: BUCKET_NAME,
                CopySource: `${BUCKET_NAME}/${key}`,
                Key: archiveKey,
              })
            );

            await s3.send(
              new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key,
              })
            );
            console.log(`Archived and deleted S3 file: ${key}`);
          } else {
            const filePath = path.join(process.cwd(), doc.url);
            if (fs.existsSync(filePath)) {
              const archiveDir = path.join(
                process.cwd(),
                "archive",
                `application_${appId}`
              );
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
          docsArchiveFailed = true;
          console.error(
            `Error archiving file ${doc.url} — keeping original docs on application:`,
            fileErr.message
          );
        }
      }

      // Only clear docs array when every file archived (or there were no docs)
      if (!docsArchiveFailed) {
        app.docs = [];
      }
      app.isArchived = true;
      await app.save();

      console.log(
        docsArchiveFailed
          ? `Marked archived but retained docs due to archive errors: ${app._id}`
          : `Archived application, wiped documents, kept user intact: ${app._id}`
      );
    }
  } catch (err) {
    console.error("Cleanup job error:", err);
  }
};
