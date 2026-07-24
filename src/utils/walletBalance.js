import mongoose from "mongoose";
import { Payout } from "../models/Payout.js";
import { Incentive } from "../models/Incentive.js";
import { WithdrawalRequest } from "../models/WithdrawalRequest.js";

export async function getPartnerWalletBalance(partnerId) {
  const pid = new mongoose.Types.ObjectId(partnerId);

  const [payoutAgg, incentiveAgg, lockedAgg] = await Promise.all([
    Payout.aggregate([
      { $match: { partnerId: pid, payOutStatus: "PENDING" } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$amount", 0] } } } },
    ]),
    Incentive.aggregate([
      { $match: { partnerId: pid, status: "PENDING" } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$amount", 0] } } } },
    ]),
    WithdrawalRequest.aggregate([
      {
        $match: {
          partnerId: pid,
          status: { $in: ["PENDING_ASM", "PENDING_ADMIN"] },
        },
      },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$amount", 0] } } } },
    ]),
  ]);

  const pendingPayout = Number(payoutAgg[0]?.total || 0);
  const pendingIncentive = Number(incentiveAgg[0]?.total || 0);
  const locked = Number(lockedAgg[0]?.total || 0);
  const gross = pendingPayout + pendingIncentive;
  const available = Math.max(0, gross - locked);

  return { pendingPayout, pendingIncentive, locked, gross, available };
}

export async function settlePendingEarnings(partnerId, amount, adminId) {
  const pid = new mongoose.Types.ObjectId(partnerId);
  let remaining = Number(amount) || 0;
  const settledPayoutIds = [];
  const settledIncentiveIds = [];

  if (remaining <= 0) return { settledPayoutIds, settledIncentiveIds, remaining };

  const payouts = await Payout.find({ partnerId: pid, payOutStatus: "PENDING" })
    .sort({ createdAt: 1 })
    .exec();

  for (const p of payouts) {
    if (remaining <= 0) break;
    const amt = Number(p.amount) || 0;
    if (amt <= 0) continue;
    if (amt <= remaining + 0.0001) {
      p.payOutStatus = "DONE";
      await p.save();
      settledPayoutIds.push(p._id);
      remaining -= amt;
    }
  }

  const incentives = await Incentive.find({ partnerId: pid, status: "PENDING" })
    .sort({ createdAt: 1 })
    .exec();

  for (const inc of incentives) {
    if (remaining <= 0) break;
    const amt = Number(inc.amount) || 0;
    if (amt <= 0) continue;
    if (amt <= remaining + 0.0001) {
      inc.status = "PAID";
      inc.paidAt = new Date();
      if (adminId) inc.paidBy = adminId;
      await inc.save();
      settledIncentiveIds.push(inc._id);
      remaining -= amt;
    }
  }

  return { settledPayoutIds, settledIncentiveIds, remaining };
}
