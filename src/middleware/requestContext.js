import crypto from "crypto";

export function requestContext(req, res, next) {
  const incoming = req.headers["x-request-id"];
  const requestId =
    (typeof incoming === "string" && incoming.trim()) ||
    (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));

  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

