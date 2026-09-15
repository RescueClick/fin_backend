/**
 * Industrial partner-lead workflow helpers.
 * LEADs stay RM-owned until DOC_COMPLETE; ASM/RSM monitor & nudge only.
 */
import mongoose from "mongoose";
import { Application } from "../models/Application.js";
import { User } from "../models/User.js";
import { createNotification } from "./notificationService.js";
import { activeApplicationsFilter } from "./activeApplicationsFilter.js";
import { getClientBaseUrl } from "../config/branding.js";

const LOAN_TYPE_FORM_PATH = {
  PERSONAL: "/partner/personal-loan",
  BUSINESS: "/partner/business-loan",
  HOME_LOAN_SALARIED: "/partner/home-loan-salaried",
  HOME_LOAN_SELF_EMPLOYED: "/partner/home-loan-self-employed",
  LAP_SALARIED: "/partner/lap-loan-salaried",
  LAP_SELF_EMPLOYED: "/partner/lap-loan-self-employed",
  LAP: "/partner/lap-loan-salaried",
};

export function partnerFormPathForLoanType(loanType) {
  const key = String(loanType || "PERSONAL").trim().toUpperCase();
  return LOAN_TYPE_FORM_PATH[key] || "/partner/get-loan";
}

/** Deep link for partner to resume / complete a Step-1 lead form */
export function buildPartnerCompleteFormUrl(app) {
  const base = getClientBaseUrl().replace(/\/$/, "");
  const path = partnerFormPathForLoanType(app?.loanType);
  const id = app?._id || app?.id;
  if (!id) return `${base}${path}`;
  return `${base}${path}?applicationId=${encodeURIComponent(String(id))}&appNo=${encodeURIComponent(String(app.appNo || ""))}`;
}

export function customerDisplayName(app) {
  return `${app?.customer?.firstName || ""} ${app?.customer?.lastName || ""}`.trim() || "Customer";
}

/**
 * Notify partner to complete the loan form for a partner-sourced LEAD.
 */
export async function notifyPartnerToCompleteLeadForm(app, { askedByRole = "RM", note = "" } = {}) {
  if (!app?.partnerId) return { notified: false, reason: "no_partner" };

  const partnerId = app.partnerId._id || app.partnerId;
  const name = customerDisplayName(app);
  const formUrl = buildPartnerCompleteFormUrl(app);
  const amount = Number(app.customer?.loanAmount || app.requestedAmount || 0);

  await createNotification(String(partnerId), {
    title: "Complete loan application",
    message:
      `${askedByRole} asked you to complete the ${app.loanType || "loan"} form` +
      ` for ${name}` +
      (amount ? ` (₹${amount.toLocaleString("en-IN")})` : "") +
      `. App: ${app.appNo || "—"}.` +
      (note ? ` Note: ${note}` : ""),
    type: "APPLICATION",
    meta: {
      reason: "COMPLETE_FORM",
      applicationId: app._id,
      appNo: app.appNo,
      loanType: app.loanType,
      formUrl,
      leadSource: app.leadSource || "PARTNER",
    },
  });

  return { notified: true, formUrl };
}

/**
 * Notify RM to progress open partner leads (ASM/RSM coaching nudge).
 */
export async function notifyRmToProgressLeads(rmId, {
  askedByName = "Manager",
  askedByRole = "ASM",
  openLeadsCount = 0,
  applicationId = null,
  appNo = null,
  remarks = "",
} = {}) {
  if (!rmId) return { notified: false };

  const leadPhrase =
    openLeadsCount > 0
      ? `${openLeadsCount} open Step-1 lead(s)`
      : "open Step-1 leads";

  await createNotification(String(rmId), {
    title: `${askedByRole} asked you to progress leads`,
    message:
      `${askedByName} (${askedByRole}) asked you to follow up with partners` +
      ` and get them to complete loan forms for ${leadPhrase}.` +
      (appNo ? ` Focus: ${appNo}.` : "") +
      (remarks ? ` Remarks: ${remarks}` : ""),
    type: "APPLICATION",
    meta: {
      reason: "LEAD_PROGRESS_NUDGE",
      applicationId,
      appNo,
      openLeadsCount,
      askedByRole,
    },
  });

  return { notified: true };
}

/**
 * Open LEAD counts per RM (for ASM/RSM follow-up boards).
 */
export async function openLeadStatsByRm(rmIds = []) {
  const result = new Map();
  if (!rmIds?.length) return result;

  const ids = rmIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
  );
  for (const id of ids) {
    result.set(String(id), {
      openLeadsCount: 0,
      partnerLeadsCount: 0,
      overdueLeadsCount: 0,
      agingOver48hCount: 0,
    });
  }

  const now = Date.now();
  const leads = await Application.find(
    activeApplicationsFilter({
      status: "LEAD",
      rmId: { $in: ids },
    })
  )
    .select("rmId leadSource leadFollowUp createdAt")
    .lean();

  for (const lead of leads) {
    const key = String(lead.rmId);
    const entry = result.get(key);
    if (!entry) continue;
    entry.openLeadsCount += 1;
    if (String(lead.leadSource || "PARTNER").toUpperCase() === "PARTNER") {
      entry.partnerLeadsCount += 1;
    }
    const nextDue = lead.leadFollowUp?.nextFollowUpDate
      ? new Date(lead.leadFollowUp.nextFollowUpDate).getTime()
      : null;
    if (nextDue && nextDue < now) entry.overdueLeadsCount += 1;
    const ageMs = now - new Date(lead.createdAt).getTime();
    if (ageMs > 48 * 60 * 60 * 1000) entry.agingOver48hCount += 1;
  }

  return result;
}

/**
 * Open LEAD counts per partner (for RM partner follow-up board).
 */
export async function openLeadStatsByPartner(partnerIds = []) {
  const result = new Map();
  if (!partnerIds?.length) return result;

  const ids = partnerIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
  );
  for (const id of ids) {
    result.set(String(id), {
      openLeadsCount: 0,
      leads: [],
    });
  }

  const leads = await Application.find(
    activeApplicationsFilter({
      status: "LEAD",
      partnerId: { $in: ids },
    })
  )
    .select("partnerId appNo loanType requestedAmount customer leadFollowUp createdAt leadSource")
    .sort({ updatedAt: -1 })
    .lean();

  for (const lead of leads) {
    const key = String(lead.partnerId);
    const entry = result.get(key);
    if (!entry) continue;
    entry.openLeadsCount += 1;
    if (entry.leads.length < 5) {
      entry.leads.push({
        applicationId: lead._id,
        appNo: lead.appNo,
        loanType: lead.loanType,
        customerName: customerDisplayName(lead),
        leadFollowUpStatus: lead.leadFollowUp?.status || "NEW",
        createdAt: lead.createdAt,
      });
    }
  }

  return result;
}

/**
 * Count applications that count as "form completed" (past Step-1 LEAD).
 * A partner with only LEADs is treated as not filled.
 */
export async function completedFormCountsByPartner(partnerIds = []) {
  const map = new Map();
  if (!partnerIds?.length) return map;

  const ids = partnerIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
  );

  const rows = await Application.aggregate([
    {
      $match: activeApplicationsFilter({
        partnerId: { $in: ids },
        status: { $nin: ["LEAD"] },
      }),
    },
    { $group: { _id: "$partnerId", count: { $sum: 1 } } },
  ]);

  for (const r of rows) map.set(String(r._id), r.count);
  return map;
}

/**
 * Format hierarchy LEAD rows for ASM/RSM inbox.
 */
export function formatHierarchyLead(app) {
  return {
    id: app._id,
    applicationId: app._id,
    appNo: app.appNo,
    status: app.status,
    loanType: app.loanType,
    requestedAmount: app.customer?.loanAmount || app.requestedAmount || 0,
    leadSource: app.leadSource || "PARTNER",
    leadFollowUp: app.leadFollowUp || { status: "NEW", remarks: "" },
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    customerName: customerDisplayName(app),
    customerPhone: app.customer?.phone || app.customerId?.phone || "",
    customerEmail: app.customer?.email || app.customerId?.email || "",
    partner: {
      id: app.partnerId?._id || app.partnerId || null,
      name: `${app.partnerId?.firstName || ""} ${app.partnerId?.lastName || ""}`.trim(),
      phone: app.partnerId?.phone || "",
      code: app.partnerId?.partnerCode || "",
    },
    rm: {
      id: app.rmId?._id || app.rmId || null,
      name: `${app.rmId?.firstName || ""} ${app.rmId?.lastName || ""}`.trim(),
      employeeId: app.rmId?.employeeId || "",
      phone: app.rmId?.phone || "",
    },
  };
}

export async function loadUserDisplayName(userId) {
  if (!userId) return "Manager";
  const u = await User.findById(userId).select("firstName lastName role").lean();
  if (!u) return "Manager";
  return `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.role || "Manager";
}
