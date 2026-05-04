/**
 * Database seeder — populates comparable_transactions and area_trends
 * from the generated NAPIC seed data.
 *
 * Safe to run multiple times: skips if data already exists.
 * Called automatically by server.js on first boot.
 */

const prisma = require("./prismaClient");
const { generateSeedTransactions, generateAreaTrends } = require("../adapters/napicAdapter");

// Valid Prisma enum values
const VALID_PROPERTY_TYPES = new Set([
  "condominium", "apartment", "serviced_residence", "flat",
  "terrace", "semi_detached", "bungalow", "townhouse",
  "cluster_house", "commercial",
]);

const VALID_TENURES    = new Set(["freehold", "leasehold"]);
const VALID_RENO       = new Set(["original", "light", "moderate", "extensive"]);
const VALID_CONF_TAG   = new Set(["verified", "partial", "weak"]);

function sanitiseType(t) {
  if (!t) return "condominium";
  const map = { "semi-detached": "semi_detached", "link_house": "terrace", "townhouse": "townhouse" };
  const v = map[t] || t;
  return VALID_PROPERTY_TYPES.has(v) ? v : "condominium";
}

async function seedDatabase() {
  // Check if data already exists
  const existingCount = await prisma.comparableTransaction.count();
  if (existingCount > 0) {
    console.log(`  [db] ${existingCount} comparable transactions already in database — skipping seed`);
    return { seeded: false, count: existingCount };
  }

  console.log("  [db] Empty database — seeding comparable transactions...");

  const transactions = generateSeedTransactions();
  const trends       = generateAreaTrends(transactions);

  // ── Seed comparable transactions ──────────────────────────────────────────
  const BATCH = 50;
  let imported = 0;
  let skipped  = 0;

  for (let i = 0; i < transactions.length; i += BATCH) {
    const batch = transactions.slice(i, i + BATCH);
    const records = batch
      .map((t) => {
        const propertyType = sanitiseType(t.propertyType);
        const tenure       = VALID_TENURES.has(t.tenure) ? t.tenure : "freehold";
        const renoProxy    = VALID_RENO.has(t.renovationProxy) ? t.renovationProxy : null;
        const confTag      = VALID_CONF_TAG.has(t.confidenceTag) ? t.confidenceTag : "partial";
        const psf          = Number(t.psf);
        const price        = Number(t.transactedPrice);
        const sqft         = Number(t.builtUpSqft);

        if (!psf || !price || !sqft || isNaN(psf) || isNaN(price) || isNaN(sqft)) {
          skipped++;
          return null;
        }

        return {
          source:           t.source || "NAPIC_SEED",
          sourceRef:        t.sourceRef || null,
          transactionDate:  new Date(t.transactionDate),
          projectName:      t.projectName || null,
          addressLine:      t.addressLine || null,
          postcode:         String(t.postcode),
          city:             t.city || "",
          district:         t.district || null,
          state:            t.state || "",
          propertyType,
          tenure,
          transactedPrice:  price,
          builtUpSqft:      sqft,
          landAreaSqft:     t.landAreaSqft ? Number(t.landAreaSqft) : null,
          psf,
          bedrooms:         t.bedrooms   ? Number(t.bedrooms)   : null,
          bathrooms:        t.bathrooms  ? Number(t.bathrooms)  : null,
          carParks:         t.carParks   ? Number(t.carParks)   : null,
          floorLevel:       t.floorLevel ? Number(t.floorLevel) : null,
          renovationProxy:  renoProxy,
          yearCompleted:    t.yearCompleted ? Number(t.yearCompleted) : null,
          confidenceTag:    confTag,
        };
      })
      .filter(Boolean);

    if (records.length > 0) {
      await prisma.comparableTransaction.createMany({ data: records, skipDuplicates: true });
      imported += records.length;
    }
  }

  // ── Seed area trends ──────────────────────────────────────────────────────
  let trendCount = 0;
  for (const t of trends) {
    const propertyType = sanitiseType(t.propertyType);
    try {
      await prisma.areaTrend.upsert({
        where: {
          areaCode_period_propertyType: {
            areaCode:     t.areaCode,
            period:       new Date(t.period),
            propertyType,
          },
        },
        update: {
          medianPsf:         Number(t.medianPsf),
          transactionVolume: Number(t.transactionVolume) || 0,
          priceIndexFactor:  Number(t.priceIndexFactor) || 1.0,
        },
        create: {
          areaCode:          t.areaCode,
          period:            new Date(t.period),
          propertyType,
          medianPsf:         Number(t.medianPsf),
          transactionVolume: Number(t.transactionVolume) || 0,
          priceIndexFactor:  Number(t.priceIndexFactor) || 1.0,
          source:            "NAPIC_SEED",
        },
      });
      trendCount++;
    } catch (_) { /* skip invalid trend rows */ }
  }

  console.log(`  [db] Seeded ${imported} transactions (${skipped} skipped) + ${trendCount} area trends`);
  return { seeded: true, count: imported };
}

module.exports = { seedDatabase };
