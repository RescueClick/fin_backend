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
    const partnerId = req.partnerId || "temp";
    const uploaderId = req.user ? req.user.sub : "self";
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || "";
    cb(
      null,
      `profileDocs/${partnerId}/${file.fieldname}-${uploaderId}-${uniqueSuffix}${ext}`
    );
  },
});

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    return cb(null, true);
  }
  return cb(new Error("Only JPG, PNG, and PDF files are allowed"), false);
};

/** Partner self-registration KYC; keep in sync with web/app validation (5MB). */
const MAX_PARTNER_DOC_BYTES = 5 * 1024 * 1024;

export const partnerUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_PARTNER_DOC_BYTES },
});

