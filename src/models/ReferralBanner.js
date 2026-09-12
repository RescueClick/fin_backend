import mongoose from "mongoose";

const referralBannerSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
    },
    subtitle: {
      type: String,
      trim: true,
      default: "",
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    rewardAmount: {
      type: String,
      trim: true,
      default: "",
    },
    badgeText: {
      type: String,
      trim: true,
      default: "",
    },
    imageUrl: {
      type: String,
      trim: true,
      default: "",
    },
    gradientPreset: {
      type: String,
      enum: ["teal", "emerald", "blue", "indigo", "purple", "amber", "rose", "dark"],
      default: "teal",
    },
    iconName: {
      type: String,
      trim: true,
      default: "gift",
    },
    ctaText: {
      type: String,
      trim: true,
      default: "Refer & Earn",
    },
    displayOrder: {
      type: Number,
      default: 0,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    terms: {
      type: String,
      trim: true,
      default: "",
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

export const ReferralBanner = mongoose.model("ReferralBanner", referralBannerSchema);
