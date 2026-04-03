// models/Config.js
import mongoose from "mongoose";

const configSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      enum: [
        "PARTNER_TARGET_POLICY",
        "PUBLIC_LOAN_DEFAULT_PARTNER_CODE",
        "REFERRAL_REWARD_AMOUNTS",
      ],
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { timestamps: true }
);

export const Config = mongoose.model("Config", configSchema);

