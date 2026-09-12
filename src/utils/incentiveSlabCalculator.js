import { Config } from "../models/Config.js";

/**
 * Standard Monthly Disbursement Incentive / Bonus Policy
 * Core Rule: ₹1,000 Cash Bonus for every ₹10,00,000 (10 Lakhs) Disbursed onwards.
 */
export const INCENTIVE_PLAN_RULE = {
  unitDisbursement: 1000000, // ₹10,00,000
  unitReward: 1000,          // ₹1,000
  ruleText: "Earn ₹1,000 cash bonus for every ₹10 Lakhs disbursed in a calendar month (₹10L = ₹1,000, ₹20L = ₹2,000, ₹30L = ₹3,000 ... onwards).",
};

export const DEFAULT_INCENTIVE_SLABS = [
  {
    id: "slab_1",
    tier: "Bronze",
    minDisbursement: 1000000, // ₹10 Lakhs
    rewardAmount: 1000,       // ₹1,000 Bonus
    rewardType: "FLAT",
    description: "₹10 Lakhs Disbursed ➔ ₹1,000 Bonus",
  },
  {
    id: "slab_2",
    tier: "Silver",
    minDisbursement: 2000000, // ₹20 Lakhs
    rewardAmount: 2000,       // ₹2,000 Bonus
    rewardType: "FLAT",
    description: "₹20 Lakhs Disbursed ➔ ₹2,000 Bonus",
  },
  {
    id: "slab_3",
    tier: "Gold",
    minDisbursement: 3000000, // ₹30 Lakhs
    rewardAmount: 3000,       // ₹3,000 Bonus
    rewardType: "FLAT",
    description: "₹30 Lakhs Disbursed ➔ ₹3,000 Bonus",
  },
  {
    id: "slab_4",
    tier: "Ruby",
    minDisbursement: 4000000, // ₹40 Lakhs
    rewardAmount: 4000,       // ₹4,000 Bonus
    rewardType: "FLAT",
    description: "₹40 Lakhs Disbursed ➔ ₹4,000 Bonus",
  },
  {
    id: "slab_5",
    tier: "Diamond",
    minDisbursement: 5000000, // ₹50 Lakhs
    rewardAmount: 5000,       // ₹5,000 Bonus
    rewardType: "FLAT",
    description: "₹50 Lakhs Disbursed ➔ ₹5,000 Bonus",
  },
  {
    id: "slab_6",
    tier: "Platinum",
    minDisbursement: 10000000, // ₹1 Crore
    rewardAmount: 10000,       // ₹10,000 Bonus
    rewardType: "FLAT",
    description: "₹1 Crore Disbursed ➔ ₹10,000 Bonus",
  },
  {
    id: "slab_7",
    tier: "Titanium",
    minDisbursement: 20000000, // ₹2 Crores
    rewardAmount: 20000,       // ₹20,000 Bonus
    rewardType: "FLAT",
    description: "₹2 Crores Disbursed ➔ ₹20,000 Bonus",
  },
  {
    id: "slab_8",
    tier: "Crown Elite",
    minDisbursement: 50000000, // ₹5 Crores
    rewardAmount: 50000,       // ₹50,000 Bonus
    rewardType: "FLAT",
    description: "₹5 Crores Disbursed ➔ ₹50,000 Bonus",
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
  const activeSlabs = Array.isArray(slabs) && slabs.length > 0 ? slabs : DEFAULT_INCENTIVE_SLABS;
  const sorted = [...activeSlabs].sort((a, b) => Number(a.minDisbursement) - Number(b.minDisbursement));

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

  // Progressive onwards: Every complete ₹10 Lakhs yields at least ₹1,000 bonus
  const perTenLakhBonus = Math.floor(volume / 1000000) * 1000;
  if (volume >= 1000000 && perTenLakhBonus > incentiveAmount) {
    incentiveAmount = perTenLakhBonus;
  }

  // If partner disbursed beyond the highest configured slab, compute progressive onwards bonus
  const highestSlab = sorted[sorted.length - 1];
  if (highestSlab && volume >= Number(highestSlab.minDisbursement)) {
    // Dynamic next slab (e.g. next 10 Lakhs milestone)
    const nextMilestone = (Math.floor(volume / 1000000) + 1) * 1000000;
    nextSlab = {
      id: `dynamic_slab_${nextMilestone}`,
      tier: "Crown Plus",
      minDisbursement: nextMilestone,
      rewardAmount: (nextMilestone / 1000000) * 1000,
      rewardType: "FLAT",
      description: `₹${(nextMilestone / 100000).toLocaleString("en-IN")} Lakhs Disbursed ➔ ₹${((nextMilestone / 1000000) * 1000).toLocaleString("en-IN")} Bonus`,
    };
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
    rule: INCENTIVE_PLAN_RULE,
  };
};

