export function requireRole(...roles) {
  const allowedRoles = roles.flat(Infinity);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    // Super Admin / Admin has universal administrative access across all protected role routes
    if (req.user.role === "SUPER_ADMIN" || req.user.role === "ADMIN") {
      return next();
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden: insufficient permissions" });
    }
    next();
  };
}
