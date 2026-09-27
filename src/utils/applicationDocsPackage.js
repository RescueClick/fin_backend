import fs from "fs";
import path from "path";
import axios from "axios";
import archiver from "archiver";
import mime from "mime-types";
import { PassThrough } from "stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, BUCKET_NAME } from "../config/s3.js";
import { extractS3KeyFromUrl } from "./docUploadLimits.js";

// Hostinger SMTP rejects messages above ~25 MB; base64 adds ~33%, so keep the zip under 18 MB.
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

const zipFiles = (files) =>
  new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const sink = new PassThrough();
    const chunks = [];
    sink.on("data", (c) => chunks.push(c));
    sink.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.pipe(sink);
    files.forEach((f) => archive.append(f.buffer, { name: f.name }));
    archive.finalize();
  });

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

/**
 * Packages all application docs for emailing.
 * Returns either a single zip attachment or a list of expiring download links.
 */
export async function packageApplicationDocs(app) {
  const docs = (app.docs || []).filter((d) => d?.url && d.status !== "REJECTED");
  const zipName = `${app.appNo || `APP-${String(app._id).slice(-6)}`}_Documents.zip`;

  const files = [];
  const failed = [];
  const used = new Set();

  for (const doc of docs) {
    const url = resolveDocUrl(doc.url);
    try {
      const { buffer, contentType } = await fetchDocBuffer(url);
      files.push({
        docType: doc.docType,
        url,
        buffer,
        name: uniqueName(`${doc.docType}${extFor(url, contentType)}`, used),
      });
    } catch (err) {
      failed.push({ docType: doc.docType, url, error: err.message });
    }
  }

  const totalRaw = files.reduce((sum, f) => sum + f.buffer.length, 0);
  if (files.length && totalRaw <= MAX_ATTACHMENT_BYTES * 1.5) {
    const zip = await zipFiles(files);
    if (zip.length <= MAX_ATTACHMENT_BYTES) {
      return {
        delivery: "ATTACHMENT",
        docsCount: files.length,
        docTypes: files.map((f) => f.docType),
        attachments: [{ filename: zipName, content: zip, contentType: "application/zip" }],
        links: [],
        failed,
      };
    }
  }

  const backendUrl = (process.env.BACKEND_URL || "").replace(/\/+$/, "");
  const links = [];
  for (const doc of docs) {
    const url = resolveDocUrl(doc.url);
    let href = url;
    if (isS3Url(url)) {
      href = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: extractS3KeyFromUrl(url) }),
        { expiresIn: LINK_EXPIRY_SECONDS }
      );
    } else if (!/^https?:\/\//.test(url) && backendUrl) {
      href = `${backendUrl}/${url.replace(/^\/+/, "")}`;
    }
    links.push({ docType: doc.docType, href });
  }

  return {
    delivery: "LINKS",
    docsCount: links.length,
    docTypes: links.map((l) => l.docType),
    attachments: [],
    links,
    failed: [],
  };
}
