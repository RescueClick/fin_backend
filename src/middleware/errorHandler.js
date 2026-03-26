import mongoose from "mongoose";
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

