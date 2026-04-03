import { User } from "../models/User.js";
import { ReferralReward } from "../models/ReferralReward.js";
import { ROLES } from "../config/roles.js";
import { Config } from "../models/Config.js";

function toMoney(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_DISBURSED = 500;
const DEFAULT_SIGNUP = 50;

function envDisbursedFallback() {
  return toMoney(process.env.REFERRAL_DISBURSED_REWARD, DEFAULT_DISBURSED);
}

function envSignupFallback() {
  return toMoney(process.env.REFERRAL_SIGNUP_REWARD, DEFAULT_SIGNUP);
}

/**
 * Effective referral amounts: Super Admin `REFERRAL_REWARD_AMOUNTS` in Config,
 * then env vars, then defaults.
 */
export async function getReferralRewardAmounts() {
  const doc = await Config.findOne({ key: "REFERRAL_REWARD_AMOUNTS" }).lean();
  const v = doc?.value && typeof doc.value === "object" ? doc.value : {};
  const envD = envDisbursedFallback();
  const envS = envSignupFallback();
  return {
    disbursedReward: toMoney(v.disbursedReward, envD),
    signupReward: toMoney(v.signupReward, envS),
    savedInDatabase: !!doc,
  };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lookup by `referralCode` (customers: DS…; partners: same as `partnerCode`, PT-…) */
export async function getReferralOwnerByCode(referralCode) {
  const code = String(referralCode || "").trim().toUpperCase();
  if (!code) return null;
  return User.findOne({ referralCode: code, status: "ACTIVE" })
    .select("_id firstName lastName role referralCode")
    .lean();
}

/** Partner registration / validate: active channel partner by PT-… code */
export async function getActivePartnerByPartnerCode(rawCode) {
  const trimmed = String(rawCode || "").trim();
  if (!trimmed) return null;
  return User.findOne({
    partnerCode: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
    role: ROLES.PARTNER,
    status: "ACTIVE",
  })
    .select("_id firstName lastName role partnerCode referralCode")
    .lean();
}

export async function createSignupReferralReward({ referrerId, referredUserId }) {
  const referrer = await User.findById(referrerId).select("role").lean();
  if (referrer?.role === ROLES.PARTNER) {
    return null;
  }

  const exists = await ReferralReward.findOne({
    referredUserId,
    eventType: "SIGNUP",
  }).lean();
  if (exists) return exists;

  const { signupReward } = await getReferralRewardAmounts();

  return ReferralReward.create({
    referrerId,
    referredUserId,
    eventType: "SIGNUP",
    amount: signupReward,
    status: "PENDING",
    note: "Signup referral reward created",
  });
}

/**
 * Partner→partner program: when a loan disburses, credit the **upline partner**
 * (referredBy on the **originating** partner `application.partnerId`), not the customer.
 */
export async function createDisbursedReferralReward({ application }) {
  const partnerId = application.partnerId;
  if (!partnerId) return null;

  const originatingPartner = await User.findById(partnerId)
    .select("_id referredBy role")
    .lean();
  if (
    !originatingPartner?.referredBy ||
    originatingPartner.role !== ROLES.PARTNER
  ) {
    return null;
  }

  const upline = await User.findById(originatingPartner.referredBy)
    .select("role")
    .lean();
  if (!upline || upline.role !== ROLES.PARTNER) {
    return null;
  }

  const duplicate = await ReferralReward.findOne({
    referredUserId: originatingPartner._id,
    applicationId: application._id,
    eventType: "DISBURSED",
  }).lean();
  if (duplicate) return duplicate;

  const { disbursedReward } = await getReferralRewardAmounts();

  const reward = await ReferralReward.create({
    referrerId: upline._id,
    referredUserId: originatingPartner._id,
    applicationId: application._id,
    eventType: "DISBURSED",
    amount: disbursedReward,
    status: "PENDING",
    note: `Partner referral (disbursal) for ${application.appNo}`,
  });

  return reward;
}
