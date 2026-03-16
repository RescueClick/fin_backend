import mongoose from "mongoose";

const followUpSchema = new mongoose.Schema({
    // Target of follow-up (can be Partner, RM, or RSM)
    targetId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Type of follow-up: PARTNER (RM→Partner), RM (RSM→RM), RSM (ASM→RSM)
    followUpType: { 
      type: String, 
      enum: ["PARTNER", "RM", "RSM"], 
      default: "PARTNER" // Backward compatibility
    },
    // For backward compatibility - if partnerId is set, it's a partner follow-up
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Deprecated: use targetId
    status: { type: String, enum: ["Connected", "Ringing", "Switch Off", "Not Reachable"], default: "Not Reachable" },
    remarks: { type: String },
    lastCall: { type: Date },  // date & time of last follow-up
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Who updated (ASM, RSM, or RM)
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
  