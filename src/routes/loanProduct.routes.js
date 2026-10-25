import express from "express";
import {
  getPublicLoanProducts,
  getLoanProductByCode,
  getAllLoanProductsAdmin,
  createLoanProduct,
  updateLoanProduct,
  deleteLoanProduct,
} from "../controllers/loanProduct.controller.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = express.Router();

// Public endpoints (Mobile Partner, Mobile Customer, Web)
router.get("/", getPublicLoanProducts);
router.get("/code/:code", getLoanProductByCode);

// Admin management endpoints
router.get("/admin/all", auth, requireRole("ADMIN", "SUPER_ADMIN"), getAllLoanProductsAdmin);
router.post("/admin", auth, requireRole("ADMIN", "SUPER_ADMIN"), createLoanProduct);
router.put("/admin/:id", auth, requireRole("ADMIN", "SUPER_ADMIN"), updateLoanProduct);
router.delete("/admin/:id", auth, requireRole("ADMIN", "SUPER_ADMIN"), deleteLoanProduct);

// Code route alias (placed after admin routes so 'admin' is not treated as a code)
router.get("/:code", getLoanProductByCode);

export default router;
