import {
  annotateBanksWithPolicy,
  catalogPolicyForBank,
  matchApplicantToPolicy,
  yearsFieldToMonths,
} from "../utils/lenderPolicy.js";

const assert = (cond, message) => {
  if (!cond) {
    console.error("FAIL:", message);
    process.exitCode = 1;
  }
};

const banks = ["Incred", "Finnabale", "Fibe"].map((bankName, i) => ({
  _id: String(i),
  bankName,
  loanType: "PERSONAL",
  serviceablePincodes: ["560001"],
}));

assert(catalogPolicyForBank(banks[0])?.minNetSalary === 15000, "InCred salary");
assert(catalogPolicyForBank(banks[1])?.minNetSalaryMetro === 20000, "Finnable metro");
assert(catalogPolicyForBank(banks[2])?.maxTenureMonths === 36, "Fibe tenure");
assert(catalogPolicyForBank({ bankName: "Fibe", loanType: "BUSINESS" }) == null, "no business catalog");
assert(yearsFieldToMonths("1") === 12, "1 year");
assert(yearsFieldToMonths("0.5") === 6, "half year");
assert(yearsFieldToMonths("6 months") === 6, "6 months text");

const fit = {
  loanType: "PERSONAL",
  customer: {
    loanAmount: 400000,
    dateOfBirth: "1996-01-01",
    monthlyEmiPaying: 5000,
  },
  employmentInfo: { salaryInHand: "30000", totalExperience: "2", currentExperience: "1" },
};
const fitResult = annotateBanksWithPolicy(banks, fit);
assert(fitResult.policyFilter.hidden === 0, `fit hidden ${fitResult.policyFilter.hidden}`);
assert(fitResult.banks.length === 3, "all three fit");

const lowSalary = {
  ...fit,
  customer: { ...fit.customer, loanAmount: 800000 },
  employmentInfo: { salaryInHand: "18000", totalExperience: "2", currentExperience: "1" },
};
const low = annotateBanksWithPolicy(banks, lowSalary);
const names = low.banks.map((b) => b.bankName.toLowerCase());
assert(names.some((n) => n.includes("fibe")), "Fibe stays even when salary fails");
assert(low.banks.find((b) => b.bankName.toLowerCase().includes("fibe"))?.policyMatch.status === "fail", "Fibe marked outside policy");
assert(names.some((n) => n.includes("incred")), "InCred stays");
assert(low.banks.find((b) => b.bankName.toLowerCase().includes("finna"))?.policyMatch.status === "review", "Finnable metro review");

const heavyEmi = {
  ...fit,
  customer: { ...fit.customer, monthlyEmiPaying: 20000 },
};
const foir = annotateBanksWithPolicy(banks, heavyEmi);
assert(foir.banks.find((b) => /incred/i.test(b.bankName))?.policyMatch.status === "pass", "InCred FOIR 70 allows 66%");
assert(foir.banks.find((b) => /finna/i.test(b.bankName))?.policyMatch.status === "fail", "Finnable FOIR marked fail");
assert(foir.banks.find((b) => /fibe/i.test(b.bankName))?.policyMatch.status === "fail", "Fibe FOIR marked fail");
assert(foir.banks.length === 3, "FOIR fail still keeps every pincode bank");

const young = {
  ...fit,
  customer: { ...fit.customer, dateOfBirth: new Date(new Date().getFullYear() - 20, 0, 1) },
};
const age = annotateBanksWithPolicy(banks, young);
assert(age.banks.find((b) => /incred/i.test(b.bankName))?.policyMatch.status === "fail", "InCred min age 21 marked fail");
assert(age.banks.find((b) => /fibe/i.test(b.bankName))?.policyMatch.status === "pass", "Fibe allows 20");
assert(age.banks.length === 3, "age fail still keeps every pincode bank");

const selfEmployed = { loanType: "BUSINESS", businessInfo: { businessName: "Shop" }, customer: fit.customer };
const incredOnly = matchApplicantToPolicy(catalogPolicyForBank(banks[0]), {
  segment: "SELF_EMPLOYED",
  netSalary: 30000,
  loanAmount: 400000,
  age: 30,
  totalExperienceMonths: 24,
  currentExperienceMonths: 12,
  monthlyEmi: 0,
  creditScore: null,
});
assert(incredOnly.status !== "fail", "InCred allows self-employed");
const finnableOnly = matchApplicantToPolicy(catalogPolicyForBank(banks[1]), {
  segment: "SELF_EMPLOYED",
  netSalary: 30000,
  loanAmount: 400000,
  age: 30,
  totalExperienceMonths: 24,
  currentExperienceMonths: 12,
  monthlyEmi: 0,
  creditScore: 700,
});
assert(finnableOnly.status === "fail", "Finnable salaried only");
assert(selfEmployed.loanType === "BUSINESS", "profile fixture kept");

if (!process.exitCode) console.log("lender policy checks passed");
