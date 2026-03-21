/**
 * Central company branding for emails, PDFs, and API copy.
 * Use COMPANY_NAME in most copy; COMPANY_NAME_LEGAL in email template footer / copyright only.
 */
export const COMPANY_NAME = "DhanSource Capital";

export const COMPANY_NAME_LEGAL = "DhanSource Capital Pvt Ltd";

/** @deprecated use COMPANY_NAME */
export const COMPANY_SHORT = "DhanSource Capital";

/** Base site URL for links in emails (no trailing slash) */
export const getClientBaseUrl = () =>
  String(process.env.CLIENT_URL || "https://trustlinefintech.com").replace(/\/$/, "");

export const SUPPORT_EMAIL =
  process.env.SUPPORT_EMAIL || "support@dhansourcecapital.com";
