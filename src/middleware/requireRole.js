export function requireRole(...roles) {
  const allowedRoles = roles.flat(Infinity);
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
}
