import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3, BUCKET_NAME } from "../config/s3.js";

/**
 * Per-document upload limits (bytes). Partner registration KYC stays 5MB via profileUpload.
 * Loan/application docs: tiers by document category.
 */
export const DOC_UPLOAD_LIMIT_BYTES = {
  ID_KYC: 5 * 1024 * 1024,
  SELFIE: 5 * 1024 * 1024,
  PAYSLIP_SMALL: 10 * 1024 * 1024,
  BANK_STATEMENT: 15 * 1024 * 1024,
  PROPERTY_LEGAL: 20 * 1024 * 1024,
  OTHER: 20 * 1024 * 1024,
};

/** Multer `upload` middleware hard cap — must be >= largest tier. */
export const SERVER_UPLOAD_HARD_CAP_BYTES = 20 * 1024 * 1024;

/** Same aliases as `normalizeIncomingDocType` in partner.routes.js */
export function normalizeDocTypeForLimits(docType) {
  const key = String(docType || "").trim().toUpperCase();
  const aliases = {
    AADHAAR_FRONT: "AADHAR_FRONT",
    AADHAAR_BACK: "AADHAR_BACK",
    PASSPORT_PHOTO: "PHOTO",
    OTHER_DOC: "OTHER_DOCS",
    FORM16: "FORM_16_26AS",
    FORM_16: "FORM_16_26AS",
    FORM16_26AS: "FORM_16_26AS",
    "26AS": "FORM_16_26AS",
    COMPANY_ID: "COMPANY_ID_CARD",
    COMPANY_IDCARD: "COMPANY_ID_CARD",
    GST: "GST_DOCUMENT",
    GST_DOC: "GST_DOCUMENT",
    GST_CERTIFICATE: "GST_DOCUMENT",
    BANK_STATEMENT: "BANK_STATEMENT_1",
    CO_APPLICANT_PASSPORT_PHOTO: "CO_APPLICANT_SELFIE",
  };
  return aliases[key] || key;
}

function limitCategoryForNormalizedDocType(normalized) {
  const key = String(normalized || "").trim().toUpperCase();
  if (!key) return "OTHER";

  if (key === "SELFIE" || key === "CO_APPLICANT_SELFIE") return "SELFIE";
  if (key.startsWith("BANK_STATEMENT")) return "BANK_STATEMENT";

  if (
    key === "TITLE_DEEDS" ||
    key === "AGREEMENT_COPY" ||
    key === "ALLOTMENT_LETTER" ||
    key === "NEW_PROPERTY_PAYMENT_RECEIPTS" ||
    key === "RESALE_PAYMENT_RECEIPTS"
  ) {
    return "PROPERTY_LEGAL";
  }

  if (
    key === "SALARY_SLIP_1" ||
    key === "SALARY_SLIP_2" ||
    key === "SALARY_SLIP_3" ||
    key === "FORM_16_26AS" ||
    key === "ITR" ||
    key === "SHOP_ACT" ||
    key === "GST_DOCUMENT" ||
    key === "SHOP_PHOTO"
  ) {
    return "PAYSLIP_SMALL";
  }

  if (key === "OTHER_DOCS" || key === "BUSINESS_OTHER_DOCS" || key === "UNKNOWN") {
    return "OTHER";
  }

  const idKyc = new Set([
    "PAN",
    "AADHAR_FRONT",
    "AADHAR_BACK",
    "ADDRESS_PROOF",
    "LIGHT_BILL",
    "UTILITY_BILL",
    "RENT_AGREEMENT",
    "PHOTO",
    "COMPANY_ID_CARD",
    "CO_APPLICANT_AADHAR_FRONT",
    "CO_APPLICANT_AADHAR_BACK",
    "CO_APPLICANT_PAN",
    "UDHYAM_AADHAR",
  ]);
  if (idKyc.has(key)) return "ID_KYC";

  return "OTHER";
}

export function getMaxUploadBytesForDocType(docType) {
  const normalized = normalizeDocTypeForLimits(docType);
  const cat = limitCategoryForNormalizedDocType(normalized);
  return DOC_UPLOAD_LIMIT_BYTES[cat];
}

export function maxUploadMbForDocType(docType) {
  return getMaxUploadBytesForDocType(docType) / (1024 * 1024);
}

export function oversizeDocBatchViolation(files, docTypesRaw) {
  if (!files?.length) return null;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const raw = docTypesRaw[i] || "UNKNOWN";
    const normalized = normalizeDocTypeForLimits(raw);
    const max = getMaxUploadBytesForDocType(normalized);
    const size = file.size;
    if (typeof size === "number" && size > max) {
      return { index: i, docType: normalized, maxBytes: max, size };
    }
  }
  return null;
}

export function oversizeSingleDocViolation(file, docTypeRaw) {
  if (!file) return null;
  const normalized = normalizeDocTypeForLimits(docTypeRaw);
  const max = getMaxUploadBytesForDocType(normalized);
  const size = file.size;
  if (typeof size === "number" && size > max) {
    return { docType: normalized, maxBytes: max, size };
  }
  return null;
}

export function formatOversizeMessage(violation) {
  const label = String(violation.docType || "DOCUMENT").replace(/_/g, " ");
  const mb = maxUploadMbForDocType(violation.docType);
  return `${label}: file is larger than ${mb}MB (maximum for this document type). Please upload a smaller file.`;
}

export function extractS3KeyFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

export async function deleteS3ObjectsForUploadedFiles(files) {
  if (!files?.length || !BUCKET_NAME) return;
  await Promise.all(
    files.map(async (f) => {
      const key = f?.key || extractS3KeyFromUrl(f?.location);
      if (!key) return;
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      } catch (e) {
        console.error("Failed to delete rejected upload from S3:", key, e?.message);
      }
    })
  );
}
