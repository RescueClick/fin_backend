import { Application, LOAN_TYPES } from "../models/Application.js";
import { loanAmountError } from "./loanFileRules.js";
import { normalizePhoneToTen } from "./phoneNormalize.js";
import { personFinancialFrom } from "./personFinancial.js";

/**
 * Normalizes email address by trimming and removing whitespace.
 */
export function normalizeEmail(value) {
  return String(value ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

/**
 * Normalizes phone number to 10 digits.
 */
export function normalizePhone(value) {
  return normalizePhoneToTen(value);
}

/**
 * Single source of truth for normalizing loan application payloads
 * across Partner Web, Customer Web, React Native Mobile Apps, and RM forms.
 *
 * It seamlessly accepts field name aliases (e.g., contactNo -> phone,
 * dob -> dateOfBirth, wifeName -> spouseName, shopName -> businessName)
 * and outputs a clean, canonical object matching the Mongoose schema.
 */
export function normalizeApplicationPayload(rawPayload = {}) {
  const customerRaw = rawPayload.customer || {};
  const productRaw = rawPayload.product || {};
  const referencesRaw = rawPayload.references || [];
  const coApplicantRaw = rawPayload.coApplicant || {};

  const loanType = String(rawPayload.loanType || "").trim().toUpperCase();

  // Normalize Customer Fields
  const phone = normalizePhone(
    customerRaw.phone || customerRaw.contactNo || customerRaw.mobileNumber || rawPayload.phone
  );
  const alternatePhone = normalizePhone(
    customerRaw.alternatePhone || customerRaw.alternateContact || rawPayload.alternatePhone
  );
  const email = normalizeEmail(customerRaw.email || rawPayload.email);
  const officialEmail = normalizeEmail(customerRaw.officialEmail || rawPayload.officialEmail);
  const panNumber = String(
    customerRaw.panNumber || customerRaw.pan || rawPayload.pan || ""
  ).trim().toUpperCase();
  const dateOfBirth = customerRaw.dateOfBirth || customerRaw.dob || rawPayload.dob || null;

  const currentAddress = String(
    customerRaw.currentAddress || productRaw.currentAddress || rawPayload.currentAddress || ""
  ).trim();
  const currentAddressLandmark = String(
    customerRaw.currentAddressLandmark || customerRaw.currentLandmark || ""
  ).trim();
  const currentAddressPinCode = String(
    customerRaw.currentAddressPinCode ||
    customerRaw.currentAddressPincode ||
    customerRaw.currentPincode ||
    customerRaw.pincode ||
    ""
  ).trim();
  const currentAddressHouseStatus = String(
    customerRaw.currentAddressHouseStatus ||
    customerRaw.currentHouseStatus ||
    customerRaw.currentAddressOwnRented ||
    ""
  ).trim();
  const stabilityOfResidency = String(
    customerRaw.stabilityOfResidency ||
    customerRaw.currentAddressStability ||
    customerRaw.residencyStability ||
    ""
  ).trim();

  const permanentAddress = String(
    customerRaw.permanentAddress || productRaw.permanentAddress || currentAddress || ""
  ).trim();
  const permanentAddressLandmark = String(
    customerRaw.permanentAddressLandmark || customerRaw.permanentLandmark || ""
  ).trim();
  const permanentAddressPinCode = String(
    customerRaw.permanentAddressPinCode ||
    customerRaw.permanentAddressPincode ||
    customerRaw.permanentPincode ||
    ""
  ).trim();
  const permanentAddressHouseStatus = String(
    customerRaw.permanentAddressHouseStatus ||
    customerRaw.permanentHouseStatus ||
    customerRaw.permanentAddressOwnRented ||
    ""
  ).trim();
  const permanentAddressStability = String(
    customerRaw.permanentAddressStability || customerRaw.permanentStability || ""
  ).trim();

  const loanAmount = Number(
    customerRaw.loanAmount || rawPayload.requestedAmount || rawPayload.loanAmount || 0
  );

  const hasRunningLoan = String(
    customerRaw.hasRunningLoan || rawPayload.hasRunningLoan || "NO"
  ).toUpperCase() === "YES" ? "YES" : "NO";

  const monthlyEmiPaying = Number(
    customerRaw.monthlyEmiPaying || rawPayload.monthlyEmiPaying || 0
  );

  const loanPurpose = String(
    customerRaw.loanPurpose || rawPayload.loanPurpose || ""
  ).trim();

  const financialFields = personFinancialFrom({
    ...customerRaw,
    ...rawPayload,
  });

  const normalizedCustomer = {
    firstName: String(customerRaw.firstName || rawPayload.firstName || "").trim(),
    middleName: String(customerRaw.middleName || rawPayload.middleName || "").trim(),
    lastName: String(customerRaw.lastName || customerRaw.surname || rawPayload.lastName || "").trim(),
    email,
    officialEmail: officialEmail || undefined,
    phone,
    alternatePhone: alternatePhone || undefined,
    mothersName: String(customerRaw.mothersName || customerRaw.motherName || rawPayload.motherName || "").trim(),
    panNumber,
    dateOfBirth,
    gender: customerRaw.gender || rawPayload.gender || "",
    maritalStatus: customerRaw.maritalStatus || rawPayload.maritalStatus || "",
    spouseName: String(
      customerRaw.spouseName || customerRaw.wifeName || customerRaw.SpouseName || customerRaw.husbandName || ""
    ).trim(),
    currentAddress,
    currentAddressLandmark,
    currentAddressPinCode,
    currentAddressHouseStatus,
    currentAddressOwnRented: customerRaw.currentAddressOwnRented || currentAddressHouseStatus,
    currentAddressStability: stabilityOfResidency,
    stabilityOfResidency,
    permanentAddress,
    permanentAddressLandmark,
    permanentAddressPinCode,
    permanentAddressHouseStatus,
    permanentAddressOwnRented: customerRaw.permanentAddressOwnRented || permanentAddressHouseStatus,
    permanentAddressStability,
    loanAmount,
    password: customerRaw.password || rawPayload.password,
    bankStatementPassword: customerRaw.bankStatementPassword || rawPayload.bankStatementPassword || "",
    hasRunningLoan,
    monthlyEmiPaying,
    loanPurpose,
    ...financialFields,
  };

  // Normalize Product / Employment Fields
  const normalizedEmployment = {
    companyName: String(productRaw.companyName || customerRaw.companyName || "").trim(),
    designation: String(productRaw.designation || customerRaw.designation || "").trim(),
    companyAddress: String(
      productRaw.companyAddress || productRaw.currentAddress || customerRaw.companyAddress || ""
    ).trim(),
    monthlySalary: String(productRaw.monthlySalary || customerRaw.monthlySalary || "").trim(),
    totalExperience: String(productRaw.totalExperience || customerRaw.totalExperience || "").trim(),
    currentExperience: String(productRaw.currentExperience || customerRaw.currentExperience || "").trim(),
    salaryInHand: String(productRaw.salaryInHand || customerRaw.salaryInHand || financialFields.salaryInHand || "").trim(),
  };

  // Normalize Product / Business Fields
  const businessVintage = String(
    productRaw.businessVintage ||
    productRaw.yearsInBusiness ||
    customerRaw.businessVintage ||
    ""
  ).trim();

  const annualTurnoverInINR = String(
    productRaw.annualTurnoverInINR ||
    productRaw.annualTurnover ||
    customerRaw.annualTurnover ||
    ""
  ).trim();

  const normalizedBusiness = {
    businessName: String(
      productRaw.businessName || productRaw.shopName || productRaw.companyName || customerRaw.businessName || ""
    ).trim(),
    businessAddress: String(
      productRaw.businessAddress || productRaw.shopAddress || productRaw.currentAddress || ""
    ).trim(),
    businessLandmark: String(
      productRaw.businessLandmark || productRaw.shopLandmark || ""
    ).trim(),
    businessVintage,
    yearsInBusiness: businessVintage,
    annualTurnoverInINR,
    gstNumber: String(
      productRaw.gstNumber || productRaw.gst || customerRaw.gstNumber || ""
    ).trim().toUpperCase(),
  };

  // Normalize Product / Property Fields
  const normalizedProperty = {
    propertyType: String(productRaw.propertyType || rawPayload.propertyType || "").trim(),
    propertyValue: Number(productRaw.propertyValue || rawPayload.propertyValue || 0) || undefined,
    propertyAddress: String(productRaw.propertyAddress || rawPayload.propertyAddress || "").trim(),
  };

  // Normalize References
  let normalizedReferences = [];
  if (Array.isArray(referencesRaw) && referencesRaw.length > 0) {
    normalizedReferences = referencesRaw.map((ref) => ({
      name: String(ref?.name || "").trim(),
      phone: normalizePhone(ref?.phone || ref?.contact),
    }));
  } else if (rawPayload.reference1Name || customerRaw.reference1Name) {
    // Legacy flattened references
    const r1Name = rawPayload.reference1Name || customerRaw.reference1Name;
    const r1Phone = rawPayload.reference1Contact || customerRaw.reference1Contact || rawPayload.reference1Phone;
    const r2Name = rawPayload.reference2Name || customerRaw.reference2Name;
    const r2Phone = rawPayload.reference2Contact || customerRaw.reference2Contact || rawPayload.reference2Phone;

    if (r1Name || r1Phone) {
      normalizedReferences.push({ name: String(r1Name || "").trim(), phone: normalizePhone(r1Phone) });
    }
    if (r2Name || r2Phone) {
      normalizedReferences.push({ name: String(r2Name || "").trim(), phone: normalizePhone(r2Phone) });
    }
  }

  // Normalize Co-applicant
  const normalizedCoApplicant = {
    phone: normalizePhone(coApplicantRaw?.phone || rawPayload.coApplicantPhone || customerRaw.coApplicantPhone),
  };

  return {
    loanType,
    customer: normalizedCustomer,
    product: {
      ...normalizedEmployment,
      ...normalizedBusiness,
      ...normalizedProperty,
    },
    employmentInfo: ["PERSONAL", "HOME_LOAN_SALARIED", "LAP_SALARIED"].includes(loanType)
      ? normalizedEmployment
      : null,
    businessInfo: ["BUSINESS", "HOME_LOAN_SELF_EMPLOYED", "LAP_SELF_EMPLOYED"].includes(loanType)
      ? normalizedBusiness
      : null,
    propertyInfo: ["HOME_LOAN_SALARIED", "HOME_LOAN_SELF_EMPLOYED", "LAP_SALARIED", "LAP_SELF_EMPLOYED"].includes(loanType)
      ? normalizedProperty
      : null,
    references: normalizedReferences,
    coApplicant: normalizedCoApplicant,
    partnerReferralCode: rawPayload.partnerReferralCode ? String(rawPayload.partnerReferralCode).trim() : undefined,
    status: rawPayload.status,
  };
}

/**
 * Validates the normalized application payload according to business rules.
 * Returns an array of error messages.
 */
export function validateApplicationPayload({
  customer = {},
  product = {},
  loanType,
  references = [],
  coApplicant,
}) {
  const errors = [];

  if (!customer.firstName) errors.push("Customer first name is required");
  if (!customer.email) errors.push("Customer email is required");
  if (customer.email && !/^\S+@\S+\.\S+$/.test(customer.email)) {
    errors.push("Customer email format is invalid");
  }
  if (!customer.phone) {
    errors.push("Customer phone is required");
  } else if (!/^\d{10}$/.test(String(customer.phone))) {
    errors.push("Customer phone must be 10 digits");
  }

  const upperLoanType = String(loanType || "").trim().toUpperCase();
  if (!upperLoanType) {
    errors.push("A valid loanType is required");
  }

  const loanAmt = Number(customer.loanAmount ?? 0);
  const amountError = loanAmountError(loanAmt, { required: true });
  if (amountError) errors.push(amountError);

  if (["PERSONAL", "HOME_LOAN_SALARIED", "LAP_SALARIED"].includes(loanType || "")) {
    if (!product.companyName) errors.push("Company name is required");
    if (!product.designation) errors.push("Designation is required");
    if (!product.monthlySalary) errors.push("Monthly salary is required");
  }

  if (["BUSINESS", "HOME_LOAN_SELF_EMPLOYED", "LAP_SELF_EMPLOYED"].includes(loanType || "")) {
    if (!product.businessName) errors.push("Business name is required");
    if (!product.businessAddress) errors.push("Business address is required");
    if (!product.businessVintage) errors.push("Business vintage is required");
  }

  const refs = Array.isArray(references) ? references : [];
  if (refs.length < 2) {
    errors.push("At least two references are required");
  }

  refs.forEach((ref, index) => {
    if (!ref?.name) errors.push(`Reference ${index + 1} name is required`);
    if (!ref?.phone) {
      errors.push(`Reference ${index + 1} phone is required`);
    } else if (!/^\d{10}$/.test(String(ref.phone))) {
      errors.push(`Reference ${index + 1} phone must be 10 digits`);
    }
  });

  const isFemale = String(customer.gender || "").toLowerCase() === "female";
  if (
    isFemale &&
    ["BUSINESS", "HOME_LOAN_SELF_EMPLOYED", "LAP_SELF_EMPLOYED"].includes(loanType || "") &&
    !coApplicant?.phone
  ) {
    errors.push(
      "Co-applicant phone is required for female applicants with business, home loan self-employed, or lap self-employed applications"
    );
  }

  return errors;
}

/**
 * Merges newly uploaded documents into existing documents without wiping
 * previously uploaded documents. Updates matching docType or appends new ones.
 */
export function mergeDocsKeepExisting(existingDocs = [], newDocs = []) {
  if (!newDocs || !newDocs.length) return existingDocs || [];
  const byType = new Map();
  for (const doc of existingDocs || []) {
    const key = String(doc.docType || "").toUpperCase();
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(doc);
  }
  const merged = [];
  for (const incoming of newDocs) {
    const key = String(incoming.docType || "").toUpperCase();
    const bucket = byType.get(key) || [];
    if (bucket.length) bucket.shift();
    byType.set(key, bucket);
    merged.push(incoming);
  }
  for (const docs of byType.values()) {
    if (docs?.length) merged.push(...docs);
  }
  return merged;
}

