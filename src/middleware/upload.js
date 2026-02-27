import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { s3, BUCKET_NAME } from "../config/s3.js";

const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "application/pdf",
];

const storage = multerS3({
  s3,
  bucket: BUCKET_NAME,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: (req, file, cb) => {
    const ownerId = req.user?.sub || req.headers["x-upload-user"] || "public";
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || "";
    cb(null, `uploads/${ownerId}/${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  console.log("File filter check:", {
    mimetype: file.mimetype,
    originalname: file.originalname,
    fieldname: file.fieldname,
  });

  const ext = (path.extname(file.originalname) || "").toLowerCase();
  const allowedExts = [".jpg", ".jpeg", ".png", ".pdf"];

  const isAllowedMime = allowedMimeTypes.includes(file.mimetype);
  const isOctetStreamWithValidExt =
    file.mimetype === "application/octet-stream" &&
    allowedExts.includes(ext);

  if (isAllowedMime || isOctetStreamWithValidExt) {
    return cb(null, true);
  }

  return cb(new Error("Only JPG, PNG, and PDF files are allowed"), false);
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { 
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});
