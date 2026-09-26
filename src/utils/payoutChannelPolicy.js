/**
 * Resolve commission % from DEFAULT_PAYOUT_POLICY using loan type + partner channel.
 * Rickshaw partners get channelMultipliers.RICKSHAW (default 0.5×).
 */
export function resolvePayoutPercentage(policy = {}, loanType, partnerChannelType) {
  const base =
    policy[loanType] != null
      ? Number(policy[loanType])
      : policy.DEFAULT != null
        ? Number(policy.DEFAULT)
        : 2.0;

  if (!Number.isFinite(base)) return 2.0;

  const multipliers = policy.channelMultipliers || {};
  const channel = String(partnerChannelType || "").toUpperCase();
  const mult =
    channel && multipliers[channel] != null
      ? Number(multipliers[channel])
      : 1;

  const factor = Number.isFinite(mult) && mult > 0 ? mult : 1;
  return Number((base * factor).toFixed(4));
}

/** Default channel multipliers shipped with payout policy */
export const DEFAULT_CHANNEL_MULTIPLIERS = {
  RICKSHAW: 0.5,
  NET_CAFE: 1.0,
  KIRANA: 1.0,
  OTHER: 1.0,
};
