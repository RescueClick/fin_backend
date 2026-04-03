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

const missHome = findMissingMandatoryDocs(
  "HOME_LOAN_SALARIED",
  { gender: "Male" },
  personalFull
);
assert(
  missHome.length === 0,
  `HOME_LOAN_SALARIED without OTHER_DOCS should be complete; missing: ${missHome.join(", ")}`
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

// BUSINESS still requires BUSINESS_OTHER_DOCS, not generic OTHER_DOCS
const businessMinimal = [
  doc("UTILITY_BILL"),
  doc("AADHAR_FRONT"),
  doc("AADHAR_BACK"),
  doc("BUSINESS_OTHER_DOCS"),
  doc("PAN"),
  doc("PHOTO"),
  doc("SHOP_ACT"),
  doc("UDHYAM_AADHAR"),
  doc("ITR"),
  doc("GST_DOCUMENT"),
  doc("SHOP_PHOTO"),
  doc("BANK_STATEMENT_1"),
  doc("BANK_STATEMENT_2"),
];
const missBiz = findMissingMandatoryDocs("BUSINESS", { gender: "Male" }, businessMinimal);
assert(
  missBiz.length === 0,
  `BUSINESS with required set (no OTHER_DOCS) should be complete; missing: ${missBiz.join(", ")}`
);

const bizNoBusinessOther = businessMinimal.filter((d) => d.docType !== "BUSINESS_OTHER_DOCS");
const missBiz2 = findMissingMandatoryDocs("BUSINESS", { gender: "Male" }, bizNoBusinessOther);
assert(
  missBiz2.includes("BUSINESS_OTHER_DOCS"),
  "BUSINESS should require BUSINESS_OTHER_DOCS"
);

console.log("OK: loan mandatory document rules verification passed.");
