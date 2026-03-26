// models/User.js
import mongoose from "mongoose";
import { ALL_ROLES, ROLES, RSM_TYPES } from "../config/roles.js";
import { FollowUp } from "../models/followUp.js";

// Document sub-schema for dynamic files
const DocumentSchema = new mongoose.Schema(
  {
    docType: { type: String, required: true }, // e.g., SELFIE, AADHAR, PAN
    url: { type: String, required: true }, // file path
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    status: {
      type: String,
      enum: ["PENDING", "VERIFIED", "REJECTED"],
      default: "PENDING",
    },
    remarks: { type: String },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    // Personal info
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, trim: true },
    lastName: { type: String, required: true, trim: true },
    dob: { type: Date },
    gender: { type: String, enum: ["Male", "Female", "Other"] },
    maritalStatus: {
      type: String,
      enum: ["Single", "Married", "Divorced", "Widowed"],
    },
    mothersName: { type: String, trim: true },

    // Contact info
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
    },
    phone: {
      type: String,
      required: true,
      unique: true,
      match: [/^\d{10}$/, "Please enter a valid 10-digit phone number"],
      trim: true,
    },
    address: { type: String },
    region: { type: String },
    pincode: { type: String },
    homeType: { type: String },
    addressStability: { type: String },
    landmark: { type: String },

    // Employment & Bank info
    employmentType: { type: String },
    experience: { type: String },
    bankName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    ifscCode: { type: String, trim: true },
    accountHolderName: { type: String, trim: true },
    registeredMobile: { type: String, trim: true },

    // Role & hierarchy
    role: { type: String, enum: ALL_ROLES, required: true },
    status: {
      type: String,
      enum: ["ACTIVE", "PENDING", "SUSPENDED"],
      default: "ACTIVE",
    },
    // Hierarchy links
    // For ASM: adminId (set in admin.routes)
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // For RSM: parent ASM
    asmId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // For RM: parent RSMs (split by loan type)
    personalRsmId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    businessHomeRsmId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // For Partner / Customer: parent RM / Partner
    rmId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // RSM specific type (what loan types this RSM owns)
    rsmType: {
      type: String,
      enum: Object.values(RSM_TYPES),
    },

    // Employee identifiers & codes
    employeeId: { type: String, unique: true, sparse: true },
    asmCode: { type: String, unique: true, sparse: true },
    rmCode: { type: String, unique: true, sparse: true },
    partnerCode: { type: String, unique: true, sparse: true },
    aadharNumber: { type: String }, // backward compatibility
    panNumber: { type: String },

    // Uploaded docs
    selfie: { type: String }, // backward compatibility
    adharCard: { type: String }, // backward compatibility
    panCard: { type: String }, // backward compatibility
    docs: [DocumentSchema], // dynamic docs array
    // In User.js
    followUps: [{ type: mongoose.Schema.Types.ObjectId, ref: "FollowUp" }],

    passwordHash: { type: String, required: true },
    deletedAt: { type: Date },

    /** Pending email change (dual verification via old+new email links) */
    pendingEmail: { type: String, lowercase: true, sparse: true, trim: true },
    emailChangeToken: { type: String, sparse: true }, // legacy
    emailChangeTokenOld: { type: String, sparse: true },
    emailChangeTokenNew: { type: String, sparse: true },
    emailChangeOldVerified: { type: Boolean, default: false },
    emailChangeNewVerified: { type: Boolean, default: false },
    emailChangeTokenExpires: { type: Date },
  },
  { timestamps: true }
);

userSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.resetToken;
    delete ret.resetTokenExpiry;
    delete ret.emailChangeToken;
    delete ret.emailChangeTokenOld;
    delete ret.emailChangeTokenNew;
    delete ret.emailChangeTokenExpires;
    return ret;
  },
});

userSchema.set("toObject", {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.resetToken;
    delete ret.resetTokenExpiry;
    delete ret.emailChangeToken;
    delete ret.emailChangeTokenOld;
    delete ret.emailChangeTokenNew;
    delete ret.emailChangeTokenExpires;
    return ret;
  },
});

// Virtual helpers
userSchema.virtual("isAdmin").get(function () {
  return this.role === ROLES.SUPER_ADMIN;
});
userSchema.virtual("isAsm").get(function () {
  return this.role === ROLES.ASM;
});
userSchema.virtual("isRsm").get(function () {
  return this.role === ROLES.RSM;
});
userSchema.virtual("isRm").get(function () {
  return this.role === ROLES.RM;
});
userSchema.virtual("isPartner").get(function () {
  return this.role === ROLES.PARTNER;
});

// TTL index
userSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 0 });
export const User = mongoose.model("User", userSchema);
