import fs from "fs";
import path from "path";
import axios from "axios";
import mime from "mime-types";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, BUCKET_NAME } from "../config/s3.js";
import { extractS3KeyFromUrl } from "./docUploadLimits.js";

// Hostinger SMTP rejects messages above ~25 MB; base64 adds ~33%, so keep each email's attachments under 18 MB.
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
// SigV4 presigned URLs cannot exceed 7 days.
const LINK_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

const resolveDocUrl = (url) => {
  const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";
  let actual = String(url || "").trim();
  if (actual.startsWith(backendUrl)) {
    actual = actual.replace(backendUrl, "").replace(/^\/+/, "");
  }
  return actual;
};

const isS3Url = (url) => url.includes("amazonaws.com") && Boolean(extractS3KeyFromUrl(url));

const extFor = (url, contentType) => {
  try {
    const ext = path.extname(new URL(url).pathname);
    if (ext) return ext;
  } catch {
    const ext = path.extname(url);
    if (ext) return ext;
  }
  const fromMime = contentType ? mime.extension(contentType) : "";
  return fromMime ? `.${fromMime}` : "";
};

const fetchDocBuffer = async (url) => {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    if (isS3Url(url)) {
      const out = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: extractS3KeyFromUrl(url) })
      );
      const bytes = await out.Body.transformToByteArray();
      return { buffer: Buffer.from(bytes), contentType: out.ContentType };
    }
    const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
    return { buffer: Buffer.from(resp.data), contentType: resp.headers["content-type"] };
  }
  const filePath = path.resolve(process.cwd(), url);
  const buffer = await fs.promises.readFile(filePath);
  return { buffer, contentType: mime.lookup(filePath) || undefined };
};

const uniqueName = (name, used) => {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 2;
  while (used.has(`${base}_${i}${ext}`)) i++;
  const next = `${base}_${i}${ext}`;
  used.add(next);
  return next;
};

const downloadLink = async (url) => {
  if (isS3Url(url)) {
    return getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: extractS3KeyFromUrl(url) }),
      { expiresIn: LINK_EXPIRY_SECONDS }
    );
  }
  const backendUrl = (process.env.BACKEND_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url) && backendUrl) {
    return `${backendUrl}/${url.replace(/^\/+/, "")}`;
  }
  return url;
};

/**
 * Packages all application docs for emailing as individual attachments.
 * Files are grouped into batches that each fit in one email; a single file
 * too large for any email is sent as an expiring download link instead.
 */
export async function packageApplicationDocs(app) {
  const docs = (app.docs || []).filter((d) => d?.url && d.status !== "REJECTED");

  const files = [];
  const links = [];
  const failed = [];
  const used = new Set();

  for (const doc of docs) {
    const url = resolveDocUrl(doc.url);
    try {
      const { buffer, contentType } = await fetchDocBuffer(url);
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        links.push({ docType: doc.docType, href: await downloadLink(url) });
        continue;
      }
      files.push({
        docType: doc.docType,
        filename: uniqueName(`${doc.docType}${extFor(url, contentType)}`, used),
        content: buffer,
        ...(contentType ? { contentType } : {}),
      });
    } catch (err) {
      failed.push({ docType: doc.docType, url, error: err.message });
    }
  }

  const batches = [];
  let current = [];
  let currentSize = 0;
  for (const f of files) {
    if (current.length && currentSize + f.content.length > MAX_ATTACHMENT_BYTES) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(f);
    currentSize += f.content.length;
  }
  if (current.length) batches.push(current);

  return {
    delivery: files.length || !links.length ? "ATTACHMENT" : "LINKS",
    docsCount: files.length + links.length,
    batches,
    links,
    failed,
  };
}
