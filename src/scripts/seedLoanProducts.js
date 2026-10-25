import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import LoanProduct from "../models/LoanProduct.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../../.env") });

const defaultLoanProducts = [
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
    displayOrder: 1,
    steps: [
      { stepIndex: 0, title: "Applicant Details", description: "Personal & identity information" },
      { stepIndex: 1, title: "Employment & Income", description: "Job profile, monthly salary, and employer" },
      { stepIndex: 2, title: "Loan Requirement", description: "Desired amount and repayment tenure" },
      { stepIndex: 3, title: "Documents", description: "Aadhaar, PAN, Salary slips, Bank statement" },
    ],
    customFields: [
      {
        fieldKey: "employmentType",
        label: "Employment Type",
        fieldType: "select",
        options: [
          { label: "Salaried", value: "SALARIED" },
          { label: "Self-Employed", value: "SELF_EMPLOYED" },
        ],
        validation: { required: true },
        gridCol: 12,
        stepIndex: 1,
        order: 1,
      },
      {
        fieldKey: "monthlyIncome",
        label: "Monthly Net Income (₹)",
        fieldType: "number",
        placeholder: "e.g. 45000",
        validation: { required: true, min: 15000 },
        gridCol: 6,
        stepIndex: 1,
        order: 2,
      },
      {
        fieldKey: "companyName",
        label: "Company / Employer Name",
        fieldType: "text",
        placeholder: "e.g. Infosys Ltd",
        validation: { required: true },
        gridCol: 6,
        stepIndex: 1,
        order: 3,
      },
    ],
    requiredDocuments: [
      { docType: "PAN", label: "PAN Card", required: true },
      { docType: "AADHAAR_FRONT", label: "Aadhaar Card (Front)", required: true },
      { docType: "AADHAAR_BACK", label: "Aadhaar Card (Back)", required: true },
      { docType: "SALARY_SLIP", label: "Latest 3 Months Salary Slips", required: true },
      { docType: "BANK_STATEMENT", label: "Latest 6 Months Bank Statement", required: true },
    ],
  },
  {
    name: "Business Loan",
    code: "BUSINESS",
    slug: "business-loan",
    badgeText: "High Value Collateral-Free",
    description: "Working capital and business expansion loan for enterprises and proprietorships.",
    minAmount: 100000,
    maxAmount: 10000000,
    minTenureMonths: 12,
    maxTenureMonths: 84,
    interestRateDisplay: "12% - 21%",
    publishToWeb: true,
    publishToPartnerApp: true,
    publishToCustomerApp: true,
    status: "ACTIVE",
    displayOrder: 2,
    steps: [
      { stepIndex: 0, title: "Promoter Details", description: "Business owner identity & contact" },
      { stepIndex: 1, title: "Business Information", description: "Company type, GST, and turnover" },
      { stepIndex: 2, title: "Loan Requirement", description: "Loan amount & purpose" },
      { stepIndex: 3, title: "Business Documents", description: "GST returns, ITR, Business proof" },
    ],
    customFields: [
      {
        fieldKey: "businessType",
        label: "Business Constitution",
        fieldType: "select",
        options: [
          { label: "Proprietorship", value: "PROPRIETORSHIP" },
          { label: "Partnership / LLP", value: "PARTNERSHIP" },
          { label: "Pvt Ltd Company", value: "PVT_LTD" },
        ],
        validation: { required: true },
        gridCol: 6,
        stepIndex: 1,
        order: 1,
      },
      {
        fieldKey: "annualTurnover",
        label: "Annual Turnover (₹)",
        fieldType: "number",
        placeholder: "e.g. 5000000",
        validation: { required: true },
        gridCol: 6,
        stepIndex: 1,
        order: 2,
      },
      {
        fieldKey: "gstNumber",
        label: "GST Number",
        fieldType: "text",
        placeholder: "22AAAAA0000A1Z5",
        validation: { required: false },
        gridCol: 12,
        stepIndex: 1,
        order: 3,
      },
    ],
    requiredDocuments: [
      { docType: "PAN", label: "Promoter PAN Card", required: true },
      { docType: "AADHAAR_FRONT", label: "Promoter Aadhaar (Front)", required: true },
      { docType: "AADHAAR_BACK", label: "Promoter Aadhaar (Back)", required: true },
      { docType: "GST_CERTIFICATE", label: "GST Registration Certificate", required: false },
      { docType: "ITR", label: "Last 2 Years ITR with Computation", required: true },
      { docType: "BANK_STATEMENT", label: "Last 12 Months Current Account Statement", required: true },
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
      { stepIndex: 1, title: "Financial Profile", description: "Income, current obligations & CIBIL" },
      { stepIndex: 2, title: "Property Details", description: "Cost, location, builder & property type" },
      { stepIndex: 3, title: "Property & Income Docs", description: "Property papers, salary slips, ITR" },
    ],
    customFields: [
      {
        fieldKey: "propertyCost",
        label: "Total Property Cost (₹)",
        fieldType: "number",
        placeholder: "e.g. 6000000",
        validation: { required: true },
        gridCol: 6,
        stepIndex: 2,
        order: 1,
      },
      {
        fieldKey: "propertyCity",
        label: "Property City / Location",
        fieldType: "text",
        placeholder: "e.g. Pune",
        validation: { required: true },
        gridCol: 6,
        stepIndex: 2,
        order: 2,
      },
    ],
    requiredDocuments: [
      { docType: "PAN", label: "Applicant PAN Card", required: true },
      { docType: "AADHAAR_FRONT", label: "Aadhaar Card (Front)", required: true },
      { docType: "AADHAAR_BACK", label: "Aadhaar Card (Back)", required: true },
      { docType: "SALARY_SLIP", label: "Last 3 Months Salary Slips / ITR", required: true },
      { docType: "BANK_STATEMENT", label: "Last 6 Months Bank Statement", required: true },
      { docType: "PROPERTY_PAPERS", label: "Property Agreement / Allotment Letter", required: false },
    ],
  },
  {
    name: "Loan Against Property (LAP)",
    code: "LAP",
    slug: "loan-against-property",
    badgeText: "High Loan Amount",
    description: "Leverage the market value of your residential or commercial property.",
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
      { stepIndex: 1, title: "Financial Details", description: "Income profile & turnover" },
      { stepIndex: 2, title: "Property Info", description: "Market value and property location" },
      { stepIndex: 3, title: "Documents", description: "Title deeds & KYC" },
    ],
    customFields: [
      {
        fieldKey: "propertyMarketValue",
        label: "Estimated Market Value (₹)",
        fieldType: "number",
        placeholder: "e.g. 10000000",
        validation: { required: true },
        gridCol: 12,
        stepIndex: 2,
        order: 1,
      },
    ],
    requiredDocuments: [
      { docType: "PAN", label: "PAN Card", required: true },
      { docType: "AADHAAR_FRONT", label: "Aadhaar Card (Front)", required: true },
      { docType: "AADHAAR_BACK", label: "Aadhaar Card (Back)", required: true },
      { docType: "SALARY_SLIP", label: "Income Proof / ITR", required: true },
      { docType: "BANK_STATEMENT", label: "Last 6 Months Bank Statement", required: true },
      { docType: "PROPERTY_PAPERS", label: "Property Title Deed / Chain Documents", required: true },
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
      const existing = await LoanProduct.findOne({ code: prod.code });
      if (!existing) {
        await LoanProduct.create(prod);
        console.log(`Created default loan product: ${prod.name} (${prod.code})`);
      } else {
        console.log(`Loan product ${prod.code} already exists. Skipping.`);
      }
    }

    console.log("Loan product seeding completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding loan products:", error);
    process.exit(1);
  }
}

seedLoanProducts();
