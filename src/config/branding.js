/**
 * Central company branding for emails, PDFs, and API copy.
 * Use COMPANY_NAME in most copy; COMPANY_NAME_LEGAL in email template footer / copyright only.
 */
export const COMPANY_NAME = "DhanSource Capital";

export const COMPANY_NAME_LEGAL = "DhanSource Capital Pvt Ltd";

/** @deprecated use COMPANY_NAME */
export const COMPANY_SHORT = "DhanSource Capital";

const DEFAULT_WEB = "https://dhansourcecapital.com";

/** If env still points at legacy Trustline hosts, force DhanSource marketing site. */
function coerceDhanSourceOrigin(url) {
  const trimmed = String(url || "").trim().replace(/\/$/, "");
  if (!trimmed) return DEFAULT_WEB;
  try {
    const host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
    if (host.includes("trustline")) return DEFAULT_WEB;
  } catch {
    return DEFAULT_WEB;
  }
  return trimmed;
}

/** Base site URL for links in emails (no trailing slash) */
export const getClientBaseUrl = () =>
  coerceDhanSourceOrigin(process.env.CLIENT_URL || DEFAULT_WEB);

/**
 * Public web URL for partner share links (PartnerRegistrationForm?ref=, etc.).
 * Set REFERRAL_WEB_URL when CLIENT_URL still points at an old domain but referral must use DhanSource.
 */
export const getReferralWebBaseUrl = () =>
  coerceDhanSourceOrigin(
    process.env.REFERRAL_WEB_URL || process.env.CLIENT_URL || DEFAULT_WEB
  );

/**
 * Base URL where the API serves /invite (app download + referral code). Often same as API public origin.
 * Falls back to referral web URL if not set.
 */
export const getInviteBaseUrl = () =>
  coerceDhanSourceOrigin(
    process.env.INVITE_BASE_URL || process.env.API_PUBLIC_URL || getReferralWebBaseUrl()
  );

export const SUPPORT_EMAIL =
  process.env.SUPPORT_EMAIL || "support@dhansourcecapital.com";

/** Google Play listing for partner Android app (share / invite). Replace when the app is live. */
export const getPartnerAppPlayStoreUrl = () =>
  String(
    process.env.PARTNER_APP_PLAY_STORE_URL ||
      "https://play.google.com/store/apps/details?id=com.dhansourcecapital.partner&hl=en_IN"
  ).trim();

/**
 * Append UTM params for analytics (Google Analytics, etc.) when partners share links.
 * Skips if `utm_source` is already present.
 * @param {"web" | "invite"} kind
 */
export function appendPartnerShareUtm(url, kind = "web") {
  if (!url || typeof url !== "string") return url;
  if (/[?&]utm_source=/i.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  const medium = kind === "invite" ? "app_invite_landing" : "web_partner_registration";
  return `${url}${sep}utm_source=partner_share&utm_medium=${encodeURIComponent(medium)}&utm_campaign=partner_signup`;
}

/** `?ref=` / `/invite?code=` — prefer `PT-…` when either DB field has it (align with web + app). */
export function canonicalPartnerReferralCode(partnerCode, referralCode) {
  const a = String(partnerCode || "").trim();
  const b = String(referralCode || "").trim();
  if (/^PT-/i.test(a)) return a;
  if (/^PT-/i.test(b)) return b;
  if (a) return a;
  if (b) return b;
  return "";
}
