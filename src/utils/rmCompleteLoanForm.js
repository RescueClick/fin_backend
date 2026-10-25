import {
  normalizeIncomingDocType,
  findMissingMandatoryDocs,
} from "./loanMandatoryDocRules.js";
import { personFinancialFrom } from "./personFinancial.js";
import {
  oversizeDocBatchViolation,
  formatOversizeMessage,
  deleteS3ObjectsForUploadedFiles,
} from "./docUploadLimits.js";
import {
  normalizeApplicationPayload,
  validateApplicationPayload,
} from "./applicationPayloadHelper.js";

const EDITABLE_STATUSES = ["LEAD", "DRAFT", "DOC_INCOMPLETE"];

export function isRmEditableApplicationStatus(status) {
  return EDITABLE_STATUSES.includes(String(status || "").toUpperCase());
}

export function validateRmCompletePayload(payload = {}) {
  const normalized = normalizeApplicationPayload(payload);
  const errors = validateApplicationPayload(normalized);

  return {
    errors,
    customer: normalized.customer,
    references: normalized.references,
    coApplicant: normalized.coApplicant,
    product: normalized.product,
    employmentInfo: normalized.employmentInfo,
    businessInfo: normalized.businessInfo,
    propertyInfo: normalized.propertyInfo,
  };
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
      businessVintage: product.businessVintage || product.yearsInBusiness,
      gstNumber: product.gstNumber,
      annualTurnoverInINR: product.annualTurnoverInINR || product.annualTurnover,
      yearsInBusiness: product.yearsInBusiness || product.businessVintage,
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
  const personFinancial = personFinancialFrom(customerData);
  app.salaryInHand = personFinancial.salaryInHand;
  app.salaryReceiptMode = personFinancial.salaryReceiptMode;
  app.cibilScoreBand = personFinancial.cibilScoreBand;
  app.hasBounce = personFinancial.hasBounce;
  app.bounceCount = personFinancial.bounceCount;
  app.customer = {
    ...(app.customer || {}),
    ...personFinancial,
  };
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
