import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { bannerUpload } from "../middleware/bannerUpload.js";
import { ReferralBanner } from "../models/ReferralBanner.js";
import { DEFAULT_REFERRAL_BENEFITS } from "../utils/referralBannerDefaults.js";

const router = Router();

// Middleware to handle optional image upload (supports multipart/form-data with "image" or "banner" field)
const handleBannerImageUpload = (req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    return bannerUpload.fields([
      { name: "image", maxCount: 1 },
      { name: "banner", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        console.error("Referral banner upload middleware error:", err);
        return res.status(400).json({ message: err.message || "Image upload failed" });
      }
      next();
    });
  }
  next();
};

/**
 * GET /api/referral-banners
 * Public / Partner / App endpoint to fetch active referral banners & benefits.
 * If database has no active banners, seeds default benefits so app always looks great.
 */
router.get("/", async (req, res) => {
  try {
    let banners = await ReferralBanner.find({ isActive: true })
      .sort({ displayOrder: 1, createdAt: -1 })
      .lean();

    if (!banners || banners.length === 0) {
      // Check if any banners exist at all
      const totalCount = await ReferralBanner.countDocuments();
      if (totalCount === 0) {
        try {
          await ReferralBanner.insertMany(DEFAULT_REFERRAL_BENEFITS);
          banners = await ReferralBanner.find({ isActive: true })
            .sort({ displayOrder: 1, createdAt: -1 })
            .lean();
        } catch (seedErr) {
          console.warn("Could not seed default referral benefits:", seedErr.message);
          return res.json({ banners: DEFAULT_REFERRAL_BENEFITS });
        }
      }
    }

    res.json({ banners: banners || [] });
  } catch (err) {
    console.error("Error fetching referral banners:", err);
    res.status(500).json({ message: err.message || "Failed to fetch referral banners" });
  }
});

/**
 * GET /api/referral-banners/admin/list
 * Admin only: returns all banners (both active and inactive) with statistics.
 */
router.get("/admin/list", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const banners = await ReferralBanner.find()
      .populate("uploadedBy", "firstName lastName email")
      .sort({ displayOrder: 1, createdAt: -1 })
      .lean();

    const activeCount = banners.filter((b) => b.isActive).length;
    const inactiveCount = banners.length - activeCount;

    res.json({
      banners,
      total: banners.length,
      activeCount,
      inactiveCount,
    });
  } catch (err) {
    console.error("Error listing admin referral banners:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
});

/**
 * GET /api/referral-banners/admin/:id
 * Admin only: get single banner details
 */
router.get("/admin/:id", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const banner = await ReferralBanner.findById(req.params.id)
      .populate("uploadedBy", "firstName lastName email")
      .lean();
    if (!banner) {
      return res.status(404).json({ message: "Referral banner not found" });
    }
    res.json({ banner });
  } catch (err) {
    res.status(500).json({ message: err.message || "Server error" });
  }
});

/**
 * POST /api/referral-banners/admin
 * Admin only: create new referral banner
 */
router.post(
  "/admin",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  handleBannerImageUpload,
  async (req, res) => {
    try {
      const {
        title,
        subtitle,
        description,
        rewardAmount,
        badgeText,
        gradientPreset,
        iconName,
        ctaText,
        displayOrder,
        isActive,
        terms,
        imageUrl: directImageUrl,
      } = req.body;

      if (!title || !title.trim()) {
        return res.status(400).json({ message: "Banner title is required" });
      }

      // Check for uploaded file in either "image" or "banner" field
      let imageUrl = directImageUrl ? String(directImageUrl).trim() : "";
      if (req.files?.image?.[0]?.location) {
        imageUrl = req.files.image[0].location;
      } else if (req.files?.banner?.[0]?.location) {
        imageUrl = req.files.banner[0].location;
      }

      const newBanner = await ReferralBanner.create({
        title: title.trim(),
        subtitle: subtitle ? subtitle.trim() : "",
        description: description ? description.trim() : "",
        rewardAmount: rewardAmount ? rewardAmount.trim() : "",
        badgeText: badgeText ? badgeText.trim() : "",
        imageUrl,
        gradientPreset: gradientPreset || "teal",
        iconName: iconName || "gift",
        ctaText: ctaText ? ctaText.trim() : "Refer & Earn",
        displayOrder: Number(displayOrder) || 0,
        isActive: isActive === undefined ? true : Boolean(isActive === "true" || isActive === true),
        terms: terms ? terms.trim() : "",
        uploadedBy: req.user?.sub,
      });

      res.status(201).json({
        message: "Referral benefit banner created successfully",
        banner: newBanner,
      });
    } catch (err) {
      console.error("Error creating referral banner:", err);
      res.status(500).json({ message: err.message || "Failed to create referral banner" });
    }
  }
);

/**
 * PUT /api/referral-banners/admin/:id
 * Admin only: update referral banner
 */
router.put(
  "/admin/:id",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  handleBannerImageUpload,
  async (req, res) => {
    try {
      const banner = await ReferralBanner.findById(req.params.id);
      if (!banner) {
        return res.status(404).json({ message: "Referral banner not found" });
      }

      const {
        title,
        subtitle,
        description,
        rewardAmount,
        badgeText,
        gradientPreset,
        iconName,
        ctaText,
        displayOrder,
        isActive,
        terms,
        imageUrl: directImageUrl,
      } = req.body;

      if (title !== undefined) banner.title = title.trim();
      if (subtitle !== undefined) banner.subtitle = subtitle.trim();
      if (description !== undefined) banner.description = description.trim();
      if (rewardAmount !== undefined) banner.rewardAmount = rewardAmount.trim();
      if (badgeText !== undefined) banner.badgeText = badgeText.trim();
      if (gradientPreset !== undefined) banner.gradientPreset = gradientPreset;
      if (iconName !== undefined) banner.iconName = iconName;
      if (ctaText !== undefined) banner.ctaText = ctaText.trim();
      if (displayOrder !== undefined) banner.displayOrder = Number(displayOrder) || 0;
      if (isActive !== undefined) {
        banner.isActive = Boolean(isActive === "true" || isActive === true);
      }
      if (terms !== undefined) banner.terms = terms.trim();

      // Check if new image was uploaded
      if (req.files?.image?.[0]?.location) {
        banner.imageUrl = req.files.image[0].location;
      } else if (req.files?.banner?.[0]?.location) {
        banner.imageUrl = req.files.banner[0].location;
      } else if (directImageUrl !== undefined) {
        banner.imageUrl = String(directImageUrl).trim();
      }

      await banner.save();

      res.json({
        message: "Referral benefit banner updated successfully",
        banner,
      });
    } catch (err) {
      console.error("Error updating referral banner:", err);
      res.status(500).json({ message: err.message || "Failed to update referral banner" });
    }
  }
);

/**
 * PATCH /api/referral-banners/admin/:id/toggle
 * Admin only: quickly toggle banner active/inactive
 */
router.patch("/admin/:id/toggle", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const banner = await ReferralBanner.findById(req.params.id);
    if (!banner) {
      return res.status(404).json({ message: "Referral banner not found" });
    }
    banner.isActive = !banner.isActive;
    await banner.save();

    res.json({
      message: `Banner is now ${banner.isActive ? "active" : "inactive"}`,
      banner,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || "Server error" });
  }
});

/**
 * DELETE /api/referral-banners/admin/:id
 * Admin only: delete banner
 */
router.delete("/admin/:id", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const banner = await ReferralBanner.findById(req.params.id);
    if (!banner) {
      return res.status(404).json({ message: "Referral banner not found" });
    }

    await banner.deleteOne();
    res.json({ message: "Referral banner deleted successfully" });
  } catch (err) {
    console.error("Error deleting referral banner:", err);
    res.status(500).json({ message: err.message || "Failed to delete referral banner" });
  }
});

/**
 * POST /api/referral-banners/admin/seed-defaults
 * Admin only: reset/seed default referral benefits
 */
router.post("/admin/seed-defaults", auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const count = await ReferralBanner.countDocuments();
    if (count > 0 && !req.body?.force) {
      return res.status(400).json({
        message: "Referral banners already exist. Pass { force: true } to append defaults.",
      });
    }

    const created = await ReferralBanner.insertMany(DEFAULT_REFERRAL_BENEFITS);
    res.json({
      message: "Default referral benefit banners created successfully",
      count: created.length,
      banners: created,
    });
  } catch (err) {
    console.error("Error seeding referral banners:", err);
    res.status(500).json({ message: err.message || "Failed to seed defaults" });
  }
});

export default router;
