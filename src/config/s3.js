import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import dotenv from "dotenv";

dotenv.config();

const uploadTimeoutMs = Number(process.env.AWS_REQUEST_TIMEOUT_MS) || 10 * 60 * 1000;

export const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  // Slow mobile multipart uploads stream each file to S3 during the HTTP request.
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 30_000,
    requestTimeout: uploadTimeoutMs,
  }),
  maxAttempts: 3,
});

export const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
