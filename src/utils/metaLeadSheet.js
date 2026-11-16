import { normalizePhoneToTen } from "./phoneNormalize.js";

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function headerKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function pick(record, names) {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== "") return record[name];
  }
  const key = Object.keys(record).find((item) =>
    names.some((name) => item.includes(name))
  );
  return key && record[key] !== undefined ? record[key] : "";
}

/** Meta often exports .csv as UTF-16. A UTF-8 read leaves a NUL between letters. */
export function normalizeSheetText(raw) {
  let text = String(raw ?? "");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000")) {
    text = text.replace(/\u0000/g, "").replace(/\uFFFD/g, "");
  }
  return text.replace(/^\uFEFF/, "").trim();
}

export function parseMetaLeadSheet(rawText) {
  const text = normalizeSheetText(rawText);
  if (!text) {
    const error = new Error("The sheet is empty.");
    error.status = 400;
    throw error;
  }

  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const delimiter = tabs > commas ? "\t" : ",";
  const table = parseDelimited(text, delimiter);
  if (table.length < 2) {
    const error = new Error("The sheet needs a header row and at least one lead.");
    error.status = 400;
    throw error;
  }

  const rawHeaders = table[0];
  const headers = rawHeaders.map(headerKey);
  const leads = [];

  for (const cells of table.slice(1)) {
    const record = {};
    const rawMeta = {};
    headers.forEach((header, index) => {
      const cellVal = cells[index] || "";
      if (header) record[header] = cellVal;
      const rawHeaderName = rawHeaders[index] || `col_${index}`;
      rawMeta[rawHeaderName] = cellVal;
    });

    const rawPhone = pick(record, [
      "phone_number",
      "phone",
      "mobile",
      "contact",
      "contact_number",
      "phone_no",
      "mobile_no",
      "customer_phone",
      "partner_phone",
    ]);

    const phone = normalizePhoneToTen(String(rawPhone).replace(/^p:/i, ""));
    const name = pick(record, ["full_name", "name", "customer_name", "first_name", "client_name"]) || "—";
    if (!phone || phone.length < 10) continue;

    leads.push({
      name,
      phone,
      email: pick(record, ["email", "email_address", "mail"]),
      city: pick(record, ["city", "city_town", "location", "district"]),
      metaLoanType: pick(record, ["required_loan_type", "loan_type", "type_of_loan"]),
      metaLoanAmount: pick(record, ["required_loan_amount", "loan_amount", "amount"]),
      createdTime: pick(record, ["created_time", "created_at", "created", "date"]),
      rawMeta,
    });
  }

  if (!leads.length) {
    const error = new Error("No valid phone numbers found. Please upload a CSV containing a phone number column.");
    error.status = 400;
    throw error;
  }
  return leads;
}

export function matchMetaLeadsToSystem(leads, applications = [], users = []) {
  // Build lookup maps for fast matching
  const partnerByPhone = new Map();
  const customerByPhone = new Map();

  for (const u of users) {
    const role = (u.role || "").toLowerCase();
    const phones = [u.phone, u.alternatePhone].filter(Boolean);
    for (const raw of phones) {
      const phone = normalizePhoneToTen(raw);
      if (phone.length !== 10) continue;

      const userName = `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.name || "—";
      const rmName = u.rmId
        ? `${u.rmId.firstName || ""} ${u.rmId.lastName || ""}`.trim() || u.rmId.name || ""
        : "";

      if (role === "partner") {
        if (!partnerByPhone.has(phone)) {
          partnerByPhone.set(phone, {
            partnerId: u._id,
            employeeId: u.employeeId || "",
            partnerName: userName,
            rmName,
            rmId: u.rmId?._id || u.rmId || null,
          });
        }
      } else if (role === "customer") {
        if (!customerByPhone.has(phone)) {
          customerByPhone.set(phone, {
            customerId: u._id,
            customerName: userName,
          });
        }
      }
    }
  }

  const appByPhone = new Map();
  for (const app of applications) {
    const customer = app.customer || {};
    const phones = [customer.phone, customer.alternatePhone, app.phone].filter(Boolean);
    for (const raw of phones) {
      const phone = normalizePhoneToTen(raw);
      if (phone.length !== 10 || appByPhone.has(phone)) continue;
      appByPhone.set(phone, {
        appNo: app.appNo || "",
        applicationStatus: app.status || "",
        loanType: app.loanType || "",
        amount: Number(app.loanAmount || app.amount || 0),
        applicationId: String(app._id || ""),
      });
    }
  }

  let existingPartnersCount = 0;
  let loanFilledCount = 0;
  let customerNoLoanCount = 0;
  let freshLeadsCount = 0;

  const rows = leads.map((lead) => {
    const partnerMatch = partnerByPhone.get(lead.phone) || null;
    const appMatch = appByPhone.get(lead.phone) || null;
    const customerMatch = customerByPhone.get(lead.phone) || null;

    let systemStatus = "FRESH_LEAD";

    if (partnerMatch) {
      systemStatus = "EXISTING_PARTNER";
      existingPartnersCount += 1;
    } else if (appMatch) {
      systemStatus = "CUSTOMER_LOAN_FILLED";
      loanFilledCount += 1;
    } else if (customerMatch) {
      systemStatus = "CUSTOMER_NO_LOAN";
      customerNoLoanCount += 1;
    } else {
      systemStatus = "FRESH_LEAD";
      freshLeadsCount += 1;
    }

    const filled = Boolean(appMatch);

    return {
      name: lead.name,
      phone: lead.phone,
      email: lead.email || "",
      city: lead.city || "",
      metaLoanType: lead.metaLoanType || "",
      metaLoanAmount: lead.metaLoanAmount || "",
      createdTime: lead.createdTime || "",
      systemStatus,
      filled,
      partnerInfo: partnerMatch || {
        partnerId: null,
        employeeId: "",
        partnerName: "",
        rmName: "",
        rmId: null,
      },
      loanInfo: appMatch || {
        appNo: "",
        applicationId: null,
        loanType: "",
        status: "",
        amount: 0,
      },
      customerInfo: customerMatch || {
        customerId: null,
        customerName: "",
      },
      appNo: appMatch?.appNo || "",
      applicationStatus: appMatch?.applicationStatus || "",
      loanType: appMatch?.loanType || "",
      applicationId: appMatch?.applicationId || "",
      rawMeta: lead.rawMeta || {},
    };
  });

  // Sort rows: Fresh leads first, then Customer No Loan, then Existing Partner, then Loan Filled
  const statusPriority = {
    FRESH_LEAD: 1,
    CUSTOMER_NO_LOAN: 2,
    EXISTING_PARTNER: 3,
    CUSTOMER_LOAN_FILLED: 4,
  };

  rows.sort((a, b) => {
    const pA = statusPriority[a.systemStatus] || 99;
    const pB = statusPriority[b.systemStatus] || 99;
    if (pA !== pB) return pA - pB;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });

  return {
    total: rows.length,
    existingPartners: existingPartnersCount,
    existingCustomersLoanFilled: loanFilledCount,
    existingCustomersNoLoan: customerNoLoanCount,
    freshLeads: freshLeadsCount,
    filledCount: loanFilledCount,
    notFilledCount: rows.length - loanFilledCount,
    rows,
  };
}

// Backwards-compatible export
export function matchMetaLeadsToApplications(leads, applications) {
  return matchMetaLeadsToSystem(leads, applications, []);
}
