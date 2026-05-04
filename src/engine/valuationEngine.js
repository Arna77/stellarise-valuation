/**
 * Valuation Engine — Core AVM Logic
 *
 * Implements the 5-step comparable-based valuation:
 *   1. Comparable selection (via comparableSelector)
 *   2. Similarity scoring
 *   3. Time adjustment using area trends
 *   4. Feature adjustments (rules-based, capped at ±15%)
 *   5. Weighted PSF → estimate range + confidence
 */

const { selectComparables, getCompatibleTypes, MIN_COMPS } = require("./comparableSelector");

const METHOD_VERSION = "v1.0";
const MAX_ADJUSTMENT_CAP = 0.15; // ±15% max total adjustment per comp

/**
 * Run a full valuation estimate.
 *
 * @param {Object} subject    - SubjectProperty record
 * @param {Array}  compPool   - All ComparableTransaction records in area
 * @param {Array}  areaTrends - AreaTrend records for the subject's area
 * @returns {Object} Full valuation result
 */
function estimatePropertyValue(subject, compPool, areaTrends) {
  // Step 1: Select best comparables
  const comps = selectComparables(subject, compPool);

  if (comps.length === 0) {
    return noResultResponse(subject, "No comparable transactions found in the area");
  }

  // Steps 2-4: Score, adjust time, adjust features for each comp
  const scored = comps.map((comp) => {
    // Step 3: Time adjustment
    const timeFactor = getTimeFactor(comp, subject, areaTrends);
    const timeAdjustedPsf = Number(comp.psf) * timeFactor;

    // Step 4: Feature adjustments
    const adjustments = calcFeatureAdjustments(subject, comp);
    const featureSum = clamp(sumValues(adjustments), -MAX_ADJUSTMENT_CAP, MAX_ADJUSTMENT_CAP);
    const adjustedPsf = timeAdjustedPsf * (1 + featureSum);

    // Weight = similarity * recency bonus
    const recencyBonus = comp.ageMonths <= 6 ? 1.0 : comp.ageMonths <= 9 ? 0.85 : 0.70;
    const weight = comp.similarityScore * recencyBonus;

    return {
      comp,
      timeAdjustedPsf: round2(timeAdjustedPsf),
      adjustments,
      featureSum: round2(featureSum),
      adjustedPsf: round2(adjustedPsf),
      weight: round2(weight),
    };
  });

  // Step 5: Weighted average PSF → estimate
  const totalWeight = scored.reduce((s, x) => s + x.weight, 0);
  const weightedPsf = scored.reduce((s, x) => s + x.adjustedPsf * x.weight, 0) / totalWeight;
  const estimateMid = weightedPsf * Number(subject.builtUpSqft);

  // Confidence scoring
  const confidence = calcConfidence(subject, scored);
  const bandWidth = confidence.score >= 85 ? 0.03 : confidence.score >= 70 ? 0.05 : 0.08;

  const estimateLow = estimateMid * (1 - bandWidth);
  const estimateHigh = estimateMid * (1 + bandWidth);

  // Suggested listing range (slightly above market value)
  const listingMultiplierLow = confidence.score >= 85 ? 1.02 : 1.01;
  const listingMultiplierHigh = confidence.score >= 85 ? 1.05 : 1.08;

  return {
    marketValue: {
      low: roundTo1000(estimateLow),
      mid: roundTo1000(estimateMid),
      high: roundTo1000(estimateHigh),
    },
    suggestedListing: {
      low: roundTo1000(estimateMid * listingMultiplierLow),
      high: roundTo1000(estimateMid * listingMultiplierHigh),
    },
    confidence,
    pricingBasis: {
      weightedPsf: round2(weightedPsf),
      compCount: scored.length,
    },
    comparables: scored.map((s) => ({
      projectName: s.comp.projectName,
      transactionDate: s.comp.transactionDate,
      price: Number(s.comp.transactedPrice),
      builtUpSqft: Number(s.comp.builtUpSqft),
      psf: Number(s.comp.psf),
      adjustedPsf: s.adjustedPsf,
      similarityScore: round2(s.comp.similarityScore),
      locationTier: s.comp.locationTier,
      adjustments: formatAdjustments(s.adjustments),
      weight: s.weight,
    })),
    methodVersion: METHOD_VERSION,
    disclaimer: "Indicative estimate only. Not a certified valuation. For financing or legal purposes, consult a registered valuer.",
  };
}

// ── Step 3: Time Adjustment ─────────────────────────────────────────────────

function getTimeFactor(comp, subject, areaTrends) {
  if (!areaTrends || areaTrends.length === 0) return 1.0;

  // Find the trend factor closest to the comp's transaction date
  const compDate = new Date(comp.transactionDate);
  const now = new Date();

  // Find latest trend entry for the area; accept compatible types (e.g. serviced_residence ↔ condominium)
  const compatibleTypes = getCompatibleTypes(subject.propertyType);
  const relevantTrends = areaTrends.filter(
    (t) => compatibleTypes.has(t.propertyType)
  );

  if (relevantTrends.length < 2) return 1.0;

  // Sort by period ascending
  relevantTrends.sort((a, b) => new Date(a.period) - new Date(b.period));

  const latestFactor = Number(relevantTrends[relevantTrends.length - 1].priceIndexFactor);
  const compPeriodTrend = relevantTrends.find((t) => {
    const tp = new Date(t.period);
    return tp.getFullYear() === compDate.getFullYear() && tp.getMonth() === compDate.getMonth();
  });

  if (!compPeriodTrend) return 1.0;

  const compFactor = Number(compPeriodTrend.priceIndexFactor);
  if (compFactor === 0) return 1.0;

  return latestFactor / compFactor;
}

// ── Step 4: Feature Adjustments ─────────────────────────────────────────────

function calcFeatureAdjustments(subject, comp) {
  return {
    project: projectAdjustment(subject, comp),
    tenure: tenureAdjustment(subject, comp),
    floor: floorAdjustment(subject, comp),
    renovation: renovationAdjustment(subject, comp),
    view: viewAdjustment(subject, comp),
    age: ageAdjustment(subject, comp),
    lot: lotAdjustment(subject, comp),
  };
}

function projectAdjustment(subject, comp) {
  // Same project = no adjustment; different project = discount
  if (comp.locationTier === "same_project") return 0;
  if (comp.locationTier === "same_area") return -0.03;
  return -0.06;
}

function tenureAdjustment(subject, comp) {
  if (subject.tenure === comp.tenure) return 0;
  // Subject is freehold, comp is leasehold → comp's psf is lower, adjust up
  if (subject.tenure === "freehold" && comp.tenure === "leasehold") return 0.05;
  // Subject is leasehold, comp is freehold → adjust down
  return -0.05;
}

function floorAdjustment(subject, comp) {
  if (!subject.floorLevel || !comp.floorLevel) return 0;
  if (subject.propertyType === "terrace" || subject.propertyType === "semi_detached" || subject.propertyType === "bungalow") return 0;

  const diff = subject.floorLevel - comp.floorLevel;
  if (Math.abs(diff) <= 2) return 0;
  // +1% per 5 floors higher, capped at 5%
  return clamp(diff * 0.002, -0.05, 0.05);
}

function renovationAdjustment(subject, comp) {
  const levels = { original: 0, light: 1, moderate: 2, extensive: 3 };
  const subLevel = levels[subject.renovationLevel] ?? 0;
  const compLevel = levels[comp.renovationProxy] ?? 0;
  const diff = subLevel - compLevel;
  // +3% per reno level above comp, capped at 10%
  return clamp(diff * 0.03, -0.10, 0.10);
}

function viewAdjustment(subject, comp) {
  const viewRanks = { poor: 0, normal: 1, open: 2, premium: 3 };
  const subView = viewRanks[subject.viewQuality] ?? 1;
  const compView = viewRanks["normal"]; // comp view usually unknown
  const diff = subView - compView;
  return clamp(diff * 0.02, -0.06, 0.06);
}

function ageAdjustment(subject, comp) {
  if (!subject.yearCompleted || !comp.yearCompleted) return 0;
  const diff = comp.yearCompleted - subject.yearCompleted; // positive = comp is newer
  // Older subject → slight discount relative to newer comp
  return clamp(diff * 0.01, -0.06, 0.06);
}

function lotAdjustment(subject, comp) {
  let adj = 0;
  if (subject.cornerFlag) adj += 0.04;
  if (subject.endLotFlag) adj += 0.02;
  return adj;
}

// ── Confidence Scoring ──────────────────────────────────────────────────────

function calcConfidence(subject, scored) {
  let score = 100;
  const reasons = [];

  // Comp count
  if (scored.length < MIN_COMPS) {
    score -= 25;
    reasons.push(`Only ${scored.length} comparable(s) found (minimum ${MIN_COMPS} preferred)`);
  } else {
    reasons.push(`${scored.length} recent comparable transactions found`);
  }

  // Same-project check
  const sameProjectCount = scored.filter((s) => s.comp.locationTier === "same_project").length;
  if (sameProjectCount === 0) {
    score -= 15;
    reasons.push("No same-project comparable available");
  } else {
    reasons.push(`${sameProjectCount} same-project comparable(s) used`);
  }

  // Cross-type note (e.g. user entered serviced_residence, data stored as condominium)
  const crossTypeCount = scored.filter((s) => s.comp.crossType).length;
  if (crossTypeCount > 0) {
    score -= 5;
    reasons.push(`${crossTypeCount} comparable(s) from a similar property sub-type — minor PSF adjustment applied`);
  }

  // Average comp age
  const avgAge = scored.reduce((s, x) => s + x.comp.ageMonths, 0) / scored.length;
  if (avgAge > 9) {
    score -= 10;
    reasons.push(`Average comparable age is ${Math.round(avgAge)} months (stale)`);
  } else {
    reasons.push(`Average comparable age is ${Math.round(avgAge)} months`);
  }

  // PSF standard deviation
  const psfs = scored.map((s) => s.adjustedPsf);
  const stdDev = calcStdDev(psfs);
  const mean = psfs.reduce((s, v) => s + v, 0) / psfs.length;
  const cv = mean > 0 ? stdDev / mean : 0;
  if (cv > 0.15) {
    score -= 20;
    reasons.push("High price dispersion among comparables");
  } else if (cv > 0.10) {
    score -= 10;
    reasons.push("Moderate price dispersion among comparables");
  }

  // Missing critical subject fields
  if (!subject.projectName) { score -= 10; reasons.push("Missing project name reduces match quality"); }
  if (!subject.yearCompleted) { score -= 5; }

  score = Math.max(0, Math.min(100, score));

  const band = score >= 85 ? "high" : score >= 70 ? "medium" : "low";

  return { score, band, reasons };
}

// ── No-result fallback ──────────────────────────────────────────────────────

function noResultResponse(subject, reason) {
  return {
    marketValue: null,
    suggestedListing: null,
    confidence: { score: 0, band: "low", reasons: [reason] },
    pricingBasis: { weightedPsf: 0, compCount: 0 },
    comparables: [],
    methodVersion: METHOD_VERSION,
    disclaimer: "Unable to produce an estimate. Please request a registered valuer review.",
  };
}

// ── Utilities ───────────────────────────────────────────────────────────────

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
function round2(n) { return Math.round(n * 100) / 100; }
function roundTo1000(n) { return Math.round(n / 1000) * 1000; }
function sumValues(obj) { return Object.values(obj).reduce((s, v) => s + v, 0); }

function calcStdDev(arr) {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function formatAdjustments(adj) {
  return Object.entries(adj)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${round2(v * 100)}%`);
}

module.exports = { estimatePropertyValue };
