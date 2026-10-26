/**
 * Offline check: mandatory doc rules match product expectations (no DB, no HTTP).
 * Run: npm run verify:loan-doc-rules
 */

import {
  findMissingMandatoryDocs,
  getMandatoryDocRules,
} from "../utils/loanMandatoryDocRules.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const doc = (docType) => ({ docType });

const personalFull = [
  doc("AADHAR_FRONT"),
  doc("AADHAR_BACK"),
  doc("PAN"),
  doc("PHOTO"),
  doc("ADDRESS_PROOF"),
  doc("COMPANY_ID_CARD"),
  doc("SALARY_SLIP_1"),
  doc("SALARY_SLIP_2"),
  doc("SALARY_SLIP_3"),
  doc("FORM_16_26AS"),
  doc("BANK_STATEMENT_1"),
  doc("BANK_STATEMENT_2"),
];

// Intentionally no OTHER_DOCS — optional on forms / API
const missPersonal = findMissingMandatoryDocs("PERSONAL", { gender: "Male" }, personalFull);
assert(
  missPersonal.length === 0,
  `PERSONAL without OTHER_DOCS should be complete; missing: ${missPersonal.join(", ")}`
);

const personalRules = getMandatoryDocRules("PERSONAL", {});
const hasOtherDocsRule = personalRules.some((r) => r === "OTHER_DOCS");
assert(!hasOtherDocsRule, "PERSONAL rules must not require OTHER_DOCS");

const homeSalariedRules = getMandatoryDocRules("HOME_LOAN_SALARIED", {});
assert(
  !homeSalariedRules.includes("OTHER_DOCS"),
  "HOME_LOAN_SALARIED rules must not require OTHER_DOCS"
);

// HOME_LOAN_SALARIED without co-applicant should be complete with standard salaried docs
const missHomeNoCo = findMissingMandatoryDocs(
  "HOME_LOAN_SALARIED",
  { gender: "Male", hasCoApplicant: false },
  personalFull
);
assert(
  missHomeNoCo.length === 0,
  `HOME_LOAN_SALARIED without co-applicant should be complete; missing: ${missHomeNoCo.join(", ")}`
);

// HOME_LOAN_SALARIED with co-applicant (Male or Female) MUST require CO_APPLICANT docs
const missHomeWithCo = findMissingMandatoryDocs(
  "HOME_LOAN_SALARIED",
  { gender: "Male", hasCoApplicant: true },
  personalFull
);
assert(
  missHomeWithCo.includes("CO_APPLICANT_AADHAR_FRONT") &&
  missHomeWithCo.includes("CO_APPLICANT_AADHAR_BACK") &&
  missHomeWithCo.includes("CO_APPLICANT_PAN"),
  "HOME_LOAN_SALARIED with co-applicant should require co-applicant documents"
);

// LAP_SALARIED with co-applicant MUST require CO_APPLICANT docs
const missLapSalariedWithCo = findMissingMandatoryDocs(
  "LAP_SALARIED",
  { gender: "Female", hasCoApplicant: true },
  personalFull
);
assert(
  missLapSalariedWithCo.includes("CO_APPLICANT_AADHAR_FRONT") &&
  missLapSalariedWithCo.includes("CO_APPLICANT_PAN"),
  "LAP_SALARIED with co-applicant should require co-applicant documents"
);

// Legacy address types still satisfy ADDRESS_PROOF bucket
const withUtilityOnly = [
  ...personalFull.filter((d) => d.docType !== "ADDRESS_PROOF"),
  doc("UTILITY_BILL"),
];
const missLegacy = findMissingMandatoryDocs("PERSONAL", { gender: "Male" }, withUtilityOnly);
assert(
  missLegacy.length === 0,
  `UTILITY_BILL should satisfy address rule; missing: ${missLegacy.join(", ")}`
);

const businessMinimal = [
  doc("UTILITY_BILL"),
  doc("AADHAR_FRONT"),
  doc("AADHAR_BACK"),
  doc("PAN"),
  doc("PHOTO"),
  doc("SHOP_ACT"),
  doc("UDHYAM_AADHAR"),
  doc("ITR"),
  doc("SHOP_PHOTO"),
  doc("BANK_STATEMENT_1"),
];

// BUSINESS without co-applicant (Male or Female) is complete without co-applicant docs
const missBizNoCo = findMissingMandatoryDocs("BUSINESS", { gender: "Female", hasCoApplicant: false }, businessMinimal);
assert(
  missBizNoCo.length === 0,
  `BUSINESS without co-applicant should be complete; missing: ${missBizNoCo.join(", ")}`
);

// HOME_LOAN_SELF_EMPLOYED with co-applicant (Male) MUST require CO_APPLICANT docs
const missHomeSelfWithCo = findMissingMandatoryDocs(
  "HOME_LOAN_SELF_EMPLOYED",
  { gender: "Male", hasCoApplicant: true },
  businessMinimal
);
assert(
  missHomeSelfWithCo.includes("CO_APPLICANT_AADHAR_FRONT") &&
  missHomeSelfWithCo.includes("CO_APPLICANT_AADHAR_BACK") &&
  missHomeSelfWithCo.includes("CO_APPLICANT_PAN"),
  "HOME_LOAN_SELF_EMPLOYED with co-applicant should require co-applicant documents"
);

// When co-applicant docs are supplied, all 4 loan types pass validation
const coAppDocs = [
  doc("CO_APPLICANT_AADHAR_FRONT"),
  doc("CO_APPLICANT_AADHAR_BACK"),
  doc("CO_APPLICANT_PAN"),
  doc("CO_APPLICANT_SELFIE"),
];

const missHomeWithCoSupplied = findMissingMandatoryDocs(
  "HOME_LOAN_SALARIED",
  { gender: "Male", hasCoApplicant: true },
  [...personalFull, ...coAppDocs]
);
assert(
  missHomeWithCoSupplied.length === 0,
  `HOME_LOAN_SALARIED with co-applicant docs supplied should be complete; missing: ${missHomeWithCoSupplied.join(", ")}`
);

const missLapSelfWithCoSupplied = findMissingMandatoryDocs(
  "LAP_SELF_EMPLOYED",
  { gender: "Male", hasCoApplicant: true },
  [...businessMinimal, ...coAppDocs]
);
assert(
  missLapSelfWithCoSupplied.length === 0,
  `LAP_SELF_EMPLOYED with co-applicant docs supplied should be complete; missing: ${missLapSelfWithCoSupplied.join(", ")}`
);

console.log("OK: loan mandatory document rules verification passed.");
