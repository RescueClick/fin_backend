import mongoose from "mongoose";

const FieldValidationSchema = new mongoose.Schema(
  {
    required: { type: Boolean, default: false },
    min: { type: Number },
    max: { type: Number },
    pattern: { type: String }, // Regex string (e.g. for PAN, Aadhaar)
    errorMessage: { type: String, default: "" },
  },
  { _id: false }
);

const FieldOptionSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: false }
);

const FormFieldSchema = new mongoose.Schema(
  {
    fieldKey: { type: String, required: true }, // e.g. "carModel", "propertyType"
    label: { type: String, required: true },
    fieldType: {
      type: String,
      enum: ["text", "number", "email", "phone", "select", "radio", "date", "textarea", "currency"],
      default: "text",
    },
    placeholder: { type: String, default: "" },
    options: [FieldOptionSchema],
    validation: FieldValidationSchema,
    gridCol: { type: Number, default: 12 }, // 6 for half-width, 12 for full-width
    stepIndex: { type: Number, default: 0 },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const DocumentRequirementSchema = new mongoose.Schema(
  {
    docType: { type: String, required: true }, // e.g. "PAN", "AADHAAR_FRONT", "SALARY_SLIP"
    label: { type: String, required: true },
    description: { type: String, default: "" },
    required: { type: Boolean, default: true },
    acceptTypes: {
      type: [String],
      default: ["application/pdf", "image/jpeg", "image/png", "image/webp"],
    },
    maxSizeMb: { type: Number, default: 10 },
  },
  { _id: false }
);

const LoanStepSchema = new mongoose.Schema(
  {
    stepIndex: { type: Number, required: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
  },
  { _id: false }
);

const LoanProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // e.g. "Personal Loan"
    code: { type: String, required: true, uppercase: true, unique: true, trim: true }, // e.g. "PERSONAL"
    slug: { type: String, required: true, lowercase: true, unique: true, trim: true }, // e.g. "personal-loan"
    iconUrl: { type: String, default: "" },
    badgeText: { type: String, default: "Instant Approval" },
    description: { type: String, default: "" },

    // Financial Bounds
    minAmount: { type: Number, default: 25000 },
    maxAmount: { type: Number, default: 5000000 },
    minTenureMonths: { type: Number, default: 6 },
    maxTenureMonths: { type: Number, default: 60 },
    interestRateDisplay: { type: String, default: "10.5% - 18%" },

    // Visibility / Publishing toggles
    publishToWeb: { type: Boolean, default: true },
    publishToPartnerApp: { type: Boolean, default: true },
    publishToCustomerApp: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["DRAFT", "ACTIVE", "COMING_SOON", "MAINTENANCE", "ARCHIVED"],
      default: "ACTIVE",
    },
    isComingSoon: { type: Boolean, default: false },
    isUnderMaintenance: { type: Boolean, default: false },
    maintenanceMessage: {
      type: String,
      default: "This loan service is currently undergoing routine maintenance. Please check back shortly.",
    },

    // Dynamic Step Definitions
    steps: {
      type: [LoanStepSchema],
      default: [
        { stepIndex: 0, title: "Applicant Details", description: "Basic personal & contact information" },
        { stepIndex: 1, title: "Employment & Financial", description: "Income, employer, and banking details" },
        { stepIndex: 2, title: "Loan Requirements", description: "Required loan amount and tenure" },
        { stepIndex: 3, title: "Documents Upload", description: "KYC and income proofs" },
      ],
    },

    // Dynamic Fields & Documents
    customFields: [FormFieldSchema],
    requiredDocuments: [DocumentRequirementSchema],

    displayOrder: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const LoanProduct = mongoose.models.LoanProduct || mongoose.model("LoanProduct", LoanProductSchema);

export default LoanProduct;
