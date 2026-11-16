import mongoose from "mongoose";

const followUpSchema = new mongoose.Schema({
    // Target of follow-up (can be Partner, RM, ASM, RSM, or Customer/Application)
    targetId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application", default: null },
    // Type of follow-up: PARTNER, RM, RSM, ASM, CUSTOMER
    followUpType: { 
      type: String, 
      enum: ["PARTNER", "RM", "RSM", "ASM", "CUSTOMER"], 
      default: "PARTNER"
    },
    // For backward compatibility - if partnerId is set, it's a partner follow-up
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    status: { type: String, default: "Not Reachable" },
    remarks: { type: String, default: "" },
    nextFollowUpDate: { type: Date, default: null },
    lastCall: { type: Date, default: Date.now },
    durationSeconds: { type: Number, default: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  }, { timestamps: true });

  // Pre-save hook to set targetId from partnerId for backward compatibility
  followUpSchema.pre("save", function(next) {
    if (this.partnerId && !this.targetId) {
      this.targetId = this.partnerId;
      this.followUpType = "PARTNER";
    }
    next();
  });
  
  export const FollowUp = mongoose.model("FollowUp", followUpSchema);
  