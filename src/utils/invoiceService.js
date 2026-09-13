// utils/invoiceService.js
import { COMPANY_NAME, COMPANY_NAME_LEGAL, SUPPORT_EMAIL } from "../config/branding.js";
import { Config } from "../models/Config.js";

export const DEFAULT_TDS_SECTION = "194T";
export const DEFAULT_TDS_PERCENTAGE = 10; // Section 194T default rate is 10%

export const DEFAULT_COMPANY_DETAILS = {
  companyName: COMPANY_NAME_LEGAL || "DhanSource Capital Pvt Ltd",
  brandName: COMPANY_NAME || "DhanSource Capital",
  address: "Office No -31, C Wing, Ashoka Nagar, Kharadi, Pune, Maharashtra 411014",
  cin: "U65999MH2023PTC123456",
  gstin: "27AAACD1234F1Z5",
  pan: "AAACD1234F",
  tan: "MUMA12345E",
  email: SUPPORT_EMAIL || "accounts@dhansourcecapital.com",
  phone: "+91 98765 43210",
  website: "https://dhansourcecapital.com",
};

/**
 * Fetch invoice and TDS settings from Config or return sensible defaults
 */
export async function getInvoiceAndTdsPolicy() {
  try {
    const config = await Config.findOne({
      key: { $in: ["INVOICE_AND_TDS_SETTINGS", "DEFAULT_PAYOUT_POLICY"] },
    }).lean();

    const val = config?.value || {};
    return {
      tdsApplicable: val.tdsApplicable !== undefined ? Boolean(val.tdsApplicable) : true,
      tdsSection: val.tdsSection || DEFAULT_TDS_SECTION,
      tdsPercentage: val.tdsPercentage != null ? Number(val.tdsPercentage) : DEFAULT_TDS_PERCENTAGE,
      tdsDescription: val.tdsDescription || "Section 194T - TDS on Payment to Partner (10%)",
      invoicePrefix: val.invoicePrefix || "INV-PO",
      companyDetails: {
        ...DEFAULT_COMPANY_DETAILS,
        ...(val.companyDetails || {}),
        companyName: val.companyName || DEFAULT_COMPANY_DETAILS.companyName,
        address: val.companyAddress || DEFAULT_COMPANY_DETAILS.address,
        gstin: val.companyGstin || DEFAULT_COMPANY_DETAILS.gstin,
        pan: val.companyPan || DEFAULT_COMPANY_DETAILS.pan,
        tan: val.companyTan || DEFAULT_COMPANY_DETAILS.tan,
      },
      invoiceNotes:
        val.invoiceNotes ||
        "Tax has been deducted at source under Section 194T of the Income Tax Act, 1961. TDS certificate (Form 16A) will be issued quarterly on TRACES portal.",
    };
  } catch (err) {
    console.error("Error reading invoice/TDS policy:", err);
    return {
      tdsApplicable: true,
      tdsSection: DEFAULT_TDS_SECTION,
      tdsPercentage: DEFAULT_TDS_PERCENTAGE,
      tdsDescription: "Section 194T - TDS on Payment to Partner (10%)",
      invoicePrefix: "INV-PO",
      companyDetails: DEFAULT_COMPANY_DETAILS,
      invoiceNotes:
        "Tax has been deducted at source under Section 194T of the Income Tax Act, 1961. TDS certificate (Form 16A) will be issued quarterly on TRACES portal.",
    };
  }
}

/**
 * Calculate Gross, TDS and Net Payout amount
 */
export function calculateTdsAndNet({
  approvedAmount = 0,
  payoutPercentage = null,
  grossAmount = null,
  directAmount = null,
  tdsApplicable = true,
  tdsSection = DEFAULT_TDS_SECTION,
  tdsPercentage = DEFAULT_TDS_PERCENTAGE,
}) {
  const approved = Number(approvedAmount || 0);

  // Determine gross amount
  let gross = 0;
  if (grossAmount != null && !isNaN(Number(grossAmount))) {
    gross = Number(grossAmount);
  } else if (directAmount != null && !isNaN(Number(directAmount))) {
    gross = Number(directAmount);
  } else if (payoutPercentage != null && !isNaN(Number(payoutPercentage)) && approved > 0) {
    gross = Number(((approved * Number(payoutPercentage)) / 100).toFixed(2));
  }

  // Calculate percentage if not passed
  let computedPct = payoutPercentage != null ? Number(payoutPercentage) : 0;
  if (!computedPct && approved > 0 && gross > 0) {
    computedPct = Number(((gross / approved) * 100).toFixed(2));
  }

  const isTds = Boolean(tdsApplicable);
  const rate = isTds ? Number(tdsPercentage || DEFAULT_TDS_PERCENTAGE) : 0;
  const tdsAmt = isTds && gross > 0 ? Number(((gross * rate) / 100).toFixed(2)) : 0;
  const netAmt = Number(Math.max(0, gross - tdsAmt).toFixed(2));

  return {
    grossAmount: Number(gross.toFixed(2)),
    payoutPercentage: computedPct,
    tdsApplicable: isTds,
    tdsSection: isTds ? tdsSection || DEFAULT_TDS_SECTION : "NONE",
    tdsPercentage: rate,
    tdsAmount: tdsAmt,
    netAmount: netAmt,
  };
}

/**
 * Generate standardized tax invoice number
 * Format: INV-PO-YYYY-APPNUMBER-XXXX
 */
export function generateInvoiceNumber(appNo = "APP", uniqueSuffix = "", prefix = "INV-PO") {
  const year = new Date().getFullYear();
  const cleanApp = String(appNo || "APP").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const rand = uniqueSuffix
    ? String(uniqueSuffix).slice(-4).toUpperCase()
    : Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${year}-${cleanApp}-${rand}`;
}

/** Incentive / milestone bonus invoice numbers */
export function generateIncentiveInvoiceNumber(partnerCode = "PARTNER", uniqueSuffix = "") {
  return generateInvoiceNumber(partnerCode, uniqueSuffix, "INV-IN");
}

/**
 * Format currency to INR string
 */
export const formatINR = (val) =>
  `₹${Number(val || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;

/**
 * Generate full HTML for Tax Invoice & Settlement Statement
 */
export function buildPartnerInvoiceHtml({
  invoiceNumber,
  invoiceDate,
  partner,
  customerName = "Customer",
  appNo = "APP",
  loanType = "Personal Loan",
  approvedAmount = 0,
  grossAmount = 0,
  payoutPercentage = 0,
  tdsApplicable = true,
  tdsSection = DEFAULT_TDS_SECTION,
  tdsPercentage = DEFAULT_TDS_PERCENTAGE,
  tdsAmount = 0,
  netAmount = 0,
  utrNumber = "",
  note = "",
  bankName = "",
  accountNumber = "",
  ifscCode = "",
  companyDetails = {},
  invoiceNotes = "",
  invoiceType = "PAYOUT", // PAYOUT | INCENTIVE
  periodLabel = "",
  tierLabel = "",
}) {
  const isIncentive = String(invoiceType).toUpperCase() === "INCENTIVE";
  const company = { ...DEFAULT_COMPANY_DETAILS, ...(companyDetails || {}) };
  const adviceLabel = isIncentive
    ? "Tax Invoice / Incentive Advice"
    : "Tax Invoice / Payout Advice";
  const refCol1 = isIncentive ? "Period / Ref #" : "Application #";
  const refCol2 = isIncentive ? "Milestone / Tier" : "Borrower Name";
  const refCol3 = isIncentive ? "Incentive Type" : "Loan Product";
  const refCol4 = isIncentive ? "Disbursed Volume" : "Disbursed Amount";
  const refCol5 = isIncentive ? "Bonus Basis" : "Commission Rate";
  const grossLabel = isIncentive
    ? "1. Gross Incentive Bonus (Before Tax)"
    : "1. Gross Commission Amount (Before Tax)";
  const netLabel = isIncentive
    ? "NET INCENTIVE TRANSFERRED TO BANK"
    : "NET COMMISSION TRANSFERRED TO BANK";
  const breakdownTitle = isIncentive
    ? "INCENTIVE BONUS & TAX DEDUCTION BREAKDOWN"
    : "COMMISSION & TAX DEDUCTION BREAKDOWN";
  const rateDisplay = isIncentive
    ? tierLabel || payoutPercentage || "Flat Bonus"
    : payoutPercentage
    ? `${payoutPercentage}%`
    : "Flat";
  const nameDisplay = isIncentive
    ? tierLabel || customerName || "Milestone Bonus"
    : customerName;
  const productDisplay = isIncentive
    ? periodLabel || loanType || "Monthly Milestone"
    : loanType;
  const dateFormatted = invoiceDate
    ? new Date(invoiceDate).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : new Date().toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

  const partnerFullName =
    `${partner?.firstName || ""} ${partner?.lastName || ""}`.trim() ||
    partner?.name ||
    "Channel Partner";
  const partnerCode =
    partner?.employeeId || partner?.partnerCode || partner?.partnerId || "—";
  const partnerPan = partner?.panNumber || partner?.panCard || "NOT PROVIDED";
  const partnerPhone = partner?.phone || "—";
  const partnerEmail = partner?.email || "—";
  const maskedAcc = accountNumber
    ? `XXXX-XXXX-${String(accountNumber).slice(-4)}`
    : "Registered Bank Account";

  const secBadge = tdsApplicable
    ? `TDS U/S ${tdsSection || "194T"} (${tdsPercentage}%) APPLIED`
    : "TDS EXEMPTED / NOT APPLIED";

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.5; max-width: 680px; margin: 0 auto; background: #ffffff;">
      
      <!-- INVOICE HEADER BAR -->
      <div style="border-bottom: 2px solid #0d9488; padding-bottom: 16px; margin-bottom: 20px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="vertical-align: top;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 800; color: #0f172a; letter-spacing: -0.5px;">${company.brandName}</h1>
              <p style="margin: 2px 0 0; font-size: 11px; color: #64748b;">${company.companyName}</p>
              <p style="margin: 2px 0 0; font-size: 11px; color: #64748b;">${company.address}</p>
              <div style="margin-top: 6px; font-size: 10px; color: #475569;">
                <span><strong>PAN:</strong> ${company.pan}</span> &nbsp;|&nbsp; 
                <span><strong>TAN:</strong> ${company.tan}</span> &nbsp;|&nbsp; 
                <span><strong>GSTIN:</strong> ${company.gstin}</span>
              </div>
            </td>
            <td style="vertical-align: top; text-align: right;">
              <span style="display: inline-block; background: #0f766e; color: #ffffff; font-size: 10px; font-weight: 700; padding: 4px 10px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;">
                ${adviceLabel}
              </span>
              <div style="margin-top: 8px;">
                <span style="font-size: 10px; text-transform: uppercase; color: #64748b; display: block;">Invoice Number</span>
                <strong style="font-size: 13px; font-family: monospace; color: #0f172a;">${invoiceNumber}</strong>
              </div>
              <div style="margin-top: 4px;">
                <span style="font-size: 10px; text-transform: uppercase; color: #64748b; display: block;">Invoice Date</span>
                <strong style="font-size: 12px; color: #0f172a;">${dateFormatted}</strong>
              </div>
            </td>
          </tr>
        </table>
      </div>

      <!-- SECTION 194T TDS NOTICE STRIP -->
      <div style="background: #f0fdfa; border: 1px solid #99f6e4; border-left: 4px solid #0d9488; padding: 10px 14px; border-radius: 6px; margin-bottom: 20px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="font-size: 12px; color: #0f766e; font-weight: 700;">
              ⚖️ Section 194T Income Tax Compliance
            </td>
            <td style="text-align: right;">
              <span style="background: #14b8a6; color: #ffffff; font-size: 9px; font-weight: 800; padding: 2px 8px; border-radius: 12px; letter-spacing: 0.5px;">
                ${secBadge}
              </span>
            </td>
          </tr>
          <tr>
            <td colspan="2" style="font-size: 11px; color: #115e59; padding-top: 4px;">
              TDS on remuneration/commission payable to partners under Section 194T of the Income Tax Act, 1961. Tax credit will reflect against Partner PAN in Form 26AS / AIS.
            </td>
          </tr>
        </table>
      </div>

      <!-- BILLED TO / PARTNER DETAILS -->
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px;">
        <tr>
          <td style="width: 50%; vertical-align: top; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
            <strong style="display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 6px;">
              Payee / Channel Partner Details
            </strong>
            <div style="font-size: 13px; font-weight: 700; color: #0f172a;">${partnerFullName}</div>
            <div style="color: #475569; margin-top: 3px;"><strong>Partner Code / ID:</strong> ${partnerCode}</div>
            <div style="color: #475569; margin-top: 2px;">
              <strong>PAN Number:</strong> <span style="font-family: monospace; font-weight: 700; color: #0369a1; background: #e0f2fe; padding: 1px 5px; border-radius: 3px;">${partnerPan}</span>
            </div>
            <div style="color: #475569; margin-top: 2px;"><strong>Email:</strong> ${partnerEmail}</div>
            <div style="color: #475569; margin-top: 2px;"><strong>Mobile:</strong> ${partnerPhone}</div>
          </td>
          <td style="width: 4%;"></td>
          <td style="width: 46%; vertical-align: top; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
            <strong style="display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 6px;">
              Bank Settlement Account
            </strong>
            <div style="color: #475569;"><strong>Bank:</strong> ${bankName || "Partner Bank"}</div>
            <div style="color: #475569; margin-top: 2px;"><strong>Account No:</strong> <span style="font-family: monospace;">${maskedAcc}</span></div>
            ${ifscCode ? `<div style="color: #475569; margin-top: 2px;"><strong>IFSC Code:</strong> <span style="font-family: monospace;">${ifscCode}</span></div>` : ""}
            ${utrNumber ? `<div style="color: #0d9488; margin-top: 4px; font-weight: 700;"><strong>Bank UTR:</strong> ${utrNumber}</div>` : ""}
            <div style="color: #16a34a; margin-top: 4px; font-size: 11px; font-weight: 700;">● Transfer Status: SETTLED / DONE</div>
          </td>
        </tr>
      </table>

      <!-- LOAN APPLICATION REFERENCE TABLE -->
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; font-size: 12px;">
        <thead style="background: #f1f5f9; color: #475569; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">
          <tr>
            <th style="padding: 8px 12px; text-align: left;">${refCol1}</th>
            <th style="padding: 8px 12px; text-align: left;">${refCol2}</th>
            <th style="padding: 8px 12px; text-align: left;">${refCol3}</th>
            <th style="padding: 8px 12px; text-align: right;">${refCol4}</th>
            <th style="padding: 8px 12px; text-align: right;">${refCol5}</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-top: 1px solid #e2e8f0; background: #ffffff;">
            <td style="padding: 10px 12px; font-family: monospace; font-weight: 700; color: #0f172a;">#${appNo}</td>
            <td style="padding: 10px 12px; font-weight: 600; color: #0f172a;">${nameDisplay}</td>
            <td style="padding: 10px 12px; color: #475569;">${productDisplay}</td>
            <td style="padding: 10px 12px; text-align: right; font-weight: 600; color: #0f172a;">${formatINR(approvedAmount)}</td>
            <td style="padding: 10px 12px; text-align: right; font-weight: 700; color: #0d9488;">${rateDisplay}</td>
          </tr>
        </tbody>
      </table>

      <!-- COMMISSION / INCENTIVE & TDS 194T CALCULATION SUMMARY TABLE -->
      <div style="border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; margin-bottom: 20px;">
        <div style="background: #0f172a; color: #ffffff; padding: 10px 14px; font-size: 12px; font-weight: 700; display: flex; justify-content: space-between;">
          <span>${breakdownTitle}</span>
          <span style="font-family: monospace; color: #5eead4;">SECTION 194T TDS</span>
        </div>
        
        <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
          <tr style="border-bottom: 1px solid #f1f5f9; background: #ffffff;">
            <td style="padding: 10px 14px; color: #475569;">${grossLabel}</td>
            <td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #0f172a; font-size: 13px;">${formatINR(grossAmount)}</td>
          </tr>
          
          <tr style="border-bottom: 1px solid #f1f5f9; background: #fef2f2;">
            <td style="padding: 10px 14px; color: #b91c1c;">
              2. Less: TDS Deducted under <strong>Section ${tdsSection || "194T"}</strong> (@ ${tdsPercentage}%)
              <span style="display: block; font-size: 10px; color: #ef4444; margin-top: 1px;">
                ${tdsApplicable ? "Deposited with Govt against Partner PAN" : "Not applicable / Exempted"}
              </span>
            </td>
            <td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #b91c1c; font-size: 13px;">
              ${tdsApplicable && tdsAmount > 0 ? `(-) ${formatINR(tdsAmount)}` : "₹0.00"}
            </td>
          </tr>

          <tr style="border-bottom: 1px solid #cbd5e1; background: #ffffff;">
            <td style="padding: 8px 14px; color: #64748b; font-size: 11px;">3. Goods & Services Tax (GST / CGST / SGST)</td>
            <td style="padding: 8px 14px; text-align: right; color: #64748b; font-size: 11px;">₹0.00</td>
          </tr>

          <tr style="background: #f0fdf4;">
            <td style="padding: 12px 14px; font-weight: 800; font-size: 14px; color: #166534;">
              ${netLabel}
              <span style="display: block; font-size: 10px; font-weight: normal; color: #15803d; margin-top: 2px;">
                Transferred via NEFT / IMPS / Bank Settlement
              </span>
            </td>
            <td style="padding: 12px 14px; text-align: right; font-weight: 900; font-size: 18px; color: #15803d;">
              ${formatINR(netAmount || grossAmount)}
            </td>
          </tr>
        </table>
      </div>

      ${
        note
          ? `
          <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 10px 14px; margin-bottom: 20px; font-size: 11px; color: #475569;">
            <strong style="color: #0f172a;">Transaction Note / Reference:</strong> ${note}
          </div>
          `
          : ""
      }

      <!-- STATUTORY TDS DECLARATION & NOTES -->
      <div style="background: #fafafa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; margin-bottom: 20px; font-size: 10px; color: #6b7280; line-height: 1.6;">
        <strong style="color: #374151; display: block; margin-bottom: 4px; text-transform: uppercase;">Statutory Tax Note & Compliance</strong>
        <div>• <strong>TDS Section 194T:</strong> As per the Finance Act, 2024, TDS under Section 194T of the Income Tax Act, 1961 is deducted on payments made to partners of a firm (salary, remuneration, commission, or bonus) at the prescribed rate of 10%.</div>
        <div>• <strong>Form 16A TDS Certificate:</strong> The deducted TDS will be deposited into the Central Government account via Challan, and TDS Certificate in Form 16A will be generated quarterly on TRACES portal.</div>
        <div>• <strong>Income Tax Credit:</strong> Tax credits can be verified by the partner in their Form 26AS / Annual Information Statement (AIS) via the Income Tax e-filing portal using their PAN: <strong>${partnerPan}</strong>.</div>
        ${invoiceNotes ? `<div style="margin-top: 4px; color: #475569;">• <strong>Terms & Remarks:</strong> ${invoiceNotes}</div>` : ""}
      </div>

      <!-- FOOTER -->
      <table style="width: 100%; border-collapse: collapse; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 12px;">
        <tr>
          <td>
            Questions? Contact Partner Desk: <strong>${company.email}</strong> | ${company.phone}
          </td>
          <td style="text-align: right; color: #94a3b8;">
            Computer generated document. No physical signature required.
          </td>
        </tr>
      </table>
    </div>
  `;
}
