import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import {
  TargetError,
  parsePeriod,
  isAdminRole,
  canView,
  getAdminView,
  getRsmView,
  getAsmView,
  getRmView,
  saveAllocations,
  copyFromPreviousMonth,
  lockMonth,
  getTrend,
} from "../utils/salesTargetService.js";

const router = Router();
const STAFF = [ROLES.RSM, ROLES.ASM, ROLES.RM];

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    if (err instanceof TargetError) return res.status(err.status).json({ message: err.message });
    console.error("[sales-targets]", err);
    res.status(500).json({ message: "Something went wrong with targets. Please try again." });
  }
};

function viewFor(role, id, period, viewerIsAdmin) {
  if (role === ROLES.RSM) return getRsmView({ rsmId: id, ...period, viewerIsAdmin });
  if (role === ROLES.ASM) return getAsmView({ asmId: id, ...period, viewerIsAdmin });
  if (role === ROLES.RM) return getRmView({ rmId: id, ...period, viewerIsAdmin });
  throw new TargetError("Unsupported role", 400);
}

/** Only the manager themself (or Admin acting for them) may split their target. */
function resolveManagerId(req) {
  const requested = req.body?.managerId || null;
  if (isAdminRole(req.user.role)) return requested;
  if (req.user.role === ROLES.RSM || req.user.role === ROLES.ASM) {
    if (requested && String(requested) !== String(req.user.sub)) {
      throw new TargetError("You can only split your own target", 403);
    }
    return req.user.sub;
  }
  throw new TargetError("Only Admin, RSM and ASM can assign targets", 403);
}

// GET /api/targets/me?month=&year= — the caller's own target page
router.get(
  "/me",
  auth,
  requireRole(...STAFF),
  handle((req) => {
    const period = parsePeriod(req.query);
    if (isAdminRole(req.user.role)) return getAdminView(period);
    return viewFor(req.user.role, req.user.sub, period, false);
  })
);

// GET /api/targets/view/:role/:id?month=&year= — drill-down into a team member
router.get(
  "/view/:role/:id",
  auth,
  requireRole(...STAFF),
  handle(async (req) => {
    const role = String(req.params.role).toUpperCase();
    if (!STAFF.includes(role)) throw new TargetError("Unsupported role");
    if (!(await canView(req.user, req.params.id, role))) throw new TargetError("You can't view this target", 403);
    return viewFor(role, req.params.id, parsePeriod(req.query), isAdminRole(req.user.role));
  })
);

// PUT /api/targets/allocations { month, year, managerId?, rows: [{userId, disbursementTarget, fileCountTarget}], publish }
router.put(
  "/allocations",
  auth,
  requireRole(ROLES.RSM, ROLES.ASM),
  handle((req) =>
    saveAllocations({
      actor: req.user,
      managerId: resolveManagerId(req),
      ...parsePeriod(req.body),
      rows: req.body?.rows || [],
      publish: Boolean(req.body?.publish),
    })
  )
);

// POST /api/targets/copy-previous { month, year, managerId? }
router.post(
  "/copy-previous",
  auth,
  requireRole(ROLES.RSM, ROLES.ASM),
  handle((req) =>
    copyFromPreviousMonth({ actor: req.user, managerId: resolveManagerId(req), ...parsePeriod(req.body) })
  )
);

// GET /api/targets/trend?year=&role=&userId= — 12-month target vs achieved
router.get(
  "/trend",
  auth,
  requireRole(...STAFF),
  handle(async (req) => {
    const year = parsePeriod({ year: req.query.year, month: 1 }).year;
    const subjectId = req.query.userId || (isAdminRole(req.user.role) ? null : req.user.sub);
    const subjectRole = req.query.role ? String(req.query.role).toUpperCase() : req.user.role;
    if (subjectId && !(await canView(req.user, subjectId, subjectRole))) {
      throw new TargetError("You can't view this target", 403);
    }
    return getTrend({ subjectId, subjectRole, year });
  })
);

// POST /api/targets/lock { month, year } — Admin: freeze achievement for a finished month
router.post(
  "/lock",
  auth,
  requireRole(ROLES.ADMIN),
  handle((req) => lockMonth(parsePeriod(req.body)))
);

export default router;
