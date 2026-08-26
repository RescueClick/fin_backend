import { Config } from "../models/Config.js";

/**
 * Default Industry Standard Monthly Disbursement Incentive Slabs
 */
export const DEFAULT_INCENTIVE_SLABS = [
  {
    id: "slab_1",
    tier: "Bronze",
    minDisbursement: 1000000, // ₹10,00,000 (10 Lakhs)
    rewardAmount: 1000,       // ₹1,000 Bonus
    rewardType: "FLAT",
  },
  {
    id: "slab_2",
    tier: "Silver",
    minDisbursement: 2000000, // ₹20,00,000 (20 Lakhs)
    rewardAmount: 2500,       // ₹2,500 Bonus
    rewardType: "FLAT",
  },
  {
    id: "slab_3",
    tier: "Gold",
    minDisbursement: 5000000, // ₹50,00,000 (50 Lakhs)
    rewardAmount: 7500,       // ₹7,500 Bonus
    rewardType: "FLAT",
  },
  {
    id: "slab_4",
    tier: "Platinum",
    minDisbursement: 10000000, // ₹1,00,00,000 (1 Crore)
    rewardAmount: 20000,       // ₹20,000 Bonus
    rewardType: "FLAT",
  },
];

/**
 * Fetch active incentive slabs from DB Config or return defaults
 */
export const getActiveIncentiveSlabs = async () => {
  try {
    const config = await Config.findOne({ key: "INCENTIVE_SLAB_POLICY" }).lean();
    if (config?.value && Array.isArray(config.value) && config.value.length > 0) {
      return config.value.sort((a, b) => Number(a.minDisbursement) - Number(b.minDisbursement));
    }
  } catch (err) {
    console.error("Error fetching INCENTIVE_SLAB_POLICY:", err);
  }
  return DEFAULT_INCENTIVE_SLABS;
};

/**
 * Calculate milestone achievement for a given disbursed volume
 * @param {number} disbursedVolume - Total disbursed loan amount in INR for the period
 * @param {Array} slabs - Active incentive slabs
 */
export const calculatePartnerMilestone = (disbursedVolume = 0, slabs = DEFAULT_INCENTIVE_SLABS) => {
  const volume = Math.max(0, Number(disbursedVolume || 0));
  const sorted = [...slabs].sort((a, b) => Number(a.minDisbursement) - Number(b.minDisbursement));

  let achievedSlab = null;
  let nextSlab = null;

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (volume >= Number(s.minDisbursement)) {
      achievedSlab = s;
    } else if (!nextSlab) {
      nextSlab = s;
    }
  }

  // Calculate incentive reward amount
  let incentiveAmount = 0;
  if (achievedSlab) {
    if (achievedSlab.rewardType === "PERCENT") {
      incentiveAmount = (volume * Number(achievedSlab.rewardAmount)) / 100;
    } else {
      incentiveAmount = Number(achievedSlab.rewardAmount);
    }
  }

  // Calculate progress towards next slab
  let remainingToNext = 0;
  let progressPercent = 100;

  if (nextSlab) {
    const nextTarget = Number(nextSlab.minDisbursement);
    const prevTarget = achievedSlab ? Number(achievedSlab.minDisbursement) : 0;
    remainingToNext = Math.max(0, nextTarget - volume);

    const range = nextTarget - prevTarget;
    const progressInRange = volume - prevTarget;
    progressPercent = Math.min(100, Math.max(0, Math.round((progressInRange / (range || 1)) * 100)));
  }

  return {
    disbursedVolume: volume,
    achievedSlab,
    nextSlab,
    isEligible: achievedSlab !== null,
    incentiveAmount: Math.round(incentiveAmount),
    tier: achievedSlab ? achievedSlab.tier : "Standard",
    remainingToNextMilestone: remainingToNext,
    progressPercent,
  };
};
