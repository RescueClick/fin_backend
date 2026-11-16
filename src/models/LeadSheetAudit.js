import mongoose from "mongoose";

const leadSheetRowSchema = new mongoose.Schema(
  {
    phone: { type: String, trim: true, index: true },
    name: { type: String, trim: true },
    email: { type: String, trim: true },
    city: { type: String, trim: true },
    metaLoanType: { type: String, trim: true },
    metaLoanAmount: { type: String, trim: true },
    createdTime: { type: String, trim: true },
    systemStatus: {
      type: String,
      enum: ["EXISTING_PARTNER", "CUSTOMER_LOAN_FILLED", "CUSTOMER_NO_LOAN", "FRESH_LEAD"],
      required: true,
      index: true,
    },
    partnerInfo: {
      partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      employeeId: { type: String, default: "" },
      partnerName: { type: String, default: "" },
      rmName: { type: String, default: "" },
      rmId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    loanInfo: {
      appNo: { type: String, default: "" },
      applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application", default: null },
      loanType: { type: String, default: "" },
      status: { type: String, default: "" },
      amount: { type: Number, default: 0 },
    },
    customerInfo: {
      customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      customerName: { type: String, default: "" },
    },
    rawMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const leadSheetAuditSchema = new mongoose.Schema(
  {
    fileName: { type: String, default: "meta_leads.csv", trim: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    uploadedByName: { type: String, default: "Admin", trim: true },
    uploadedByRole: { type: String, default: "admin", trim: true },
    stats: {
      total: { type: Number, default: 0 },
      existingPartners: { type: Number, default: 0 },
      existingCustomersLoanFilled: { type: Number, default: 0 },
      existingCustomersNoLoan: { type: Number, default: 0 },
      freshLeads: { type: Number, default: 0 },
    },
    rows: [leadSheetRowSchema],
  },
  { timestamps: true }
);

leadSheetAuditSchema.index({ createdAt: -1 });
leadSheetAuditSchema.index({ "rows.phone": 1 });

export const LeadSheetAudit = mongoose.model("LeadSheetAudit", leadSheetAuditSchema);
