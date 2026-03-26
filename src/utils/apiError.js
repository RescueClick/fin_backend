export class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = options.code;
    this.details = options.details;
    this.isOperational = options.isOperational ?? true;
  }
}

export function isApiError(err) {
  return Boolean(err && typeof err === "object" && err.name === "ApiError");
}

