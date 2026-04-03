import { Router } from "express";
import mongoose from "mongoose";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { User } from "../models/User.js";
import { ReferralReward } from "../models/ReferralReward.js";
import { Application } from "../models/Application.js";
import {
  getReferralWebBaseUrl,
  getInviteBaseUrl,
  appendPartnerShareUtm,
  canonicalPartnerReferralCode,
} from "../config/branding.js";
import { PARTNER_REGISTRATION_PATH_SEGMENT } from "../constants/publicReferral.js";

const router = Router();

const REFERRING_ROLES = [ROLES.CUSTOMER, ROLES.PARTNER];

/** Ensure logged-in user has referralCode (customers/partners get one on User pre-validate) */
router.get(
  "/me",
  auth,
  requireRole(...REFERRING_ROLES),
  async (req, res) => {
    try {
      const me = await User.findById(req.user.sub).select(
        "firstName lastName email role referralCode partnerCode referredBy referralRewardStatus referralRewardAt"
      );
      if (!me) return res.status(404).json({ message: "User not found" });

      const [totalsAgg] = await ReferralReward.aggregate([
        { $match: { referrerId: new mongoose.Types.ObjectId(req.user.sub) } },
        {
          $group: {
            _id: null,
            totalPending: {
              $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, "$amount", 0] },
            },
            totalApproved: {
              $sum: { $cond: [{ $eq: ["$status", "APPROVED"] }, "$amount", 0] },
            },
            totalPaid: {
              $sum: { $cond: [{ $eq: ["$status", "PAID"] }, "$amount", 0] },
            },
            count: { $sum: 1 },
          },
        },
      ]);

      const referredPartnerCount = await User.countDocuments({
        referredBy: req.user.sub,
        role: ROLES.PARTNER,
      });

      const webBase = getReferralWebBaseUrl();
      const inviteBase = getInviteBaseUrl();
      const partnerRefForShare =
        me.role === ROLES.PARTNER
          ? canonicalPartnerReferralCode(me.partnerCode, me.referralCode)
          : "";
      const partnerRef =
        me.role === ROLES.PARTNER && partnerRefForShare
          ? appendPartnerShareUtm(
              `${webBase}/${PARTNER_REGISTRATION_PATH_SEGMENT}?ref=${encodeURIComponent(partnerRefForShare)}`,
              "web"
            )
          : null;

      return res.json({
        referralCode:
          me.role === ROLES.PARTNER
            ? partnerRefForShare || me.referralCode
            : me.referralCode,
        partnerCode:
          me.role === ROLES.PARTNER
            ? partnerRefForShare || me.partnerCode
            : undefined,
        referredBy: me.referredBy,
        referralRewardStatus: me.referralRewardStatus,
        referralRewardAt: me.referralRewardAt,
        /** Ready-to-share URLs (set REFERRAL_WEB_URL / CLIENT_URL on server — default https://dhansourcecapital.com) */
        links: {
          partnerRegistrationRef: partnerRef,
          /** @deprecated same as partnerRegistrationRef */
          webLoginPartnerRef: partnerRef,
          appInvite:
            partnerRefForShare
              ? appendPartnerShareUtm(
                  `${inviteBase}/invite?code=${encodeURIComponent(partnerRefForShare)}`,
                  "invite"
                )
              : me.referralCode
                ? appendPartnerShareUtm(
                    `${inviteBase}/invite?code=${encodeURIComponent(me.referralCode)}`,
                    "invite"
                  )
                : null,
        },
        stats: {
          referralCount: referredPartnerCount,
          partnerSignupReferralCount: referredPartnerCount,
          rewardsCount: totalsAgg?.count ?? 0,
          pendingAmount: totalsAgg?.totalPending ?? 0,
          approvedAmount: totalsAgg?.totalApproved ?? 0,
          paidAmount: totalsAgg?.totalPaid ?? 0,
        },
      });
    } catch (err) {
      console.error("referral /me:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

/** Channel partners you referred (partner→partner program) */
router.get(
  "/me/referrals",
  auth,
  requireRole(...REFERRING_ROLES),
  async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const skip = Math.max(Number(req.query.skip) || 0, 0);

      if (req.user.role === ROLES.CUSTOMER) {
        return res.json({ referrals: [], limit, skip });
      }

      const referred = await User.find({
        referredBy: req.user.sub,
        role: ROLES.PARTNER,
      })
        .select(
          "firstName lastName email phone createdAt status employeeId partnerCode referralRewardStatus referralRewardAt"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const partnerIds = referred.map((u) => u._id);
      const apps = await Application.find({
        partnerId: { $in: partnerIds },
        deletedAt: null,
      })
        .select("partnerId status appNo loanType customerId")
        .lean();

      const appByPartner = new Map();
      for (const a of apps) {
        const key = String(a.partnerId);
        if (!appByPartner.has(key)) appByPartner.set(key, []);
        appByPartner.get(key).push({
          appNo: a.appNo,
          status: a.status,
          loanType: a.loanType,
        });
      }

      const enriched = referred.map((u) => ({
        ...u,
        applications: appByPartner.get(String(u._id)) || [],
      }));

      res.json({ referrals: enriched, limit, skip });
    } catch (err) {
      console.error("referral /me/referrals:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

/** Your referral reward ledger (as referrer) */
router.get(
  "/me/earnings",
  auth,
  requireRole(...REFERRING_ROLES),
  async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const skip = Math.max(Number(req.query.skip) || 0, 0);
      const status = req.query.status;

      const filter = { referrerId: req.user.sub };
      if (status && ["PENDING", "APPROVED", "PAID", "CANCELLED"].includes(String(status))) {
        filter.status = status;
      }

      const [items, total] = await Promise.all([
        ReferralReward.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate("referredUserId", "firstName lastName email phone employeeId")
          .populate("applicationId", "appNo status loanType approvedLoanAmount")
          .lean(),
        ReferralReward.countDocuments(filter),
      ]);

      res.json({ rewards: items, total, limit, skip });
    } catch (err) {
      console.error("referral /me/earnings:", err);
      res.status(500).json({ message: err.message || "Server error" });
    }
  }
);

export default router;
