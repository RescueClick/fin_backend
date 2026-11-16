import mongoose from "mongoose";

const callingContactSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true },
    phone: { type: String, required: true, trim: true, index: true },
    contactType: {
      type: String,
      enum: ["partner", "customer", "lead"],
      default: "customer",
    },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application", default: null },
    city: { type: String, default: "", trim: true },
    loanType: { type: String, default: "", trim: true },
    leadSource: { type: String, default: "Meta Ads", trim: true },
    status: {
      type: String,
      enum: ["PENDING", "CALLED", "CONNECTED", "UNANSWERED", "CALL_BACK"],
      default: "PENDING",
      index: true,
    },
    callCount: { type: Number, default: 0 },
    lastCallTime: { type: Date, default: null },
    lastCallDuration: { type: Number, default: 0 },
    lastCallType: { type: String, enum: ["OUTGOING", "INCOMING", ""], default: "" },
    isVerified: { type: Boolean, default: false },
    notes: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const rmCallingAssignmentSchema = new mongoose.Schema(
  {
    rmId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    rmName: { type: String, default: "", trim: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    assignedByName: { type: String, default: "Admin", trim: true },
    assignmentType: {
      type: String,
      enum: ["CUSTOMER", "PARTNER"],
      required: true,
      index: true,
    },
    sheetName: { type: String, default: "Calling Sheet", trim: true },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    dailyTarget: { type: Number, default: 25 },
    contacts: [callingContactSchema],
    stats: {
      total: { type: Number, default: 0 },
      called: { type: Number, default: 0 },
      connected: { type: Number, default: 0 },
      pending: { type: Number, default: 0 },
      totalTalkTimeSeconds: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

rmCallingAssignmentSchema.index({ rmId: 1, date: -1 });
rmCallingAssignmentSchema.index({ "contacts.phone": 1 });

export const RmCallingAssignment = mongoose.model(
  "RmCallingAssignment",
  rmCallingAssignmentSchema
);
