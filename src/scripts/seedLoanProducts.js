import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import LoanProduct from "../models/LoanProduct.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../../.env") });

// Standard Applicant & KYC Fields (Step 0)
const commonStep0Fields = [
  { fieldKey: "fullName", label: "Applicant Full Name", fieldType: "text", placeholder: "As per PAN card", validation: { required: true }, stepIndex: 0, order: 1 },
  { fieldKey: "contact", label: "Mobile Number", fieldType: "phone", placeholder: "10-digit mobile number", validation: { required: true }, stepIndex: 0, order: 2 },
  { fieldKey: "email", label: "Email Address", fieldType: "email", placeholder: "example@gmail.com", validation: { required: true }, stepIndex: 0, order: 3 },
  { fieldKey: "dob", label: "Date of Birth", fieldType: "date", placeholder: "DD/MM/YYYY", validation: { required: true }, stepIndex: 0, order: 4 },
  {
    fieldKey: "gender",
    label: "Gender",
    fieldType: "select",
    options: [
      { label: "Male", value: "MALE" },
      { label: "Female", value: "FEMALE" },
      { label: "Other", value: "OTHER" },
    ],
    validation: { required: true },
    stepIndex: 0,
    order: 5,
  },
  { fieldKey: "panNumber", label: "PAN Card Number", fieldType: "text", placeholder: "ABCDE1234F", validation: { required: true }, stepIndex: 0, order: 6 },
  { fieldKey: "aadhaarNumber", label: "Aadhaar Number", fieldType: "text", placeholder: "12-digit Aadhaar number", validation: { required: true }, stepIndex: 0, order: 7 },
];

// Standard Address Fields (Step 1)
const commonStep1Fields = [
  { fieldKey: "currentAddress", label: "Current Residential Address", fieldType: "textarea", placeholder: "House/Flat no, building, street, area", validation: { required: true }, stepIndex: 1, order: 8 },
  { fieldKey: "pincode", label: "Pin Code", fieldType: "number", placeholder: "6-digit PIN code", validation: { required: true }, stepIndex: 1, order: 9 },
  { fieldKey: "city", label: "City", fieldType: "text", placeholder: "e.g. Pune, Mumbai", validation: { required: true }, stepIndex: 1, order: 10 },
  { fieldKey: "state", label: "State", fieldType: "text", placeholder: "e.g. Maharashtra", validation: { required: true }, stepIndex: 1, order: 11 },
  {
    fieldKey: "residenceType",
    label: "Residence Ownership Type",
    fieldType: "select",
    options: [
      { label: "Owned by Self / Spouse", value: "OWNED_SELF" },
      { label: "Owned by Parents", value: "OWNED_PARENTS" },
      { label: "Rented", value: "RENTED" },
      { label: "Company Provided", value: "COMPANY_PROVIDED" },
    ],
    validation: { required: true },
    stepIndex: 1,
    order: 12,
  },
];

// Standard Loan & Banking Details (Step 3)
const commonStep3Fields = [
  { fieldKey: "loanAmount", label: "Requested Loan Amount (₹)", fieldType: "currency", placeholder: "e.g. 500000", validation: { required: true }, stepIndex: 3, order: 20 },
  { fieldKey: "loanTenure", label: "Requested Tenure (Months)", fieldType: "number", placeholder: "e.g. 36", validation: { required: true }, stepIndex: 3, order: 21 },
  {
    fieldKey: "loanPurpose",
    label: "Purpose of Loan",
    fieldType: "select",
    options: [
      { label: "Business Expansion", value: "BUSINESS_EXPANSION" },
      { label: "Working Capital", value: "WORKING_CAPITAL" },
      { label: "Equipment / Machinery Purchase", value: "MACHINERY" },
      { label: "Debt Consolidation", value: "DEBT_CONSOLIDATION" },
      { label: "Personal / Medical Need", value: "PERSONAL_NEED" },
      { label: "Home Renovation", value: "HOME_RENOVATION" },
    ],
    validation: { required: true },
    stepIndex: 3,
    order: 22,
  },
  { fieldKey: "bankName", label: "Disbursement Bank Name", fieldType: "text", placeholder: "e.g. HDFC Bank, SBI", validation: { required: true }, stepIndex: 3, order: 23 },
  { fieldKey: "accountNumber", label: "Bank Account Number", fieldType: "text", placeholder: "Account number for loan transfer", validation: { required: true }, stepIndex: 3, order: 24 },
  { fieldKey: "ifscCode", label: "Bank IFSC Code", fieldType: "text", placeholder: "e.g. HDFC0001234", validation: { required: true }, stepIndex: 3, order: 25 },
];

const defaultLoanProducts = [
  {
    name: "Business Loan",
    code: "BUSINESS",
    slug: "business-loan",
    badgeText: "High Value Collateral-Free",
    description: "Working capital and business expansion loan for enterprises, MSMEs, and proprietorships.",
    minAmount: 100000,
    maxAmount: 10000000,
    minTenureMonths: 12,
    maxTenureMonths: 84,
    interestRateDisplay: "12% - 21%",
    publishToWeb: true,
    publishToPartnerApp: true,
    publishToCustomerApp: true,
    status: "ACTIVE",
    displayOrder: 1,
    steps: [
      { stepIndex: 0, title: "Promoter KYC", description: "Identity & personal details" },
      { stepIndex: 1, title: "Address Details", description: "Residential & communication address" },
      { stepIndex: 2, title: "Business Profile", description: "Constitution, turnover, and GST details" },
      { stepIndex: 3, title: "Loan & Banking", description: "Requested loan & disbursement account" },
    ],
    customFields: [
      ...commonStep0Fields,
      ...commonStep1Fields,
      { fieldKey: "businessName", label: "Registered Entity / Firm Name", fieldType: "text", placeholder: "e.g. Acme Enterprises", validation: { required: true }, stepIndex: 2, order: 13 },
      {
        fieldKey: "businessType",
        label: "Constitution of Business",
        fieldType: "select",
        options: [
          { label: "Proprietorship", value: "PROPRIETORSHIP" },
          { label: "Partnership Firm", value: "PARTNERSHIP" },
          { label: "Private Limited Company", value: "PVT_LTD" },
          { label: "Limited Liability Partnership (LLP)", value: "LLP" },
          { label: "Public Limited", value: "PUBLIC_LTD" },
        ],
        validation: { required: true },
        stepIndex: 2,
        order: 14,
      },
      { fieldKey: "annualTurnover", label: "Annual Turnover (₹)", fieldType: "currency", placeholder: "e.g. 5000000", validation: { required: true }, stepIndex: 2, order: 15 },
      { fieldKey: "gstNumber", label: "GSTIN Number", fieldType: "text", placeholder: "22AAAAA0000A1Z5", validation: { required: false }, stepIndex: 2, order: 16 },
      { fieldKey: "vintageYears", label: "Business Vintage (Years in Operation)", fieldType: "number", placeholder: "e.g. 4", validation: { required: true }, stepIndex: 2, order: 17 },
      {
        fieldKey: "natureOfBusiness",
        label: "Nature of Business",
        fieldType: "select",
        options: [
          { label: "Manufacturing", value: "MANUFACTURING" },
          { label: "Wholesale / Trading", value: "TRADING" },
          { label: "Retail", value: "RETAIL" },
          { label: "Services", value: "SERVICES" },
          { label: "Export / Import", value: "EXPORT_IMPORT" },
        ],
        validation: { required: true },
        stepIndex: 2,
        order: 18,
      },
      { fieldKey: "businessAddress", label: "Principal Office / Factory Address", fieldType: "textarea", placeholder: "Complete business address with pincode", validation: { required: true }, stepIndex: 2, order: 19 },
      ...commonStep3Fields,
    ],
    requiredDocuments: [
      { docType: "PAN", label: "Promoter PAN Card", required: true },
      { docType: "AADHAAR_FRONT", label: "Promoter Aadhaar (Front)", required: true },
      { docType: "AADHAAR_BACK", label: "Promoter Aadhaar (Back)", required: true },
      { docType: "PHOTO", label: "Promoter Photo / Selfie", required: true },
      { docType: "ADDRESS_PROOF", label: "Current Residential Address Proof", required: true },
      { docType: "LIGHT_BILL", label: "Electricity Bill (Current / Office Address)", required: false },
      { docType: "BANK_STATEMENT", label: "Last 12 Months Current Bank Account Statement", required: true },
      { docType: "BANK_STATEMENT_2", label: "Secondary / Savings Account Bank Statement (6 Months)", required: false },
      { docType: "CHEQUE_LEAF", label: "Cancelled Cheque / Passbook Front Page", required: false },
      { docType: "ITR", label: "Last 2 Years ITR with Computation & Financials", required: true },
      { docType: "GST_CERTIFICATE", label: "GST Registration Certificate & 3B Returns", required: false },
      { docType: "BUSINESS_PROOF", label: "Shop Act / Udyam Aadhar / Incorporation Certificate", required: true },
      { docType: "SHOP_PHOTO", label: "Business Office / Shop Photos (Inside & Outside)", required: false },
      { docType: "CO_APPLICANT_PAN", label: "Co-Applicant PAN Card", required: false },
      { docType: "CO_APPLICANT_AADHAAR_FRONT", label: "Co-Applicant Aadhaar (Front & Back)", required: false },
    ],
  },
  {
    name: "Personal Loan",
    code: "PERSONAL",
    slug: "personal-loan",
    badgeText: "Instant Disbursal",
    description: "Unsecured personal financing with fast approval and minimal documentation.",
    minAmount: 25000,
    maxAmount: 2500000,
    minTenureMonths: 6,
    maxTenureMonths: 60,
    interestRateDisplay: "10.5% - 18%",
    publishToWeb: true,
    publishToPartnerApp: true,
    publishToCustomerApp: true,
    status: "ACTIVE",
    displayOrder: 2,
    steps: [
      { stepIndex: 0, title: "Applicant Details", description: "Personal & identity information" },
      { stepIndex: 1, title: "Address Details", description: "Current and permanent residential address" },
      { stepIndex: 2, title: "Employment & Income", description: "Job profile, monthly salary, and employer" },
      { stepIndex: 3, title: "Loan & Banking", description: "Desired loan amount and salary account" },
    ],
    customFields: [
      ...commonStep0Fields,
      ...commonStep1Fields,
      { fieldKey: "companyName", label: "Employer / Company Name", fieldType: "text", placeholder: "e.g. Tata Consultancy Services", validation: { required: true }, stepIndex: 2, order: 13 },
      {
        fieldKey: "employmentType",
        label: "Employment Type",
        fieldType: "select",
        options: [
          { label: "Salaried (Private Ltd)", value: "SALARIED_PVT" },
          { label: "Salaried (Govt / Public Sector)", value: "SALARIED_GOVT" },
          { label: "Self-Employed Professional (Doctor/CA/Lawyer)", value: "SELF_EMPLOYED_PROF" },
          { label: "Self-Employed Non-Professional", value: "SELF_EMPLOYED_NON_PROF" },
        ],
        validation: { required: true },
        stepIndex: 2,
        order: 14,
      },
      { fieldKey: "monthlyIncome", label: "Net Monthly Take-Home Salary (₹)", fieldType: "currency", placeholder: "e.g. 45000", validation: { required: true }, stepIndex: 2, order: 15 },
      { fieldKey: "workExperienceYears", label: "Total Work Experience (Years)", fieldType: "number", placeholder: "e.g. 5", validation: { required: true }, stepIndex: 2, order: 16 },
      {
        fieldKey: "salaryMode",
        label: "Salary Credited Via",
        fieldType: "select",
        options: [
          { label: "Bank Account Transfer (NEFT/RTGS)", value: "BANK_TRANSFER" },
          { label: "Cheque", value: "CHEQUE" },
          { label: "Cash", value: "CASH" },
        ],
        validation: { required: true },
        stepIndex: 2,
        order: 17,
      },
      ...commonStep3Fields,
    ],
    requiredDocuments: [
      { docType: "PAN", label: "Applicant PAN Card", required: true },
      { docType: "AADHAAR_FRONT", label: "Applicant Aadhaar Card (Front)", required: true },
      { docType: "AADHAAR_BACK", label: "Applicant Aadhaar Card (Back)", required: true },
      { docType: "PHOTO", label: "Applicant Photo / Selfie", required: true },
      { docType: "ADDRESS_PROOF", label: "Current Residential Address Proof", required: true },
      { docType: "LIGHT_BILL", label: "Electricity Bill (Current Address)", required: false },
      { docType: "SALARY_SLIP_1", label: "Latest Month Salary Slip (Month 1)", required: true },
      { docType: "SALARY_SLIP_2", label: "Salary Slip (Month 2)", required: true },
      { docType: "SALARY_SLIP_3", label: "Salary Slip (Month 3)", required: true },
      { docType: "BANK_STATEMENT", label: "Latest 6 Months Salary Bank Account Statement", required: true },
      { docType: "BANK_STATEMENT_2", label: "Secondary Bank Account Statement", required: false },
      { docType: "FORM_16", label: "Latest Form 16 / 26AS / Appointment Letter", required: false },
      { docType: "COMPANY_ID_CARD", label: "Company Employee ID Card", required: false },
    ],
  },
  {
    name: "Home Loan",
    code: "HOME_LOAN",
    slug: "home-loan",
    badgeText: "Lowest Interest Rates",
    description: "Financing for purchasing, constructing, or renovating residential properties.",
    minAmount: 500000,
    maxAmount: 50000000,
    minTenureMonths: 60,
    maxTenureMonths: 360,
    interestRateDisplay: "8.35% - 10.5%",
    publishToWeb: true,
    publishToPartnerApp: true,
    publishToCustomerApp: true,
    status: "ACTIVE",
    displayOrder: 3,
    steps: [
      { stepIndex: 0, title: "Applicant Details", description: "Identity, co-applicant & contact info" },
      { stepIndex: 1, title: "Address Details", description: "Current residential address" },
      { stepIndex: 2, title: "Property & Income", description: "Cost, location, builder & property type" },
      { stepIndex: 3, title: "Loan & Banking", description: "Loan tenure & disbursement details" },
    ],
    customFields: [
      ...commonStep0Fields,
      ...commonStep1Fields,
      {
        fieldKey: "propertyType",
        label: "Property Type",
        fieldType: "select",
        options: [
          { label: "Ready to Move Flat / Apartment", value: "READY_FLAT" },
          { label: "Under Construction Apartment", value: "UNDER_CONSTRUCTION" },
          { label: "Independent House / Villa", value: "VILLA" },
          { label: "Plot + Self Construction", value: "PLOT_CONSTRUCTION" },
          { label: "Home Extension / Renovation", value: "RENOVATION" },
        ],
        validation: { required: true },
        stepIndex: 2,
        order: 13,
      },
      { fieldKey: "propertyCost", label: "Total Property Cost / Agreement Value (₹)", fieldType: "currency", placeholder: "e.g. 6000000", validation: { required: true }, stepIndex: 2, order: 14 },
      { fieldKey: "propertyCity", label: "Property Location City", fieldType: "text", placeholder: "e.g. Pune, Bangalore", validation: { required: true }, stepIndex: 2, order: 15 },
      { fieldKey: "monthlyIncome", label: "Applicant Net Monthly Income (₹)", fieldType: "currency", placeholder: "e.g. 75000", validation: { required: true }, stepIndex: 2, order: 16 },
      ...commonStep3Fields,
    ],
    requiredDocuments: [
      { docType: "PAN", label: "Applicant PAN Card", required: true },
      { docType: "AADHAAR_FRONT", label: "Applicant Aadhaar Card (Front)", required: true },
      { docType: "AADHAAR_BACK", label: "Applicant Aadhaar Card (Back)", required: true },
      { docType: "PHOTO", label: "Applicant Photo / Selfie", required: true },
      { docType: "ADDRESS_PROOF", label: "Current Residence Address Proof", required: true },
      { docType: "LIGHT_BILL", label: "Electricity Bill (Current Residence)", required: false },
      { docType: "SALARY_SLIP", label: "Last 3 Months Salary Slips / ITR Financials", required: true },
      { docType: "BANK_STATEMENT", label: "Last 6-12 Months Bank Account Statement", required: true },
      { docType: "PROPERTY_PAPERS", label: "Property Agreement / Allotment Letter / Chain Deeds", required: true },
      { docType: "CHEQUE_LEAF", label: "Cancelled Cheque / Passbook Copy", required: false },
      { docType: "CO_APPLICANT_PAN", label: "Co-Applicant PAN Card", required: false },
      { docType: "CO_APPLICANT_AADHAAR_FRONT", label: "Co-Applicant Aadhaar (Front & Back)", required: false },
    ],
  },
  {
    name: "Loan Against Property (LAP)",
    code: "LAP",
    slug: "loan-against-property",
    badgeText: "High Loan Value",
    description: "Leverage the market value of your residential or commercial property for large capital needs.",
    minAmount: 500000,
    maxAmount: 30000000,
    minTenureMonths: 36,
    maxTenureMonths: 180,
    interestRateDisplay: "9.25% - 13.5%",
    publishToWeb: true,
    publishToPartnerApp: true,
    publishToCustomerApp: true,
    status: "ACTIVE",
    displayOrder: 4,
    steps: [
      { stepIndex: 0, title: "Applicant Details", description: "Applicant & property owner info" },
      { stepIndex: 1, title: "Address Details", description: "Residential details" },
      { stepIndex: 2, title: "Collateral Property", description: "Market value, property type and title" },
      { stepIndex: 3, title: "Loan & Banking", description: "Required amount and repayment tenure" },
    ],
    customFields: [
      ...commonStep0Fields,
      ...commonStep1Fields,
      {
        fieldKey: "collateralType",
        label: "Collateral Property Type",
        fieldType: "select",
        options: [
          { label: "Residential Flat / House", value: "RESIDENTIAL" },
          { label: "Commercial Office / Shop", value: "COMMERCIAL" },
          { label: "Industrial Plot / Shed", value: "INDUSTRIAL" },
        ],
        validation: { required: true },
        stepIndex: 2,
        order: 13,
      },
      { fieldKey: "propertyMarketValue", label: "Estimated Property Market Value (₹)", fieldType: "currency", placeholder: "e.g. 15000000", validation: { required: true }, stepIndex: 2, order: 14 },
      { fieldKey: "propertyAddress", label: "Property Complete Address", fieldType: "textarea", placeholder: "Full address of the property to be mortgaged", validation: { required: true }, stepIndex: 2, order: 15 },
      { fieldKey: "monthlyIncome", label: "Net Monthly Income / Business Turnover (₹)", fieldType: "currency", placeholder: "e.g. 100000", validation: { required: true }, stepIndex: 2, order: 16 },
      ...commonStep3Fields,
    ],
    requiredDocuments: [
      { docType: "PAN", label: "Applicant PAN Card", required: true },
      { docType: "AADHAAR_FRONT", label: "Applicant Aadhaar Card (Front)", required: true },
      { docType: "AADHAAR_BACK", label: "Applicant Aadhaar Card (Back)", required: true },
      { docType: "PHOTO", label: "Applicant Photo / Selfie", required: true },
      { docType: "ADDRESS_PROOF", label: "Residential Address Proof", required: true },
      { docType: "LIGHT_BILL", label: "Electricity Bill", required: false },
      { docType: "SALARY_SLIP", label: "Income Proof / Last 2 Years ITR with Computation", required: true },
      { docType: "BANK_STATEMENT", label: "Last 12 Months Bank Account Statement", required: true },
      { docType: "PROPERTY_PAPERS", label: "Property Title Deed / Sanctioned Plan / Tax Receipts", required: true },
      { docType: "CHEQUE_LEAF", label: "Cancelled Cheque / Passbook Front Page", required: false },
      { docType: "CO_APPLICANT_PAN", label: "Co-Applicant PAN Card", required: false },
      { docType: "CO_APPLICANT_AADHAAR_FRONT", label: "Co-Applicant Aadhaar (Front & Back)", required: false },
    ],
  },
  {
    name: "Car Loan",
    code: "CAR_LOAN",
    slug: "car-loan",
    badgeText: "Lowest Car EMI",
    description: "Financing for new and pre-owned cars with rapid digital approval and flexible tenure.",
    minAmount: 100000,
    maxAmount: 10000000,
    minTenureMonths: 12,
    maxTenureMonths: 84,
    interestRateDisplay: "8.75% - 12.5%",
    publishToWeb: true,
    publishToPartnerApp: true,
    publishToCustomerApp: true,
    status: "ACTIVE",
    displayOrder: 5,
    steps: [
      { stepIndex: 0, title: "Applicant Details", description: "Identity, driving license & contact info" },
      { stepIndex: 1, title: "Address Details", description: "Current and permanent residential address" },
      { stepIndex: 2, title: "Vehicle & Income Details", description: "Car model, make, dealer quotation and income" },
      { stepIndex: 3, title: "Loan & Banking", description: "Requested loan amount & disbursement bank account" },
    ],
    customFields: [
      ...commonStep0Fields,
      ...commonStep1Fields,
      { fieldKey: "vehicleType", label: "Vehicle Condition", fieldType: "select", options: [{ label: "New Car", value: "NEW" }, { label: "Pre-Owned / Used Car", value: "USED" }], validation: { required: true }, stepIndex: 2, order: 13 },
      { fieldKey: "carMakeModel", label: "Car Make & Model", fieldType: "text", placeholder: "e.g. Hyundai Creta SX (O) Petrol", validation: { required: true }, stepIndex: 2, order: 14 },
      { fieldKey: "onRoadPrice", label: "On-Road Price / Valuation (₹)", fieldType: "currency", placeholder: "e.g. 1650000", validation: { required: true }, stepIndex: 2, order: 15 },
      { fieldKey: "monthlyIncome", label: "Net Monthly Income (₹)", fieldType: "currency", placeholder: "e.g. 60000", validation: { required: true }, stepIndex: 2, order: 16 },
      ...commonStep3Fields,
    ],
    requiredDocuments: [
      { docType: "PAN", label: "Applicant PAN Card", required: true },
      { docType: "AADHAAR_FRONT", label: "Applicant Aadhaar Card (Front)", required: true },
      { docType: "AADHAAR_BACK", label: "Applicant Aadhaar Card (Back)", required: true },
      { docType: "PHOTO", label: "Applicant Photo / Selfie", required: true },
      { docType: "DRIVING_LICENSE", label: "Applicant Driving License", required: true },
      { docType: "ADDRESS_PROOF", label: "Current Residential Address Proof", required: true },
      { docType: "LIGHT_BILL", label: "Electricity Bill (Current Address)", required: false },
      { docType: "SALARY_SLIP_1", label: "Latest 3 Months Salary Slips / ITR", required: true },
      { docType: "BANK_STATEMENT", label: "Latest 6 Months Bank Statement", required: true },
      { docType: "VEHICLE_QUOTATION", label: "Dealer Quotation / Proforma Invoice", required: true },
      { docType: "RC_BOOK", label: "Vehicle RC Book (Pre-owned car only)", required: false },
      { docType: "VEHICLE_INSURANCE", label: "Vehicle Comprehensive Insurance Copy", required: false },
    ],
  },
];

async function seedLoanProducts() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL;
    if (!mongoUri) {
      throw new Error("MONGO_URI not found in environment.");
    }

    console.log("Connecting to MongoDB...");
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB successfully.");

    for (const prod of defaultLoanProducts) {
      // Upsert: replace with full complete schema so all complete fields show
      await LoanProduct.findOneAndUpdate(
        { code: prod.code },
        { $set: prod },
        { upsert: true, new: true }
      );
      console.log(`Updated complete loan product schema: ${prod.name} (${prod.code}) with ${prod.customFields.length} fields & ${prod.requiredDocuments.length} docs.`);
    }

    console.log("Complete Loan product seeding completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding loan products:", error);
    process.exit(1);
  }
}

seedLoanProducts();
