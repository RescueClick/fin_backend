/**
 * Salaried underwriting matrix (InCred, Finnable, Fibe).
 * Same object is shown on bank cards and used to filter a loan file.
 * A saved bank policy overrides the sheet. A matching bank name fills the sheet
 * until an admin saves their own numbers.
 */

const SALARIED_MATRIX = {
  INCRED: {
    lenderKey: "INCRED",
    source: "SALARIED_MATRIX",
    productLabel: "Salaried & self-employed personal loan",
    minNetSalary: 15000,
    minNetSalaryMetro: null,
    minNetSalarySmallTicket: null,
    smallTicketMaxAmount: null,
    maxLoanAmount: 1500000,
    maxTenureMonths: 60,
    foreclosureNote: "~4%–5% after 6 months",
    employmentSegments: ["SALARIED", "SELF_EMPLOYED"],
    minAge: 21,
    maxAge: 60,
    ageReviewFrom: null,
    ageNote: "21 to 60 years",
    salaryChannel: "Direct bank credit (NEFT/ACH)",
    minTotalExperienceMonths: 12,
    minCurrentExperienceMonths: 3,
    vintageNote: "Total ≥ 1 year; current company ≥ 3–6 months",
    creditScoreMode: "PREFERRED",
    minCreditScore: 650,
    creditScoreNote: "650+ preferred; thin-file is flexible",
    maxFoirPercent: 70,
    foirNote: "Up to 65%–70%",
    verification: {
      kyc: "Real-time PAN (NSDL) + Aadhaar via DigiLocker",
      banking: "3–6 months statement via net banking or account aggregator",
      salary: "Latest 3 months salary slips with deductions",
      workCheck: "Corporate work email OTP or employee ID",
    },
  },
  FINNABLE: {
    lenderKey: "FINNABLE",
    source: "SALARIED_MATRIX",
    productLabel: "Strictly salaried personal loan",
    minNetSalary: 15000,
    minNetSalaryMetro: 20000,
    minNetSalarySmallTicket: null,
    smallTicketMaxAmount: null,
    maxLoanAmount: 1000000,
    maxTenureMonths: 60,
    foreclosureNote: "3%–6% tiered",
    employmentSegments: ["SALARIED"],
    minAge: 21,
    maxAge: 60,
    ageReviewFrom: 56,
    ageNote: "21 to 55–60 years (confirm the upper band)",
    salaryChannel: "Direct bank credit (NEFT/ACH)",
    minTotalExperienceMonths: 6,
    minCurrentExperienceMonths: 3,
    vintageNote: "Total ≥ 6 months; current company ≥ 3 months",
    creditScoreMode: "HARD",
    minCreditScore: 650,
    creditScoreNote: "650–675+; NTC (C-1) if no score on file",
    maxFoirPercent: 65,
    foirNote: "Up to 50%–65%",
    verification: {
      kyc: "Mobile-linked Aadhaar OTP + PAN verification",
      banking: "3 to 6 months operative salary credits via account aggregator",
      salary: "1 to 3 months digital payslips",
      workCheck: "Work email OTP authentication",
    },
  },
  FIBE: {
    lenderKey: "FIBE",
    source: "SALARIED_MATRIX",
    productLabel: "Strictly salaried personal loan",
    minNetSalary: 25000,
    minNetSalaryMetro: null,
    minNetSalarySmallTicket: 20000,
    smallTicketMaxAmount: 600000,
    maxLoanAmount: 1000000,
    maxTenureMonths: 36,
    foreclosureNote: "0% / NIL (no lock-in)",
    employmentSegments: ["SALARIED"],
    minAge: 19,
    maxAge: 55,
    ageReviewFrom: null,
    ageNote: "19 to 55 years",
    salaryChannel: "Direct bank credit (NEFT/ACH)",
    minTotalExperienceMonths: 3,
    minCurrentExperienceMonths: null,
    vintageNote: "Total active employment ≥ 3–6 months",
    creditScoreMode: "NONE",
    minCreditScore: null,
    creditScoreNote: "No hard cutoff; proprietary SLQ engine",
    maxFoirPercent: 55,
    foirNote: "Up to 45%–55%",
    verification: {
      kyc: "Paperless e-KYC via DigiLocker + live selfie",
      banking: "Automated account aggregator",
      salary: "Recent 1–3 months salary slips",
      workCheck: "Instant corporate domain email OTP",
    },
  },
};

const num = (value) => {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

const text = (value) => {
  const s = String(value ?? "").trim();
  return s || "";
};

export function lenderKeyFromName(name) {
  const n = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!n) return null;
  if (n.includes("incred")) return "INCRED";
  if (n.includes("finnable") || n.includes("finnabale")) return "FINNABLE";
  if (n.includes("fibe") || n.includes("earlysalary")) return "FIBE";
  return null;
}

export function isPersonalLoanType(loanType) {
  const raw = String(loanType || "").trim().toUpperCase();
  return !raw || raw === "PERSONAL" || raw === "PERSONAL_LOAN";
}

export function catalogPolicyForBank(bank = {}) {
  if (!isPersonalLoanType(bank.loanType)) return null;
  const key = lenderKeyFromName(bank.bankName || bank.name);
  if (!key || !SALARIED_MATRIX[key]) return null;
  return { ...SALARIED_MATRIX[key], verification: { ...SALARIED_MATRIX[key].verification } };
}

export function normalizePolicy(raw) {
  if (raw == null || raw === "") return null;
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  if (source.disabled === true || source.disabled === "true") {
    return { disabled: true };
  }

  const segments = Array.isArray(source.employmentSegments)
    ? source.employmentSegments
    : String(source.employmentSegments || "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);

  const verificationIn = source.verification && typeof source.verification === "object" ? source.verification : {};
  const policy = {
    lenderKey: text(source.lenderKey).toUpperCase(),
    source: text(source.source) || "CUSTOM",
    productLabel: text(source.productLabel),
    minNetSalary: num(source.minNetSalary),
    minNetSalaryMetro: num(source.minNetSalaryMetro),
    minNetSalarySmallTicket: num(source.minNetSalarySmallTicket),
    smallTicketMaxAmount: num(source.smallTicketMaxAmount),
    maxLoanAmount: num(source.maxLoanAmount),
    maxTenureMonths: num(source.maxTenureMonths),
    foreclosureNote: text(source.foreclosureNote),
    employmentSegments: segments.filter((s) => s === "SALARIED" || s === "SELF_EMPLOYED"),
    minAge: num(source.minAge),
    maxAge: num(source.maxAge),
    ageReviewFrom: num(source.ageReviewFrom),
    ageNote: text(source.ageNote),
    salaryChannel: text(source.salaryChannel),
    minTotalExperienceMonths: num(source.minTotalExperienceMonths),
    minCurrentExperienceMonths: num(source.minCurrentExperienceMonths),
    vintageNote: text(source.vintageNote),
    creditScoreMode: ["HARD", "PREFERRED", "NONE"].includes(String(source.creditScoreMode || "").toUpperCase())
      ? String(source.creditScoreMode).toUpperCase()
      : "NONE",
    minCreditScore: num(source.minCreditScore),
    creditScoreNote: text(source.creditScoreNote),
    maxFoirPercent: num(source.maxFoirPercent),
    foirNote: text(source.foirNote),
    verification: {
      kyc: text(verificationIn.kyc),
      banking: text(verificationIn.banking),
      salary: text(verificationIn.salary),
      workCheck: text(verificationIn.workCheck),
    },
  };

  const hasRule =
    policy.lenderKey ||
    policy.minNetSalary ||
    policy.maxLoanAmount ||
    policy.maxTenureMonths ||
    policy.maxFoirPercent ||
    policy.minAge ||
    policy.employmentSegments.length ||
    policy.verification.kyc ||
    policy.foreclosureNote;
  return hasRule ? policy : null;
}

export function resolvePolicy(bank = {}) {
  const stored = bank.underwritingPolicy;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    if (stored.disabled === true) return null;
    const normalized = normalizePolicy(stored);
    if (normalized) return normalized;
  }
  return catalogPolicyForBank(bank);
}

export function policyForSave(raw, bankName, loanType) {
  if (raw === "" || raw == null) {
    return catalogPolicyForBank({ bankName, loanType });
  }
  const normalized = normalizePolicy(raw);
  if (normalized?.disabled) return { disabled: true };
  if (normalized) return normalized;
  return catalogPolicyForBank({ bankName, loanType });
}

export async function persistMissingCatalogPolicies(BankMasterModel, banks = []) {
  const ops = [];
  for (const bank of banks) {
    const stored = bank?.underwritingPolicy;
    const hasStored =
      stored &&
      typeof stored === "object" &&
      (stored.disabled === true || normalizePolicy(stored));
    const resolved = hasStored && stored.disabled !== true ? normalizePolicy(stored) : hasStored ? null : catalogPolicyForBank(bank);
    if (!hasStored && resolved) {
      bank.underwritingPolicy = resolved;
      if (bank._id) {
        ops.push({
          updateOne: {
            filter: {
              _id: bank._id,
              "underwritingPolicy.lenderKey": { $exists: false },
              "underwritingPolicy.maxLoanAmount": { $exists: false },
              "underwritingPolicy.disabled": { $ne: true },
            },
            update: { $set: { underwritingPolicy: resolved } },
          },
        });
      }
    } else if (hasStored && stored.disabled !== true) {
      bank.underwritingPolicy = normalizePolicy(stored);
    } else if (stored?.disabled === true) {
      bank.underwritingPolicy = null;
    }
  }
  if (ops.length && BankMasterModel?.bulkWrite) {
    await BankMasterModel.bulkWrite(ops, { ordered: false });
  }
  return banks;
}

const parseMoney = (value) => {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const parseScore = (value) => {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 300 || n > 900) return null;
  return Math.round(n);
};

/** Experience fields are captured in years (0.5 = 6 months). */
export function yearsFieldToMonths(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  const year = s.match(/(\d+(?:\.\d+)?)\s*(?:years|year|yrs|yr)\b/);
  const month = s.match(/(\d+(?:\.\d+)?)\s*(?:months|month|mos)\b/);
  if (year || month) {
    return Math.round((year ? parseFloat(year[1]) * 12 : 0) + (month ? parseFloat(month[1]) : 0));
  }
  const n = parseFloat(s.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 12);
}

export function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  if (age < 0 || age > 100) return null;
  return age;
}

export function employmentSegment(app = {}) {
  const lt = String(app.loanType || "").toUpperCase();
  if (lt.includes("SELF") || lt === "BUSINESS") return "SELF_EMPLOYED";
  if (lt === "PERSONAL" || lt.includes("SALARIED")) return "SALARIED";
  if (app.employmentInfo?.salaryInHand || app.employmentInfo?.companyName) return "SALARIED";
  if (app.businessInfo?.businessName) return "SELF_EMPLOYED";
  return null;
}

export function buildApplicantProfile(app) {
  if (!app) return null;
  const emp = app.employmentInfo || {};
  const customer = app.customer || {};
  return {
    loanType: app.loanType || "",
    segment: employmentSegment(app),
    netSalary: parseMoney(emp.salaryInHand) || parseMoney(emp.monthlySalary),
    loanAmount: parseMoney(customer.loanAmount),
    age: ageFromDob(customer.dateOfBirth),
    totalExperienceMonths: yearsFieldToMonths(emp.totalExperience),
    currentExperienceMonths: yearsFieldToMonths(emp.currentExperience),
    monthlyEmi: parseMoney(customer.monthlyEmiPaying ?? app.monthlyEmiPaying) || 0,
    creditScore: parseScore(customer.creditScore || customer.cibilScore || customer.cibil || app.creditScore),
  };
}

const inr = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;

const monthsLabel = (months) => {
  if (months == null) return "";
  if (months > 0 && months % 12 === 0) {
    const years = months / 12;
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  return `${months} month${months === 1 ? "" : "s"}`;
};

function salaryFloor(policy, loanAmount) {
  if (
    policy.minNetSalarySmallTicket &&
    policy.smallTicketMaxAmount &&
    loanAmount != null &&
    loanAmount <= policy.smallTicketMaxAmount
  ) {
    return policy.minNetSalarySmallTicket;
  }
  return policy.minNetSalary || 0;
}

export function matchApplicantToPolicy(policy, profile) {
  if (!policy) {
    return {
      status: "unconfigured",
      label: "Policy not set",
      checks: [],
    };
  }
  if (!profile) {
    return { status: "pass", label: "Policy on file", checks: [] };
  }

  const checks = [];
  const add = (key, status, label) => checks.push({ key, status, label });

  if (profile.segment && policy.employmentSegments?.length) {
    if (policy.employmentSegments.includes(profile.segment)) {
      add(
        "employment",
        "pass",
        profile.segment === "SALARIED" ? "Salaried profile allowed" : "Self-employed profile allowed"
      );
    } else {
      add(
        "employment",
        "fail",
        policy.employmentSegments.length === 1 && policy.employmentSegments[0] === "SALARIED"
          ? "Strictly salaried — self-employed is outside policy"
          : "Employment segment is outside policy"
      );
    }
  }

  const floor = salaryFloor(policy, profile.loanAmount);
  if (policy.minNetSalary || policy.minNetSalaryMetro || policy.minNetSalarySmallTicket) {
    if (profile.netSalary == null) {
      add("salary", "review", "Net salary is not on the file");
    } else if (policy.minNetSalaryMetro && profile.netSalary >= policy.minNetSalaryMetro) {
      add("salary", "pass", `In-hand ${inr(profile.netSalary)} meets metro minimum ${inr(policy.minNetSalaryMetro)}`);
    } else if (policy.minNetSalaryMetro && profile.netSalary >= (policy.minNetSalary || 0)) {
      add(
        "salary",
        "review",
        `${inr(profile.netSalary)} passes Tier-2/3 (${inr(policy.minNetSalary)}). Metro needs ${inr(policy.minNetSalaryMetro)}`
      );
    } else if (profile.netSalary >= floor && floor > 0) {
      add("salary", "pass", `In-hand ${inr(profile.netSalary)} meets ${inr(floor)}`);
    } else if (
      policy.minNetSalarySmallTicket &&
      profile.netSalary >= policy.minNetSalarySmallTicket &&
      profile.loanAmount == null
    ) {
      add(
        "salary",
        "review",
        `${inr(profile.netSalary)} is allowed only if the loan is under ${inr(policy.smallTicketMaxAmount)}`
      );
    } else {
      add("salary", "fail", `In-hand ${inr(profile.netSalary)} is below ${inr(floor || policy.minNetSalary)}`);
    }
  }

  if (policy.maxLoanAmount) {
    if (profile.loanAmount == null) {
      add("amount", "review", "Loan amount is not on the file");
    } else if (profile.loanAmount <= policy.maxLoanAmount) {
      add("amount", "pass", `${inr(profile.loanAmount)} is within the ${inr(policy.maxLoanAmount)} limit`);
    } else {
      add("amount", "fail", `${inr(profile.loanAmount)} is above the ${inr(policy.maxLoanAmount)} limit`);
    }
  }

  if (policy.minAge || policy.maxAge) {
    if (profile.age == null) {
      add("age", "review", "Age is not on the file");
    } else if ((policy.minAge && profile.age < policy.minAge) || (policy.maxAge && profile.age > policy.maxAge)) {
      add("age", "fail", `Age ${profile.age} is outside ${policy.minAge}–${policy.maxAge}`);
    } else if (policy.ageReviewFrom && profile.age >= policy.ageReviewFrom) {
      add("age", "review", `Age ${profile.age} is in the ${policy.ageReviewFrom}–${policy.maxAge} confirm band`);
    } else {
      add("age", "pass", `Age ${profile.age} is inside ${policy.minAge}–${policy.maxAge}`);
    }
  }

  if (policy.minTotalExperienceMonths) {
    if (profile.totalExperienceMonths == null) {
      add("vintageTotal", "review", "Total experience is not on the file");
    } else if (profile.totalExperienceMonths >= policy.minTotalExperienceMonths) {
      add("vintageTotal", "pass", `Total experience ${monthsLabel(profile.totalExperienceMonths)} meets the minimum`);
    } else {
      add(
        "vintageTotal",
        "fail",
        `Total experience ${monthsLabel(profile.totalExperienceMonths)} is below ${monthsLabel(policy.minTotalExperienceMonths)}`
      );
    }
  }

  if (policy.minCurrentExperienceMonths) {
    if (profile.currentExperienceMonths == null) {
      add("vintageCurrent", "review", "Current company experience is not on the file");
    } else if (profile.currentExperienceMonths >= policy.minCurrentExperienceMonths) {
      add("vintageCurrent", "pass", `Current company ${monthsLabel(profile.currentExperienceMonths)} meets the minimum`);
    } else {
      add(
        "vintageCurrent",
        "fail",
        `Current company ${monthsLabel(profile.currentExperienceMonths)} is below ${monthsLabel(policy.minCurrentExperienceMonths)}`
      );
    }
  }

  if (policy.creditScoreMode === "NONE") {
    add("credit", "pass", policy.creditScoreNote || "No hard credit-score cutoff");
  } else if (policy.minCreditScore && profile.creditScore != null) {
    if (profile.creditScore >= policy.minCreditScore) {
      add("credit", "pass", `Credit score ${profile.creditScore} meets ${policy.minCreditScore}`);
    } else if (policy.creditScoreMode === "PREFERRED") {
      add("credit", "review", `Credit score ${profile.creditScore} is below the preferred ${policy.minCreditScore}`);
    } else {
      add("credit", "fail", `Credit score ${profile.creditScore} is below ${policy.minCreditScore}`);
    }
  }

  if (policy.maxFoirPercent && profile.netSalary) {
    const foir = ((profile.monthlyEmi || 0) / profile.netSalary) * 100;
    const rounded = Math.round(foir);
    if (foir <= policy.maxFoirPercent) {
      add("foir", "pass", `FOIR ${rounded}% is within ${policy.maxFoirPercent}%`);
    } else {
      add("foir", "fail", `FOIR ${rounded}% is above ${policy.maxFoirPercent}%`);
    }
  }

  const status = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "review")
      ? "review"
      : "pass";
  const label =
    status === "pass" ? "Policy match" : status === "review" ? "Needs a check" : "Outside policy";
  return { status, label, checks };
}

export function describeScannedProfile(profile) {
  if (!profile) return null;
  const foir = profile.netSalary
    ? Math.round(((profile.monthlyEmi || 0) / profile.netSalary) * 100)
    : null;
  return {
    segment:
      profile.segment === "SELF_EMPLOYED"
        ? "Self-employed"
        : profile.segment === "SALARIED"
          ? "Salaried"
          : null,
    netSalary: profile.netSalary,
    loanAmount: profile.loanAmount,
    age: profile.age,
    totalExperienceMonths: profile.totalExperienceMonths,
    currentExperienceMonths: profile.currentExperienceMonths,
    monthlyEmi: profile.monthlyEmi || 0,
    foirPercent: foir,
    creditScore: profile.creditScore,
  };
}

export function annotateBanksWithPolicy(banks, application) {
  const profile = buildApplicantProfile(application);
  const visible = banks.map((bank) => {
    const policy = resolvePolicy(bank);
    const policyMatch = application ? matchApplicantToPolicy(policy, profile) : null;
    return {
      ...bank,
      underwritingPolicy: policy,
      ...(policyMatch ? { policyMatch } : {}),
    };
  });
  if (application) {
    const rank = { pass: 0, review: 1, fail: 2, unconfigured: 3 };
    visible.sort((a, b) => {
      const d = (rank[a.policyMatch?.status] ?? 4) - (rank[b.policyMatch?.status] ?? 4);
      if (d) return d;
      return String(a.bankName || "").localeCompare(String(b.bankName || ""));
    });
  }
  return {
    banks: visible,
    policyFilter: application
      ? {
          shown: visible.length,
          matched: visible.filter((b) => b.policyMatch?.status === "pass").length,
          review: visible.filter((b) => b.policyMatch?.status === "review").length,
          outside: visible.filter((b) => b.policyMatch?.status === "fail").length,
          hidden: 0,
          scanned: describeScannedProfile(profile),
        }
      : null,
  };
}
