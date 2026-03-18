import mongoose from "mongoose";

// =================== CONSTANTS ===================
export const APP_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "DOC_INCOMPLETE",
  "DOC_COMPLETE",
  "LOGIN",
  "DOC_SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "AGREEMENT",
  "REJECTED",
  "DISBURSED",
];

export const LOAN_TYPES = [
  "PERSONAL",
  "BUSINESS",
  "HOME_LOAN_SALARIED",
  "HOME_LOAN_SELF_EMPLOYED"
];



// =================== SUB-SCHEMAS ===================



// 📄 Documents
// // 📄 Sub-schema for uploaded documents
const DocumentSchema = new mongoose.Schema(
  {
    docType: { type: String, required: true }, // PAN, AADHAAR, BANK, INCOME, etc.
    url: { type: String, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    status: { 
      type: String, 
      enum: ["PENDING", "VERIFIED", "REJECTED", "UPDATED"], 
      default: "PENDING" 
    },
    remarks: { type: String },
    uploadedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    verifiedAt: { type: Date },
    rejectedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false }
);

// 📄 Stage history
const StageSchema = new mongoose.Schema(
  {
    from: { type: String },
    to: { type: String },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    at: { type: Date, default: Date.now },
    note: { type: String }
  },
  { _id: false }
);

// 👤 Customer info
const CustomerSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, trim: true },
    lastName: { type: String, trim: true }, // ✅ added surname (your payload uses this)
    email: { type: String, required: true },
    officialEmail: { type: String }, // ✅ made optional instead of requiredm
    phone: { type: String, required: true },
    alternatePhone: { type: String },
    mothersName: { type: String, trim: true },
    panNumber: { type: String, uppercase: true, trim: true },
    dateOfBirth: { type: Date },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
      set: (v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()
    },
    maritalStatus: {
      type: String,
      enum: ["Single", "Married", "Divorced", "Widowed"],
      set: (v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()
    },
    spouseName: { type: String, trim: true }, // ✅ added from payload

    // Common addresses
    currentAddress: { type: String, },
    currentAddressLandmark: { type: String }, // ✅ added
    currentAddressPinCode: { type: String },        // ✅ added
    currentAddressHouseStatus: { type: String },         // ✅ added
    stabilityOfResidency: {type: String},
    currentAddressOwnRented: {type: String},
    currentAddressStability: {type: String},



    permanentAddress: { type: String, },
    permanentAddressLandmark: { type: String },      // ✅ added
    permanentAddressPinCode: { type: String },       // ✅ added
    permanentAddressHouseStatus: { type: String },
    permanentAddressStability: {type: String},
    permanentAddressOwnRented: {type:String},      // ✅ added
    permanentAddressStability:{type:String},

    loanAmount: { type: Number },
    password: { type: String },

    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rmId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    asmId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  },
  { _id: false }
);


// 👔 Employment Info (for Salaried / Personal Loan / Home Salaried)
const EmploymentInfoSchema = new mongoose.Schema(
  {
    companyName: { type: String },
    designation: { type: String },
    companyAddress: { type: String }, // ✅ structured address
    monthlySalary: { type: String },
    totalExperience: { type: String },
    currentExperience: { type: String },
    salaryInHand: { type: String }, // ✅ added

    
  },
  { _id: false }
);

// 🏢 Business Info (for Business Loan / Home Self-Employed)
const BusinessInfoSchema = new mongoose.Schema(
  {

    businessName: { type: String },
    businessAddress: {type:String},
    businessLandmark: {type: String},
    businessVintage: {type: String},
    gstNumber: { type: String },
    annualTurnoverInINR: { type: String },
    yearsInBusiness: { type: String } // ✅ added
  },
  { _id: false }
);

// 🏠 Property Info (for Home Loans)
const PropertyInfoSchema = new mongoose.Schema(
  {
    propertyType: { type: String, enum: ["NEW_PROPERTY", "RESALE_PROPERTY"] },
    propertyValue: { type: Number },   // ✅ added
    propertyAddress: { type: String }  // ✅ added
  },
  
  { _id: false }
);

// 📞 References
const ReferenceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true }
  },
  { _id: false }
);

const CoApplicantSchema = new mongoose.Schema(
  {
    phone: { type: String },
  },
  { _id: false }
);

// =================== MAIN APPLICATION ===================
const ApplicationSchema = new mongoose.Schema(
  {
    appNo: { type: String, unique: true, index: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    rmId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Assigned RSM (set automatically after DOC_COMPLETE based on loanType + RM mapping)
    rsmId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Convenience link to ASM for fast reporting (set when routed to RSM)
    asmId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    
    loanType: {
      type: String,
      enum: LOAN_TYPES,  // ✅ restricts to predefined loan types
      required: true,
    },

    // Common sections
    customer: { type: CustomerSchema, required: true },
    references: [ReferenceSchema],
    docs: [DocumentSchema],
    coApplicant: { type: CoApplicantSchema },
    // Conditional sections
    employmentInfo: { type: EmploymentInfoSchema }, // Personal / Home Salaried
    businessInfo: { type: BusinessInfoSchema },     // Business / Home Self-Employed
    propertyInfo: { type: PropertyInfoSchema },     // Home Loan
    approvedLoanAmount: { type: Number }, // approved/disbursed by RM
    remarks: {type:String},
    requestedAmount:{type: Number},
    // Workflow
    status: { type: String, enum: APP_STATUSES, default: "DRAFT" },
    stageHistory: [StageSchema],
    deletedAt: { type: Date }
  },
  { timestamps: true }
);


// Helper function to get required document types based on loan type
ApplicationSchema.methods.getRequiredDocTypes = function() {
  const baseDocs = ["PAN", "AADHAR_FRONT", "AADHAR_BACK"];
  
  if (this.loanType === "PERSONAL" || this.loanType === "HOME_LOAN_SALARIED") {
    return [...baseDocs, "SALARY_SLIP_1", "BANK_STATEMENT"];
  } else if (this.loanType === "BUSINESS" || this.loanType === "HOME_LOAN_SELF_EMPLOYED") {
    return [...baseDocs, "BANK_STATEMENT", "GST_CERTIFICATE"];
  }
  
  return baseDocs;
};

// Helper function to check if all required documents are verified
ApplicationSchema.methods.areAllDocumentsVerified = function() {
  const requiredDocTypes = this.getRequiredDocTypes();
  const uploadedDocs = this.docs || [];
  
  // Check if all required documents exist and are verified
  for (const docType of requiredDocTypes) {
    const doc = uploadedDocs.find(
      (d) => d.docType?.toUpperCase() === docType.toUpperCase()
    );
    
    // Document must exist and be verified
    if (!doc || doc.status !== "VERIFIED") {
      return false;
    }
  }
  
  return true;
};

// 🚦 State transition guard
ApplicationSchema.methods.transition = function (to, byUserId, note) {
  const allowed = {
    DRAFT: ["SUBMITTED"],
    SUBMITTED: ["DOC_INCOMPLETE", "DOC_COMPLETE"],
    DOC_INCOMPLETE: ["DOC_COMPLETE", "REJECTED"],
    // After RM marks DOC_COMPLETE, RSM must first move to LOGIN, then UNDER_REVIEW
    DOC_COMPLETE: ["LOGIN", "DOC_INCOMPLETE"],
    LOGIN: ["UNDER_REVIEW"],
    UNDER_REVIEW: ["APPROVED", "REJECTED"],
    APPROVED: ["AGREEMENT", "DISBURSED"],
    AGREEMENT: ["DISBURSED"],
    REJECTED: [],
    DISBURSED: []
  };

  const from = this.status;
  if (!allowed[from]?.includes(to)) {
    throw new Error(`Invalid transition ${from} -> ${to}`);
  }

  this.stageHistory.push({ from, to, by: byUserId, note });
  this.status = to;
};


// TTL index
ApplicationSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 0 })


export const Application = mongoose.model("Application", ApplicationSchema);


