import mongoose from "mongoose";

/**
 * Pre-printed partner QR stickers.
 * Print first with unique serial; later bind serial → partner.
 * Public scan URL: {web}/q/{serial} → redirects to partner share link.
 */
const qrStickerSchema = new mongoose.Schema(
  {
    serial: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["UNASSIGNED", "ASSIGNED", "DISABLED"],
      default: "UNASSIGNED",
      index: true,
    },
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    /** Hint from print batch (rickshaw kit vs café kit) */
    channelHint: {
      type: String,
      enum: ["RICKSHAW", "NET_CAFE", "KIRANA", "OTHER"],
    },
    batchId: { type: String, trim: true, index: true },
    region: { type: String, trim: true },
    city: { type: String, trim: true },
    assignedAt: { type: Date },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

qrStickerSchema.index({ status: 1, createdAt: -1 });

export const QrSticker = mongoose.model("QrSticker", qrStickerSchema);
