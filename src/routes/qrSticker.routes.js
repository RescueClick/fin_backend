import express from "express";
import mongoose from "mongoose";
import { QrSticker } from "../models/QrSticker.js";
import { User } from "../models/User.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { getReferralWebBaseUrl } from "../config/branding.js";

const router = express.Router();

const CHANNELS = ["RICKSHAW", "NET_CAFE", "KIRANA", "OTHER"];

function normalizeSerial(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

function publicScanUrl(serial) {
  return `${getReferralWebBaseUrl()}/q/${encodeURIComponent(serial)}`;
}

function partnerShareUrl(partnerCode) {
  return `${getReferralWebBaseUrl()}/advisor/${encodeURIComponent(partnerCode)}`;
}

const SERIAL_PAD = 7;

/** Highest numeric suffix already used for prefix (e.g. DSQR → 1000) */
async function getLastSerialNum(prefix) {
  const escapeRe = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await QrSticker.find({
    serial: { $regex: new RegExp(`^${escapeRe}\\d+$`) },
  })
    .select("serial")
    .lean();

  let maxNum = 0;
  for (const r of rows) {
    const n = parseInt(String(r.serial).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > maxNum) maxNum = n;
  }
  return { lastNum: maxNum, totalForPrefix: rows.length };
}

function formatSerial(prefix, num) {
  return `${prefix}${String(num).padStart(SERIAL_PAD, "0")}`;
}

/**
 * GET /api/qr/:serial — public resolve (no auth)
 * Used by web /q/:serial page before redirect.
 */
router.get("/:serial", async (req, res) => {
  try {
    const serial = normalizeSerial(req.params.serial);
    if (!serial) {
      return res.status(400).json({ success: false, message: "Invalid QR serial" });
    }

    const sticker = await QrSticker.findOne({ serial })
      .populate("partnerId", "partnerCode referralCode firstName lastName status partnerChannelType")
      .lean();

    if (!sticker) {
      return res.status(404).json({
        success: false,
        status: "NOT_FOUND",
        message: "This QR code is not in our system.",
        serial,
      });
    }

    if (sticker.status === "DISABLED") {
      return res.status(410).json({
        success: false,
        status: "DISABLED",
        message: "This QR code has been disabled.",
        serial: sticker.serial,
      });
    }

    if (sticker.status !== "ASSIGNED" || !sticker.partnerId) {
      return res.json({
        success: true,
        status: "UNASSIGNED",
        message: "This QR is not activated yet. Ask your partner to claim it.",
        serial: sticker.serial,
        channelHint: sticker.channelHint || null,
        scanUrl: publicScanUrl(sticker.serial),
      });
    }

    const partner = sticker.partnerId;
    if (partner.status !== "ACTIVE") {
      return res.json({
        success: true,
        status: "PARTNER_INACTIVE",
        message: "Partner account is not active yet.",
        serial: sticker.serial,
      });
    }

    const partnerCode = partner.partnerCode || partner.referralCode;
    return res.json({
      success: true,
      status: "ASSIGNED",
      serial: sticker.serial,
      partnerCode,
      partnerName: `${partner.firstName || ""} ${partner.lastName || ""}`.trim(),
      partnerChannelType: partner.partnerChannelType || null,
      redirectUrl: partnerShareUrl(partnerCode),
      scanUrl: publicScanUrl(sticker.serial),
    });
  } catch (err) {
    console.error("QR resolve error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;

/**
 * Admin QR inventory routes — mount under /api/admin/qr-stickers
 */
export const adminQrRouter = express.Router();

adminQrRouter.post(
  "/generate",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      // Allow large print runs: 1 … 20,000 per request
      const count = Math.min(Math.max(Number(req.body.count) || 0, 1), 20000);
      const prefix = String(req.body.prefix || "DSQR")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 12) || "DSQR";
      const channelHint = CHANNELS.includes(String(req.body.channelHint || "").toUpperCase())
        ? String(req.body.channelHint).toUpperCase()
        : null;
      const region = req.body.region ? String(req.body.region).trim() : "";
      const city = req.body.city ? String(req.body.city).trim() : "";
      const batchId =
        String(req.body.batchId || "").trim() ||
        `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString(36).toUpperCase()}`;

      // Fixed digit width so series always continues correctly (DSQR0000001 …)
      const { lastNum } = await getLastSerialNum(prefix);
      const startNum = lastNum + 1;
      const endNum = startNum + count - 1;

      if (endNum > Math.pow(10, SERIAL_PAD) - 1) {
        return res.status(400).json({
          message: `Series would exceed ${prefix}${"9".repeat(SERIAL_PAD)}. Last used: ${lastNum}. Reduce count or use a new prefix.`,
          lastSerial: lastNum > 0 ? formatSerial(prefix, lastNum) : null,
          nextSerial: formatSerial(prefix, startNum),
        });
      }

      const docs = [];
      for (let i = 0; i < count; i++) {
        docs.push({
          serial: formatSerial(prefix, startNum + i),
          status: "UNASSIGNED",
          ...(channelHint ? { channelHint } : {}),
          batchId,
          ...(region ? { region } : {}),
          ...(city ? { city } : {}),
        });
      }

      const created = await QrSticker.insertMany(docs, { ordered: true });
      const firstSerial = created[0]?.serial;
      const lastSerial = created[created.length - 1]?.serial;

      return res.status(201).json({
        success: true,
        message: `Generated ${created.length} QR stickers (${firstSerial} → ${lastSerial})`,
        batchId,
        count: created.length,
        prefix,
        previousLastNum: lastNum,
        startNum,
        endNum,
        firstSerial,
        lastSerial,
        nextSerialAfterThis: formatSerial(prefix, endNum + 1),
        channelHint,
        stickers: created.map((d) => ({
          serial: d.serial,
          scanUrl: publicScanUrl(d.serial),
          status: d.status,
          channelHint: d.channelHint,
          batchId: d.batchId,
        })),
      });
    } catch (err) {
      console.error("QR generate error:", err);
      return res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

/** Preview next serial for a prefix (continues last series) */
adminQrRouter.get(
  "/next-serial",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const prefix = String(req.query.prefix || "DSQR")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 12) || "DSQR";
      const { lastNum, totalForPrefix } = await getLastSerialNum(prefix);
      const nextNum = lastNum + 1;
      return res.json({
        success: true,
        prefix,
        totalForPrefix,
        lastNum,
        lastSerial: lastNum > 0 ? formatSerial(prefix, lastNum) : null,
        nextNum,
        nextSerial: formatSerial(prefix, nextNum),
      });
    } catch (err) {
      console.error("QR next-serial error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/** Export stickers by batch or prefix for vendor Excel re-download */
adminQrRouter.get(
  "/export",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const { batchId, prefix } = req.query;
      const filter = {};
      if (batchId) filter.batchId = String(batchId).trim();
      if (prefix) {
        const p = String(prefix).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        const escapeRe = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.serial = { $regex: new RegExp(`^${escapeRe}\\d+$`) };
      }

      if (!batchId && !prefix) {
        return res.status(400).json({
          message: "Provide batchId or prefix to export",
        });
      }

      const rows = await QrSticker.find(filter)
        .sort({ serial: 1 })
        .limit(50000)
        .lean();

      return res.json({
        success: true,
        count: rows.length,
        batchId: batchId || null,
        stickers: rows.map((d) => ({
          serial: d.serial,
          scanUrl: publicScanUrl(d.serial),
          status: d.status,
          channelHint: d.channelHint || "",
          batchId: d.batchId || "",
          region: d.region || "",
          city: d.city || "",
        })),
      });
    } catch (err) {
      console.error("QR export error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

adminQrRouter.get(
  "/",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const {
        status,
        batchId,
        channelHint,
        search,
        page = 1,
        limit = 50,
      } = req.query;

      const filter = {};
      if (status && ["UNASSIGNED", "ASSIGNED", "DISABLED"].includes(status)) {
        filter.status = status;
      }
      if (batchId) filter.batchId = String(batchId).trim();
      if (channelHint && CHANNELS.includes(String(channelHint).toUpperCase())) {
        filter.channelHint = String(channelHint).toUpperCase();
      }
      if (search) {
        const q = String(search).trim();
        filter.serial = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
      }

      const pageNum = Math.max(1, Number(page) || 1);
      const lim = Math.min(200, Math.max(1, Number(limit) || 50));
      const skip = (pageNum - 1) * lim;

      const [total, rows] = await Promise.all([
        QrSticker.countDocuments(filter),
        QrSticker.find(filter)
          .populate("partnerId", "firstName lastName partnerCode phone status partnerChannelType")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(lim)
          .lean(),
      ]);

      const stats = await QrSticker.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
      const statusCounts = { UNASSIGNED: 0, ASSIGNED: 0, DISABLED: 0 };
      for (const s of stats) {
        if (s._id && statusCounts[s._id] != null) statusCounts[s._id] = s.count;
      }

      return res.json({
        success: true,
        total,
        page: pageNum,
        limit: lim,
        statusCounts,
        stickers: rows.map((r) => ({
          id: r._id,
          serial: r.serial,
          status: r.status,
          channelHint: r.channelHint,
          batchId: r.batchId,
          region: r.region,
          city: r.city,
          assignedAt: r.assignedAt,
          scanUrl: publicScanUrl(r.serial),
          partner: r.partnerId
            ? {
                id: r.partnerId._id,
                name: `${r.partnerId.firstName || ""} ${r.partnerId.lastName || ""}`.trim(),
                partnerCode: r.partnerId.partnerCode,
                phone: r.partnerId.phone,
                status: r.partnerId.status,
                partnerChannelType: r.partnerId.partnerChannelType,
              }
            : null,
        })),
      });
    } catch (err) {
      console.error("QR list error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

adminQrRouter.post(
  "/:serial/assign",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const serial = normalizeSerial(req.params.serial);
      const { partnerId } = req.body;
      if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
        return res.status(400).json({ message: "Valid partnerId is required" });
      }

      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
      }).select("_id partnerCode firstName lastName partnerChannelType assignedQrSerial status");

      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }

      const sticker = await QrSticker.findOne({ serial });
      if (!sticker) {
        return res.status(404).json({ message: "QR sticker not found" });
      }
      if (sticker.status === "DISABLED") {
        return res.status(400).json({ message: "QR is disabled" });
      }
      if (sticker.status === "ASSIGNED" && String(sticker.partnerId) !== String(partnerId)) {
        return res.status(409).json({
          message: "QR already assigned to another partner. Unassign first.",
        });
      }

      // If partner already has a different QR, unassign the old one
      if (partner.assignedQrSerial && partner.assignedQrSerial !== serial) {
        await QrSticker.updateOne(
          { serial: partner.assignedQrSerial, partnerId: partner._id },
          {
            $set: { status: "UNASSIGNED" },
            $unset: { partnerId: 1, assignedAt: 1, assignedBy: 1 },
          }
        );
      }

      sticker.status = "ASSIGNED";
      sticker.partnerId = partner._id;
      sticker.assignedAt = new Date();
      sticker.assignedBy = req.user.sub;
      await sticker.save();

      // Sync channel from sticker hint if partner has none
      const updates = { assignedQrSerial: serial };
      if (!partner.partnerChannelType && sticker.channelHint) {
        updates.partnerChannelType = sticker.channelHint;
        updates.partnerChannelVerified = true;
      }
      await User.updateOne({ _id: partner._id }, { $set: updates });

      return res.json({
        success: true,
        message: `QR ${serial} assigned to ${partner.partnerCode}`,
        serial,
        scanUrl: publicScanUrl(serial),
        redirectUrl: partnerShareUrl(partner.partnerCode),
        partner: {
          id: partner._id,
          partnerCode: partner.partnerCode,
          name: `${partner.firstName} ${partner.lastName}`.trim(),
        },
      });
    } catch (err) {
      console.error("QR assign error:", err);
      return res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

adminQrRouter.post(
  "/:serial/unassign",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const serial = normalizeSerial(req.params.serial);
      const sticker = await QrSticker.findOne({ serial });
      if (!sticker) {
        return res.status(404).json({ message: "QR sticker not found" });
      }

      const partnerId = sticker.partnerId;
      sticker.status = "UNASSIGNED";
      sticker.partnerId = null;
      sticker.assignedAt = undefined;
      sticker.assignedBy = undefined;
      await sticker.save();

      if (partnerId) {
        await User.updateOne(
          { _id: partnerId, assignedQrSerial: serial },
          { $unset: { assignedQrSerial: 1 } }
        );
      }

      return res.json({ success: true, message: `QR ${serial} unassigned` });
    } catch (err) {
      console.error("QR unassign error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

adminQrRouter.patch(
  "/:serial",
  auth,
  requireRole(ROLES.SUPER_ADMIN),
  async (req, res) => {
    try {
      const serial = normalizeSerial(req.params.serial);
      const sticker = await QrSticker.findOne({ serial });
      if (!sticker) {
        return res.status(404).json({ message: "QR sticker not found" });
      }

      if (req.body.status === "DISABLED") {
        if (sticker.partnerId) {
          await User.updateOne(
            { _id: sticker.partnerId, assignedQrSerial: serial },
            { $unset: { assignedQrSerial: 1 } }
          );
        }
        sticker.status = "DISABLED";
        sticker.partnerId = null;
        sticker.assignedAt = undefined;
        sticker.assignedBy = undefined;
      } else if (req.body.status === "UNASSIGNED" && sticker.status === "DISABLED") {
        sticker.status = "UNASSIGNED";
      }

      if (req.body.notes != null) sticker.notes = String(req.body.notes).trim();
      await sticker.save();

      return res.json({ success: true, sticker });
    } catch (err) {
      console.error("QR patch error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Partner QR claim routes — mount under /api/partner/qr-sticker
 */
export const partnerQrRouter = express.Router();

partnerQrRouter.get("/", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const partner = await User.findById(req.user.sub)
      .select("partnerCode assignedQrSerial partnerChannelType")
      .lean();
    if (!partner) {
      return res.status(404).json({ message: "Partner not found" });
    }

    let sticker = null;
    if (partner.assignedQrSerial) {
      sticker = await QrSticker.findOne({ serial: partner.assignedQrSerial }).lean();
    }
    if (!sticker) {
      sticker = await QrSticker.findOne({
        partnerId: partner._id,
        status: "ASSIGNED",
      }).lean();
    }

    if (!sticker) {
      return res.json({
        success: true,
        assigned: false,
        partnerCode: partner.partnerCode,
        shareUrl: partnerShareUrl(partner.partnerCode),
      });
    }

    return res.json({
      success: true,
      assigned: true,
      serial: sticker.serial,
      status: sticker.status,
      channelHint: sticker.channelHint,
      scanUrl: publicScanUrl(sticker.serial),
      shareUrl: partnerShareUrl(partner.partnerCode),
      assignedAt: sticker.assignedAt,
    });
  } catch (err) {
    console.error("Partner QR get error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

partnerQrRouter.post(
  "/claim",
  auth,
  requireRole(ROLES.PARTNER),
  async (req, res) => {
    try {
      const serial = normalizeSerial(req.body.serial);
      if (!serial) {
        return res.status(400).json({ message: "Enter the QR serial printed on the sticker" });
      }

      const partner = await User.findOne({
        _id: req.user.sub,
        role: ROLES.PARTNER,
      }).select("_id partnerCode partnerChannelType assignedQrSerial status");

      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }
      if (partner.status !== "ACTIVE") {
        return res.status(400).json({
          message: "Your account must be ACTIVE before claiming a QR sticker",
        });
      }

      const sticker = await QrSticker.findOne({ serial });
      if (!sticker) {
        return res.status(404).json({ message: "QR serial not found. Check the printed number." });
      }
      if (sticker.status === "DISABLED") {
        return res.status(400).json({ message: "This QR has been disabled" });
      }
      if (
        sticker.status === "ASSIGNED" &&
        sticker.partnerId &&
        String(sticker.partnerId) !== String(partner._id)
      ) {
        return res.status(409).json({
          message: "This QR is already claimed by another partner",
        });
      }

      // Release previous QR if any
      if (partner.assignedQrSerial && partner.assignedQrSerial !== serial) {
        await QrSticker.updateOne(
          { serial: partner.assignedQrSerial, partnerId: partner._id },
          {
            $set: { status: "UNASSIGNED" },
            $unset: { partnerId: 1, assignedAt: 1, assignedBy: 1 },
          }
        );
      }

      sticker.status = "ASSIGNED";
      sticker.partnerId = partner._id;
      sticker.assignedAt = new Date();
      sticker.assignedBy = partner._id;
      await sticker.save();

      const updates = { assignedQrSerial: serial };
      if (!partner.partnerChannelType && sticker.channelHint) {
        updates.partnerChannelType = sticker.channelHint;
        updates.partnerChannelVerified = true;
      } else if (
        sticker.channelHint &&
        partner.partnerChannelType &&
        sticker.channelHint !== partner.partnerChannelType
      ) {
        // Keep partner's declared type; admin can verify later
      }
      await User.updateOne({ _id: partner._id }, { $set: updates });

      return res.json({
        success: true,
        message: "QR sticker claimed successfully",
        serial,
        scanUrl: publicScanUrl(serial),
        shareUrl: partnerShareUrl(partner.partnerCode),
      });
    } catch (err) {
      console.error("Partner QR claim error:", err);
      return res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

/**
 * RM field ops — assign QR to own partners (no bulk generate).
 * Mount under /api/rm/qr-stickers
 */
export const rmQrRouter = express.Router();

rmQrRouter.get(
  "/lookup/:serial",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const serial = normalizeSerial(req.params.serial);
      const sticker = await QrSticker.findOne({ serial })
        .populate("partnerId", "firstName lastName partnerCode rmId status partnerChannelType")
        .lean();
      if (!sticker) {
        return res.status(404).json({ message: "QR serial not found. Check the printed number." });
      }
      return res.json({
        success: true,
        serial: sticker.serial,
        status: sticker.status,
        channelHint: sticker.channelHint,
        scanUrl: publicScanUrl(sticker.serial),
        partner: sticker.partnerId
          ? {
              id: sticker.partnerId._id,
              name: `${sticker.partnerId.firstName || ""} ${sticker.partnerId.lastName || ""}`.trim(),
              partnerCode: sticker.partnerId.partnerCode,
              status: sticker.partnerId.status,
              isMine: String(sticker.partnerId.rmId) === String(req.user.sub),
            }
          : null,
      });
    } catch (err) {
      console.error("RM QR lookup error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

rmQrRouter.get("/", auth, requireRole(ROLES.RM), async (req, res) => {
  try {
    const rmId = req.user.sub;
    const myPartners = await User.find({ role: ROLES.PARTNER, rmId })
      .select("_id")
      .lean();
    const partnerIds = myPartners.map((p) => p._id);

    const stickers = await QrSticker.find({
      partnerId: { $in: partnerIds },
      status: "ASSIGNED",
    })
      .populate("partnerId", "firstName lastName partnerCode phone partnerChannelType status")
      .sort({ assignedAt: -1 })
      .limit(100)
      .lean();

    return res.json({
      success: true,
      stickers: stickers.map((r) => ({
        serial: r.serial,
        status: r.status,
        channelHint: r.channelHint,
        scanUrl: publicScanUrl(r.serial),
        assignedAt: r.assignedAt,
        partner: r.partnerId
          ? {
              id: r.partnerId._id,
              name: `${r.partnerId.firstName || ""} ${r.partnerId.lastName || ""}`.trim(),
              partnerCode: r.partnerId.partnerCode,
              phone: r.partnerId.phone,
              partnerChannelType: r.partnerId.partnerChannelType,
              status: r.partnerId.status,
            }
          : null,
      })),
    });
  } catch (err) {
    console.error("RM QR list error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

rmQrRouter.post(
  "/:serial/assign",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub;
      const serial = normalizeSerial(req.params.serial);
      const { partnerId } = req.body;

      if (!partnerId || !mongoose.Types.ObjectId.isValid(partnerId)) {
        return res.status(400).json({ message: "Select a partner" });
      }

      const partner = await User.findOne({
        _id: partnerId,
        role: ROLES.PARTNER,
        rmId,
      }).select("_id partnerCode firstName lastName partnerChannelType assignedQrSerial status");

      if (!partner) {
        return res.status(404).json({
          message: "Partner not found under your team. Register/activate them first.",
        });
      }
      if (partner.status !== "ACTIVE") {
        return res.status(400).json({
          message: "Activate the partner first, then assign QR.",
        });
      }

      const sticker = await QrSticker.findOne({ serial });
      if (!sticker) {
        return res.status(404).json({ message: "QR serial not found" });
      }
      if (sticker.status === "DISABLED") {
        return res.status(400).json({ message: "This QR is disabled" });
      }

      // If QR is already on another partner: allow transfer only within this RM's team
      if (
        sticker.status === "ASSIGNED" &&
        sticker.partnerId &&
        String(sticker.partnerId) !== String(partnerId)
      ) {
        const previousOwner = await User.findOne({
          _id: sticker.partnerId,
          role: ROLES.PARTNER,
          rmId,
        }).select("_id partnerCode");

        if (!previousOwner) {
          return res.status(409).json({
            message: "QR already assigned to another RM’s partner",
          });
        }

        await User.updateOne(
          { _id: previousOwner._id, assignedQrSerial: serial },
          { $unset: { assignedQrSerial: 1 } }
        );
      }

      // Partner already has a different QR → free the old sticker
      if (partner.assignedQrSerial && partner.assignedQrSerial !== serial) {
        await QrSticker.updateOne(
          { serial: partner.assignedQrSerial, partnerId: partner._id },
          {
            $set: { status: "UNASSIGNED" },
            $unset: { partnerId: 1, assignedAt: 1, assignedBy: 1 },
          }
        );
      }

      sticker.status = "ASSIGNED";
      sticker.partnerId = partner._id;
      sticker.assignedAt = new Date();
      sticker.assignedBy = rmId;
      await sticker.save();

      const updates = { assignedQrSerial: serial };
      if (!partner.partnerChannelType && sticker.channelHint) {
        updates.partnerChannelType = sticker.channelHint;
        updates.partnerChannelVerified = true;
      }
      await User.updateOne({ _id: partner._id }, { $set: updates });

      const replaced = Boolean(
        partner.assignedQrSerial && partner.assignedQrSerial !== serial
      );

      return res.json({
        success: true,
        message: replaced
          ? `QR ${serial} replaced previous sticker on ${partner.partnerCode}`
          : `QR ${serial} assigned to ${partner.partnerCode}`,
        serial,
        replaced,
        previousSerial: replaced ? partner.assignedQrSerial : null,
        scanUrl: publicScanUrl(serial),
        redirectUrl: partnerShareUrl(partner.partnerCode),
      });
    } catch (err) {
      console.error("RM QR assign error:", err);
      return res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

rmQrRouter.post(
  "/:serial/unassign",
  auth,
  requireRole(ROLES.RM),
  async (req, res) => {
    try {
      const rmId = req.user.sub;
      const serial = normalizeSerial(req.params.serial);
      const sticker = await QrSticker.findOne({ serial });
      if (!sticker || sticker.status !== "ASSIGNED" || !sticker.partnerId) {
        return res.status(404).json({ message: "Assigned QR not found" });
      }

      const partner = await User.findOne({
        _id: sticker.partnerId,
        role: ROLES.PARTNER,
        rmId,
      }).select("_id");
      if (!partner) {
        return res.status(403).json({
          message: "You can only unassign QRs for your own partners",
        });
      }

      sticker.status = "UNASSIGNED";
      sticker.partnerId = null;
      sticker.assignedAt = undefined;
      sticker.assignedBy = undefined;
      await sticker.save();

      await User.updateOne(
        { _id: partner._id, assignedQrSerial: serial },
        { $unset: { assignedQrSerial: 1 } }
      );

      return res.json({ success: true, message: `QR ${serial} unassigned` });
    } catch (err) {
      console.error("RM QR unassign error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);
