import {
  normalizeIncomingDocType,
  findMissingMandatoryDocs,
} from "./loanMandatoryDocRules.js";
import {
  oversizeDocBatchViolation,
  formatOversizeMessage,
  deleteS3ObjectsForUploadedFiles,
} from "./docUploadLimits.js";

const EDITABLE_STATUSES = ["LEAD", "DRAFT", "DOC_INCOMPLETE"];

export function isRmEditableApplicationStatus(status) {
  return EDITABLE_STATUSES.includes(String(status || "").toUpperCase());
}

export function validateRmCompletePayload({
  customer = {},
  product = {},
  loanType,
  references = [],
  coApplicant,
}) {
  const errors = [];

  const normalizePhone = (value) => {
    const digits = String(value ?? "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length >= 10) return digits.slice(-10);
    return digits;
  };

  const normalizeEmail = (value) =>
    String(value ?? "").trim().replace(/\s+/g, "");

  customer.email = normalizeEmail(customer.email);
  customer.phone = normalizePhone(customer.phone);
  if (Array.isArray(references)) {
    references = references.map((r) => ({
      ...r,
      phone: normalizePhone(r?.phone),
    }));
  }
  if (coApplicant && typeof coApplicant === "object") {
    coApplicant.phone = normalizePhone(coApplicant.phone);
  }

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

  if (!loanType) errors.push("loanType is required");

  const loanAmt = Number(customer?.loanAmount ?? 0);
  if (!loanAmt || loanAmt <= 0) {
    errors.push("Loan amount must be greater than zero");
  }

  if (["PERSONAL", "HOME_LOAN_SALARIED", "LAP_SALARIED"].includes(loanType || "")) {
    if (!product.companyName) errors.push("Company name is required");
    if (!product.designation) errors.push("Designation is required");
    if (!product.monthlySalary) errors.push("Monthly salary is required");
  }

  if (
    ["BUSINESS", "HOME_LOAN_SELF_EMPLOYED", "LAP_SELF_EMPLOYED"].includes(
      loanType || ""
    )
  ) {
    if (!product.businessName) errors.push("Business name is required");
    if (!product.businessAddress) errors.push("Business address is required");
    if (!product.businessVintage) errors.push("Business vintage is required");
  }

  const refs = Array.isArray(references)
    ? references
    : references
      ? [references]
      : [];

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

  if (
    customer.gender === "Female" &&
    ["BUSINESS", "HOME_LOAN_SELF_EMPLOYED", "LAP_SELF_EMPLOYED"].includes(
      loanType || ""
    ) &&
    !coApplicant?.phone
  ) {
    errors.push(
      "Co-applicant phone is required for female applicants with business, home loan self-employed, or lap self-employed applications"
    );
  }

  return { errors, customer, references: refs, coApplicant };
}

export function buildConditionalSections(loanType, product = {}) {
  let employmentInfo = null;
  let businessInfo = null;
  let propertyInfo = null;

  if (["PERSONAL", "HOME_LOAN_SALARIED", "LAP_SALARIED"].includes(loanType)) {
    employmentInfo = {
      companyName: product.companyName,
      designation: product.designation,
      companyAddress: product.companyAddress || product.currentAddress,
      monthlySalary: product.monthlySalary,
      totalExperience: product.totalExperience,
      currentExperience: product.currentExperience,
      salaryInHand: product.salaryInHand,
    };
  }

  if (
    ["BUSINESS", "HOME_LOAN_SELF_EMPLOYED", "LAP_SELF_EMPLOYED"].includes(
      loanType
    )
  ) {
    businessInfo = {
      businessName: product.businessName,
      businessAddress: product.businessAddress,
      businessLandmark: product.businessLandmark,
      businessVintage: product.businessVintage,
      gstNumber: product.gstNumber,
      annualTurnoverInINR: product.annualTurnoverInINR,
      yearsInBusiness: product.yearsInBusiness,
    };
  }

  if (
    [
      "HOME_LOAN_SALARIED",
      "HOME_LOAN_SELF_EMPLOYED",
      "LAP_SALARIED",
      "LAP_SELF_EMPLOYED",
    ].includes(loanType)
  ) {
    propertyInfo = {
      propertyType: product.propertyType,
      propertyValue: product.propertyValue,
      propertyAddress: product.propertyAddress,
    };
  }

  return { employmentInfo, businessInfo, propertyInfo };
}

export function mergeDocsKeepExisting(existingDocs = [], newDocs = []) {
  if (!newDocs.length) return existingDocs || [];
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

export async function mapUploadedFilesToDocs(req, uploadedBy) {
  const docTypes = Array.isArray(req.body.docTypes)
    ? req.body.docTypes
    : req.body.docTypes
      ? [req.body.docTypes]
      : [];

  if (req.files?.length) {
    const viol = oversizeDocBatchViolation(req.files, docTypes);
    if (viol) {
      await deleteS3ObjectsForUploadedFiles(req.files);
      const err = new Error(formatOversizeMessage(viol));
      err.statusCode = 400;
      throw err;
    }
  }

  return (req.files || []).map((file, index) => {
    if (!file.location) {
      throw new Error("S3 upload failed: missing file location");
    }
    return {
      docType: normalizeIncomingDocType(docTypes[index] || "UNKNOWN"),
      url: file.location,
      uploadedBy,
      status: "PENDING",
      uploadedAt: new Date(),
      updatedAt: new Date(),
      remarks: "Uploaded by RM while completing form",
    };
  });
}

export function applyCompleteFormToApplication(app, {
  customerData,
  employmentInfo,
  businessInfo,
  propertyInfo,
  coApplicant,
  references,
  docsToSave,
  rmId,
}) {
  const missingDocs = findMissingMandatoryDocs(
    app.loanType,
    customerData,
    docsToSave
  );

  app.docs = docsToSave;
  app.customer = { ...(app.customer || {}), ...customerData };
  app.hasRunningLoan = customerData.hasRunningLoan || "NO";
  app.monthlyEmiPaying = customerData.monthlyEmiPaying || 0;
  app.loanPurpose = customerData.loanPurpose || "";
  app.requestedAmount =
    customerData.loanAmount || app.requestedAmount || 0;
  if (employmentInfo) app.employmentInfo = employmentInfo;
  if (businessInfo) app.businessInfo = businessInfo;
  if (propertyInfo) app.propertyInfo = propertyInfo;
  if (coApplicant) app.coApplicant = coApplicant;
  app.references = references;
  if (!app.rmId) app.rmId = rmId;

  const prevStatus = app.status;
  if (missingDocs.length > 0) {
    app.status = "DOC_INCOMPLETE";
  } else if (prevStatus === "DOC_INCOMPLETE") {
    app.status = "DOC_INCOMPLETE";
  } else {
    app.status = "SUBMITTED";
  }

  if (!Array.isArray(app.stageHistory)) app.stageHistory = [];
  app.stageHistory.push({
    from: prevStatus,
    to: app.status,
    by: rmId,
    at: new Date(),
    note: "Loan form completed by RM",
  });

  return { missingDocs, prevStatus };
}
