// The default guardrail numbers, and the range each one may be set to from the brain
// (policy/thresholds, or the `threshold` command). Listed in docs/SETTINGS.md.
export const DEFAULTS = Object.freeze({
  pause: {
    zeroResultSpend: 3,     // an ad with zero results after spending 3x the target is a clear loser
    overTargetMult: 3,      // or one costing 3x the target per result ...
    minDays: 3,             // ... over at least 3 mature days
    heavyOverMult: 1.5,     // or a heavy spender 1.5x over target ...
    heavySpendMult: 10,     // ... after spending 10x the target
    keepMinActive: 1,       // a pause must leave at least this many active ads in the ad set, else it is escalated
  },
  scale: {
    stepPct: 20,            // a raise is at most +20% ...
    minHours: 48,           // ... and at least 48 hours after the last budget change
    minResults: 5,          // the ad set or campaign has at least 5 results in the window
    accountCapMult: 1.3,    // and the total daily budget stays under 1.3x what it was
  },
  descale: {
    stepPct: 20,            // a trim is at most -20% ...
    minHours: 48,           // ... and at least 48 hours after the last budget change
    overTargetMult: 1.25,   // only when cost per result is more than 25% over target
  },
  winner: { minProb: 0.9, minDays: 4, priorResults: 3 },
  data: { lagDays: 2, windowDays: 10 },
  suppression: { rejectCooldownDays: 7, budgetRecommitDays: 2 },
});

// [min, max] for each threshold. A value outside it is refused when it is written.
export const RANGES = Object.freeze({
  pause: { zeroResultSpend: [0.5, 50], overTargetMult: [1, 20], minDays: [1, 30], heavyOverMult: [1, 10], heavySpendMult: [1, 100], keepMinActive: [0, 20] },
  scale: { stepPct: [1, 100], minHours: [0, 720], minResults: [1, 1000], accountCapMult: [1, 10] },
  descale: { stepPct: [1, 100], minHours: [0, 720], overTargetMult: [1, 10] },
  winner: { minProb: [0.5, 0.999], minDays: [1, 30], priorResults: [0, 100] },
  data: { lagDays: [0, 7], windowDays: [3, 60] },
  suppression: { rejectCooldownDays: [0, 90], budgetRecommitDays: [0, 30] },
});
