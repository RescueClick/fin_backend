import { verifyAccessToken } from "../utils/jwt.js";

export function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Missing token" });
    const decoded = verifyAccessToken(token);
    if (!decoded?.sub) return res.status(401).json({ message: "Invalid token" });
    req.user = decoded; // { sub, role }
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Session expired. Please login again.", code: "TOKEN_EXPIRED" });
    }
    console.error("Auth Middleware Error:", error.message);
    return res.status(401).json({ message: "Unauthorized: Invalid session. Please login again." });
  }
}
