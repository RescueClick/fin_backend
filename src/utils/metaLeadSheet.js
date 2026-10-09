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
    if (record[name]) return record[name];
  }
  const key = Object.keys(record).find((item) =>
    names.some((name) => item.includes(name))
  );
  return key ? record[key] : "";
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

  const headers = table[0].map(headerKey);
  const leads = [];
  for (const cells of table.slice(1)) {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = cells[index] || "";
    });
    const rawPhone = pick(record, ["phone_number", "phone", "mobile", "contact", "contact_number"]);
    const phone = normalizePhoneToTen(String(rawPhone).replace(/^p:/i, ""));
    const name = pick(record, ["full_name", "name", "customer_name"]) || "—";
    if (!phone || phone.length < 10) continue;
    leads.push({
      name,
      phone,
      email: pick(record, ["email", "email_address"]),
      city: pick(record, ["city"]),
      metaLoanType: pick(record, ["required_loan_type", "loan_type"]),
      metaLoanAmount: pick(record, ["required_loan_amount", "loan_amount"]),
      createdTime: pick(record, ["created_time", "created"]),
    });
  }

  if (!leads.length) {
    const error = new Error("No phone numbers were found. Use a Meta leads export with a phone column.");
    error.status = 400;
    throw error;
  }
  return leads;
}

export function matchMetaLeadsToApplications(leads, applications) {
  const byPhone = new Map();
  for (const app of applications) {
    const customer = app.customer || {};
    const phones = [customer.phone, customer.alternatePhone];
    for (const raw of phones) {
      const phone = normalizePhoneToTen(raw);
      if (phone.length !== 10 || byPhone.has(phone)) continue;
      byPhone.set(phone, {
        appNo: app.appNo || "",
        applicationStatus: app.status || "",
        loanType: app.loanType || "",
        applicationId: String(app._id || ""),
      });
    }
  }

  const rows = leads.map((lead) => {
    const match = byPhone.get(lead.phone) || null;
    return {
      ...lead,
      filled: Boolean(match),
      appNo: match?.appNo || "",
      applicationStatus: match?.applicationStatus || "",
      loanType: match?.loanType || "",
      applicationId: match?.applicationId || "",
    };
  });

  rows.sort((a, b) => {
    if (a.filled !== b.filled) return a.filled ? 1 : -1;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });

  return {
    total: rows.length,
    filledCount: rows.filter((row) => row.filled).length,
    notFilledCount: rows.filter((row) => !row.filled).length,
    rows,
  };
}
