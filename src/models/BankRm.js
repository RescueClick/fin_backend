import mongoose from "mongoose";

const contactFields = {
  name: { type: String, trim: true, default: "" },
  phone: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, lowercase: true, default: "" },
};

const bankRmSchema = new mongoose.Schema(
  {
    bankNbfcName: { type: String, required: true, trim: true, index: true },
    loginCode: { type: String, required: true, trim: true },
    product: { type: String, required: true, trim: true, index: true },
    marketType: { type: String, required: true, trim: true, index: true },
    city: { type: String, required: true, trim: true, index: true },
    state: { type: String, required: true, trim: true, index: true },
    company: { type: String, required: true, trim: true },

    // Contacts for this bank / product / city
    rm: { type: contactFields, default: () => ({}) },
    asm: { type: contactFields, default: () => ({}) },
    rsm: { type: contactFields, default: () => ({}) },

    // Legacy flat fields (kept so old rows still display)
    rmName: { type: String, trim: true, default: "" },
    rmPhone: { type: String, trim: true, default: "" },
    rmEmail: { type: String, trim: true, lowercase: true, default: "" },

    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const BankRm = mongoose.model("BankRm", bankRmSchema);
