/**
 * Comparable Selection Engine
 *
 * Filters and ranks comparable transactions against a subject property.
 * Selection priority: same project > same micro-area > wider radius.
 * Minimum 3 comps, ideal 5-8.
 */

const MAX_AGE_MONTHS = 12;
const PREFERRED_AGE_MONTHS = 6;
const SIZE_VARIANCE_THRESHOLD = 0.20; // 20%
const MIN_COMPS = 3;
const IDEAL_COMPS = 8;

/**
 * Filter comparables from the transaction pool.
 * @param {Object} subject - SubjectProperty record
 * @param {Array}  pool    - All ComparableTransaction records in area
 * @returns {Array} Filtered and scored comparables
 */
function selectComparables(subject, pool) {
  const now = new Date();

  // Step 1: Hard filters
  let candidates = pool.filter((comp) => {
    // Same property type only
    if (comp.propertyType !== subject.propertyType) return false;

    // Transaction within MAX_AGE_MONTHS
    const ageMonths = monthsDiff(comp.transactionDate, now);
    if (ageMonths > MAX_AGE_MONTHS) return false;

    // Built-up size variance within threshold
    const sizeRatio = Math.abs(Number(comp.builtUpSqft) - Number(subject.builtUpSqft)) / Number(subject.builtUpSqft);
    if (sizeRatio > SIZE_VARIANCE_THRESHOLD) return false;

    return true;
  });

  // Step 2: Tier by location proximity
  const sameProject = candidates.filter(
    (c) => c.projectName && subject.projectName && normalize(c.projectName) === normalize(subject.projectName)
  );
  const samePostcode = candidates.filter(
    (c) => c.postcode === subject.postcode && !isSameProject(c, subject)
  );
  const sameCity = candidates.filter(
    (c) => c.city === subject.city && c.postcode !== subject.postcode
  );

  // Build priority list: same project first, then postcode, then city, then state-wide fallback
  let selected = [...sameProject];
  if (selected.length < IDEAL_COMPS) {
    selected.push(...samePostcode.slice(0, IDEAL_COMPS - selected.length));
  }
  if (selected.length < IDEAL_COMPS) {
    selected.push(...sameCity.slice(0, IDEAL_COMPS - selected.length));
  }
  // State-wide fallback — used when postcode/city don't match (e.g. user entered wrong postcode)
  if (selected.length < MIN_COMPS) {
    const alreadySelected = new Set(selected.map(c => c.id || c.sourceRef));
    const wider = candidates.filter(c => !alreadySelected.has(c.id || c.sourceRef));
    selected.push(...wider.slice(0, IDEAL_COMPS - selected.length));
  }

  // Step 3: Score each comparable
  selected = selected.map((comp) => ({
    ...comp,
    similarityScore: calcSimilarity(subject, comp),
    locationTier: isSameProject(comp, subject) ? "same_project" : comp.postcode === subject.postcode ? "same_area" : comp.city === subject.city ? "wider" : "state_wide",
    ageMonths: monthsDiff(comp.transactionDate, now),
  }));

  // Sort by similarity descending
  selected.sort((a, b) => b.similarityScore - a.similarityScore);

  return selected.slice(0, IDEAL_COMPS);
}

/**
 * Calculate similarity score (0 to 1) between subject and comparable.
 *
 * Weights:
 *   location  0.35
 *   size      0.20
 *   tenure    0.10
 *   age       0.10
 *   floor     0.10
 *   condition 0.10
 *   attribute 0.05
 */
function calcSimilarity(subject, comp) {
  const location = locationScore(subject, comp);
  const size = sizeScore(subject, comp);
  const tenure = tenureScore(subject, comp);
  const age = ageScore(subject, comp);
  const floor = floorScore(subject, comp);
  const condition = conditionScore(subject, comp);
  const attribute = attributeScore(subject, comp);

  return (
    0.35 * location +
    0.20 * size +
    0.10 * tenure +
    0.10 * age +
    0.10 * floor +
    0.10 * condition +
    0.05 * attribute
  );
}

// ── Scoring Components ──────────────────────────────────────────────────────

function locationScore(subject, comp) {
  if (isSameProject(comp, subject)) return 1.0;
  if (comp.postcode === subject.postcode) return 0.85;
  if (comp.city === subject.city) return 0.70;
  return 0.50;
}

function sizeScore(subject, comp) {
  const diff = Math.abs(Number(comp.builtUpSqft) - Number(subject.builtUpSqft)) / Number(subject.builtUpSqft);
  return Math.max(0, 1 - diff * 5); // Linear decay, 0 at 20% diff
}

function tenureScore(subject, comp) {
  return subject.tenure === comp.tenure ? 1.0 : 0.80;
}

function ageScore(subject, comp) {
  if (!subject.yearCompleted || !comp.yearCompleted) return 0.7;
  const diff = Math.abs(subject.yearCompleted - comp.yearCompleted);
  if (diff === 0) return 1.0;
  if (diff <= 2) return 0.9;
  if (diff <= 5) return 0.75;
  return 0.5;
}

function floorScore(subject, comp) {
  if (!subject.floorLevel || !comp.floorLevel) return 0.7;
  const diff = Math.abs(subject.floorLevel - comp.floorLevel);
  if (diff <= 2) return 1.0;
  if (diff <= 5) return 0.85;
  if (diff <= 10) return 0.70;
  return 0.50;
}

function conditionScore(subject, comp) {
  const levels = { original: 0, light: 1, moderate: 2, extensive: 3 };
  const subLevel = levels[subject.renovationLevel] ?? 1;
  const compLevel = levels[comp.renovationProxy] ?? 1;
  const diff = Math.abs(subLevel - compLevel);
  return diff === 0 ? 1.0 : diff === 1 ? 0.80 : 0.60;
}

function attributeScore(subject, comp) {
  let score = 1.0;
  if (subject.carParks && comp.carParks && subject.carParks !== comp.carParks) score -= 0.15;
  if (subject.cornerFlag && !comp.cornerFlag) score -= 0.10;
  if (subject.gatedGuarded && !comp.gatedGuarded) score -= 0.10;
  return Math.max(0, score);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSameProject(comp, subject) {
  return comp.projectName && subject.projectName && normalize(comp.projectName) === normalize(subject.projectName);
}

function monthsDiff(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.abs((d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()));
}

module.exports = { selectComparables, calcSimilarity, MIN_COMPS };
