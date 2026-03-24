import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { s3, BUCKET_NAME } from "../config/s3.js";

const allowedMimeTypes = ["image/jpeg", "image/png", "image/jpg"];

const bannerStorage = multerS3({
  s3,
  bucket: BUCKET_NAME,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || "";
    cb(null, `banners/${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    return cb(null, true);
  }
  return cb(new Error("Only JPG and PNG banners are allowed"), false);
};

export const bannerUpload = multer({
  storage: bannerStorage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});
