import mongoose from "mongoose";

const callLogSchema = new mongoose.Schema(
  {
    rmId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    rmName: { type: String, default: "", trim: true },
    targetPhone: { type: String, required: true, trim: true, index: true },
    targetName: { type: String, default: "", trim: true },
    contactType: {
      type: String,
      enum: ["partner", "customer", "lead", "unknown"],
      default: "partner",
      index: true,
    },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application", default: null },
    callType: {
      type: String,
      enum: ["OUTGOING", "INCOMING", "MISSED", "REJECTED"],
      default: "OUTGOING",
      index: true,
    },
    callStartTime: { type: Date, default: Date.now, index: true },
    callEndTime: { type: Date, default: null },
    durationSeconds: { type: Number, default: 0 },
    isVerifiedRealCall: { type: Boolean, default: false, index: true },
    feedback: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
    source: { type: String, default: "android_native", trim: true },
  },
  { timestamps: true }
);

callLogSchema.index({ rmId: 1, callStartTime: -1 });
callLogSchema.index({ targetPhone: 1, callStartTime: -1 });
callLogSchema.index({ isVerifiedRealCall: 1, callStartTime: -1 });

export const CallLog = mongoose.model("CallLog", callLogSchema);
