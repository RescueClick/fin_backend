export function sendSuccess(res, { statusCode = 200, message = "OK", data = null, meta } = {}) {
  const payload = {
    success: true,
    message,
    data,
    ...(meta ? { meta } : {}),
    ...(res.locals?.requestId ? { requestId: res.locals.requestId } : {}),
  };
  return res.status(statusCode).json(payload);
}

