import mongoose from "mongoose";
import multer from "multer";
import { isApiError } from "../utils/apiError.js";

function normalizeMongooseValidationError(err) {
  const details = Object.entries(err.errors || {}).map(([path, e]) => ({
    path,
    message: e?.message || "Invalid value",
    kind: e?.kind,
  }));
  return {
    statusCode: 400,
    code: "VALIDATION_ERROR",
    message: "Validation error",
    details,
  };
}

function normalizeMongoDuplicateKeyError(err) {
  const keys = err.keyValue ? Object.keys(err.keyValue) : [];
  return {
    statusCode: 409,
    code: "DUPLICATE_KEY",
    message: keys.length ? `Duplicate value for: ${keys.join(", ")}` : "Duplicate key",
    // Avoid echoing raw duplicate values (e.g., phone/email) in API responses.
    details: keys.length ? keys.map((k) => ({ field: k })) : undefined,
  };
}

export function errorHandler(err, req, res, _next) {
  const isProd = process.env.NODE_ENV === "production";

  let statusCode = 500;
  let code = "INTERNAL_ERROR";
  let message = "Internal server error";
  let details;

  if (isApiError(err)) {
    statusCode = err.statusCode || 500;
    code = err.code || code;
    message = err.message || message;
    details = err.details;
  } else if (err instanceof mongoose.Error.ValidationError) {
    ({ statusCode, code, message, details } = normalizeMongooseValidationError(err));
  } else if (err?.code === 11000) {
    ({ statusCode, code, message, details } = normalizeMongoDuplicateKeyError(err));
  } else if (err?.name === "CastError") {
    statusCode = 400;
    code = "INVALID_ID";
    message = "Invalid identifier";
    details = [{ path: err.path, value: err.value }];
  } else if (err instanceof multer.MulterError) {
    statusCode = 400;
    code = "UPLOAD_ERROR";
    if (err.code === "LIMIT_FILE_SIZE") {
      message =
        "File exceeds the maximum size allowed for this upload. Use a smaller or compressed file.";
    } else if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      message = "Too many files in this upload. Remove optional documents and try again.";
    } else if (err.code === "LIMIT_PART_COUNT" || err.code === "LIMIT_FIELD_VALUE") {
      message = "Upload payload is too large. Try again with fewer or smaller documents.";
    } else {
      message = err.message || "File upload error";
    }
  } else if (
    /ECONNRESET|ETIMEDOUT|TimeoutError|RequestTimeout|socket hang up/i.test(
      String(err?.code || "") + " " + String(err?.message || "")
    )
  ) {
    // Surface transport failures as 504 so the app gets JSON instead of a dead socket when possible.
    statusCode = 504;
    code = "UPLOAD_TIMEOUT";
    message =
      "Upload timed out on the server. Please retry with a stable connection, or upload fewer/smaller PDFs.";
  }

  if (!isProd) {
    // Keep logs server-side; response stays consistent.
    // eslint-disable-next-line no-console
    console.error("API error:", {
      requestId: res.locals?.requestId,
      method: req.method,
      url: req.originalUrl,
      statusCode,
      code,
      message,
      stack: err?.stack,
    });
  }

  const payload = {
    success: false,
    message,
    error: { code, ...(details ? { details } : {}) },
    ...(res.locals?.requestId ? { requestId: res.locals.requestId } : {}),
  };

  if (!isProd && err?.stack) payload.error.stack = err.stack;

  res.status(statusCode).json(payload);
}

