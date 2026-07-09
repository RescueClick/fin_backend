/**
 * Mandatory document rules for partner application create / resubmit.
 * Single source of truth for API validation and offline verification script.
 */

export const normalizeDocTypeKey = (docType) => String(docType || "").trim().toUpperCase();

export const normalizeIncomingDocType = (docType) => {
  const key = normalizeDocTypeKey(docType);
  const aliases = {
    AADHAAR_FRONT: "AADHAR_FRONT",
    AADHAAR_BACK: "AADHAR_BACK",
    PASSPORT_PHOTO: "PHOTO",
    OTHER_DOC: "OTHER_DOCS",
    FORM16: "FORM_16_26AS",
    FORM_16: "FORM_16_26AS",
    FORM16_26AS: "FORM_16_26AS",
    "26AS": "FORM_16_26AS",
    COMPANY_ID: "COMPANY_ID_CARD",
    COMPANY_IDCARD: "COMPANY_ID_CARD",
    GST: "GST_DOCUMENT",
    GST_DOC: "GST_DOCUMENT",
    GST_CERTIFICATE: "GST_DOCUMENT",
    BANK_STATEMENT: "BANK_STATEMENT_1",
    CO_APPLICANT_PASSPORT_PHOTO: "CO_APPLICANT_SELFIE",
  };
  return aliases[key] || key;
};

export const getMandatoryDocRules = (loanType, customer = {}) => {
  const isFemale = String(customer?.gender || "").toLowerCase() === "female";

  if (loanType === "PERSONAL") {
    return [
      "AADHAR_FRONT",
      "AADHAR_BACK",
      "PAN",
      { anyOf: ["PHOTO", "SELFIE"], label: "PHOTO_OR_SELFIE" },
      {
        anyOf: ["ADDRESS_PROOF", "LIGHT_BILL", "UTILITY_BILL", "RENT_AGREEMENT"],
        label: "ADDRESS_PROOF",
      },
      "COMPANY_ID_CARD",
      "SALARY_SLIP_1",
      "SALARY_SLIP_2",
      "SALARY_SLIP_3",
      "BANK_STATEMENT_1",
    ];
  }

  if (loanType === "HOME_LOAN_SALARIED") {
    return [
      "AADHAR_FRONT",
      "AADHAR_BACK",
      "PAN",
      { anyOf: ["PHOTO", "SELFIE"], label: "PHOTO_OR_SELFIE" },
      {
        anyOf: ["ADDRESS_PROOF", "LIGHT_BILL", "UTILITY_BILL", "RENT_AGREEMENT"],
        label: "ADDRESS_PROOF",
      },
      "COMPANY_ID_CARD",
      "SALARY_SLIP_1",
      "SALARY_SLIP_2",
      "SALARY_SLIP_3",
      "BANK_STATEMENT_1",
    ];
  }

  const rules = [
    {
      anyOf: ["ADDRESS_PROOF", "LIGHT_BILL", "UTILITY_BILL", "RENT_AGREEMENT"],
      label: "ADDRESS_PROOF",
    },
    "AADHAR_FRONT",
    "AADHAR_BACK",
    "PAN",
    { anyOf: ["PHOTO", "SELFIE"], label: "PHOTO_OR_SELFIE" },
    "SHOP_ACT",
    "UDHYAM_AADHAR",
    "ITR",
    "SHOP_PHOTO",
    "BANK_STATEMENT_1",
  ];

  if (isFemale && (loanType === "BUSINESS" || loanType === "HOME_LOAN_SELF_EMPLOYED")) {
    rules.push("CO_APPLICANT_AADHAR_FRONT");
    rules.push("CO_APPLICANT_AADHAR_BACK");
    rules.push("CO_APPLICANT_PAN");
    rules.push({ anyOf: ["CO_APPLICANT_SELFIE"], label: "CO_APPLICANT_SELFIE_OR_PHOTO" });
  }

  return rules;
};

export const serializeMandatoryDocRules = (rules = []) =>
  rules.map((rule) => {
    if (typeof rule === "string") {
      return { key: rule, acceptedDocTypes: [rule] };
    }

    const acceptedDocTypes = Array.isArray(rule?.anyOf) ? rule.anyOf : [];
    return {
      key: String(rule?.label || acceptedDocTypes.join("_OR_") || "").toUpperCase(),
      acceptedDocTypes,
    };
  });

export const findMissingMandatoryDocs = (loanType, customer, docs = []) => {
  const uploadedTypes = new Set(docs.map((d) => normalizeIncomingDocType(d.docType)));
  const rules = getMandatoryDocRules(loanType, customer);
  const missing = [];

  for (const rule of rules) {
    if (typeof rule === "string") {
      if (!uploadedTypes.has(rule)) missing.push(rule);
      continue;
    }
    if (rule?.anyOf && !rule.anyOf.some((t) => uploadedTypes.has(t))) {
      missing.push(rule.label || rule.anyOf.join("_OR_"));
    }
  }

  return missing;
};
