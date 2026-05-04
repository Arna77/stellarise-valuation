/**
 * Valuation API Routes — Prisma / Postgres version
 *
 * POST /api/valuation/estimate        - Submit property for valuation
 * GET  /api/valuation/:id             - Retrieve a saved estimate
 * GET  /api/comparables               - Search comparable transactions
 * POST /api/valuation/review-request  - Request agent or valuer review
 * GET  /api/market-stats              - Malaysia market stats for 2026
 * GET  /api/news                      - Property news (category filter)
 * GET  /api/news/latest               - Latest 5-7 articles for sidebar
 * GET  /api/health                    - Health check for Railway
 */

const express = require("express");
const prisma  = require("../db/prismaClient");
const { estimatePropertyValue } = require("../engine/valuationEngine");
const { getNews, getLatestNews, getCacheInfo } = require("../scrapers/newsScraper");

const router = express.Router();

// ── GET /api/health ──────────────────────────────────────────────────────────
router.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected", ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "error", db: "disconnected", error: err.message });
  }
});

// ── POST /api/valuation/estimate ────────────────────────────────────────────
router.post("/valuation/estimate", async (req, res) => {
  const body = req.body;

  const required = ["propertyType", "address", "postcode", "state", "builtUpSqft", "tenure"];
  const missing  = required.filter((f) => !body[f]);
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
  }

  try {
    // Build subject object for the engine (not saved to DB yet — save after estimate)
    const subject = {
      propertyType:    body.propertyType,
      projectName:     body.projectName   || null,
      addressLine:     body.address,
      postcode:        String(body.postcode),
      city:            body.city          || "",
      state:           body.state,
      tenure:          body.tenure,
      builtUpSqft:     Number(body.builtUpSqft),
      landAreaSqft:    body.landAreaSqft  ? Number(body.landAreaSqft) : null,
      bedrooms:        body.bedrooms      ? Number(body.bedrooms)     : null,
      bathrooms:       body.bathrooms     ? Number(body.bathrooms)    : null,
      carParks:        body.carParks      ? Number(body.carParks)     : null,
      floorLevel:      body.floorLevel    ? Number(body.floorLevel)   : null,
      cornerFlag:      body.cornerFlag    || false,
      endLotFlag:      body.endLotFlag    || false,
      viewQuality:     body.viewQuality   || "normal",
      furnishingLevel: body.furnishingLevel || "unfurnished",
      renovationLevel: body.renovationLevel || "original",
      yearCompleted:   body.yearCompleted ? Number(body.yearCompleted) : null,
      gatedGuarded:    body.gatedGuarded  || false,
    };

    // Query comparable transactions from Postgres
    const compPool = await prisma.comparableTransaction.findMany({
      where: {
        state: subject.state,
        OR: [
          { postcode: subject.postcode },
          { city: subject.city || undefined },
        ],
      },
    });

    // Query area trends
    const subjectTrends = await prisma.areaTrend.findMany({
      where: {
        OR: [
          { areaCode: subject.postcode },
          { areaCode: subject.city || undefined },
        ],
      },
    });

    // Run valuation engine
    const result = estimatePropertyValue(subject, compPool, subjectTrends);

    // Persist subject property + estimate
    const saved = await prisma.subjectProperty.create({
      data: {
        propertyType:    subject.propertyType,
        projectName:     subject.projectName,
        addressLine:     subject.addressLine,
        postcode:        subject.postcode,
        city:            subject.city,
        state:           subject.state,
        tenure:          subject.tenure,
        builtUpSqft:     subject.builtUpSqft,
        landAreaSqft:    subject.landAreaSqft,
        bedrooms:        subject.bedrooms,
        bathrooms:       subject.bathrooms,
        carParks:        subject.carParks,
        floorLevel:      subject.floorLevel,
        cornerFlag:      subject.cornerFlag,
        endLotFlag:      subject.endLotFlag,
        viewQuality:     subject.viewQuality,
        furnishingLevel: subject.furnishingLevel,
        renovationLevel: subject.renovationLevel,
        yearCompleted:   subject.yearCompleted,
        gatedGuarded:    subject.gatedGuarded,
        ...(result.marketValue && {
          estimates: {
            create: {
              estimateLow:       result.marketValue.low,
              estimateMid:       result.marketValue.mid,
              estimateHigh:      result.marketValue.high,
              suggestedListLow:  result.suggestedListing.low,
              suggestedListHigh: result.suggestedListing.high,
              weightedPsf:       result.pricingBasis.weightedPsf,
              confidenceScore:   result.confidence.score,
              confidenceBand:    result.confidence.band,
              confidenceReasons: result.confidence.reasons,
              compCount:         result.pricingBasis.compCount,
              compsUsed:         result.comparables,
              methodVersion:     result.methodVersion,
            },
          },
        }),
      },
      include: { estimates: true },
    });

    const estimateId = saved.estimates?.[0]?.id || null;

    res.json({ estimateId, ...result });
  } catch (err) {
    console.error("[estimate] error:", err.message);
    res.status(500).json({ error: "Valuation failed. Please try again." });
  }
});

// ── GET /api/valuation/:id ──────────────────────────────────────────────────
router.get("/valuation/:id", async (req, res) => {
  try {
    const estimate = await prisma.valuationEstimate.findUnique({
      where: { id: req.params.id },
      include: { subjectProperty: true },
    });
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });
    res.json(estimate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/comparables ────────────────────────────────────────────────────
router.get("/comparables", async (req, res) => {
  try {
    const where = {};
    if (req.query.state)        where.state        = req.query.state;
    if (req.query.postcode)     where.postcode      = req.query.postcode;
    if (req.query.propertyType) where.propertyType  = req.query.propertyType;
    if (req.query.projectName)  where.projectName   = { contains: req.query.projectName, mode: "insensitive" };
    if (req.query.builtUpSqft) {
      const target  = Number(req.query.builtUpSqft);
      const margin  = target * 0.25;
      where.builtUpSqft = { gte: target - margin, lte: target + margin };
    }

    const results = await prisma.comparableTransaction.findMany({
      where,
      orderBy: { transactionDate: "desc" },
      take: 20,
    });

    const total = await prisma.comparableTransaction.count({ where });
    res.json({ total, comparables: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/valuation/review-request ──────────────────────────────────────
router.post("/valuation/review-request", async (req, res) => {
  const { estimateId, reviewType, notes } = req.body;

  if (!estimateId || !reviewType) {
    return res.status(400).json({ error: "estimateId and reviewType required" });
  }
  if (!["agent", "valuer"].includes(reviewType)) {
    return res.status(400).json({ error: "reviewType must be 'agent' or 'valuer'" });
  }

  try {
    const review = await prisma.reviewRequest.create({
      data: { estimateId, reviewType, notes: notes || null },
    });
    res.json(review);
  } catch (err) {
    if (err.code === "P2003") return res.status(404).json({ error: "Estimate not found" });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/market-stats ───────────────────────────────────────────────────
router.get("/market-stats", (req, res) => {
  res.json({
    lastUpdated: "2026-04-01",
    source: "NAPIC / Bank Negara / IMF / iProperty.com.my",
    stats: {
      gdpGrowth:                       "4.5%",
      opr:                             "2.75%",
      residentialTransactionGrowthYoY: "+7.8%",
      klAveragePriceGrowth:            "+4.2%",
      totalListings:                   189157,
      unsoldUnitsGrowth:               "+31.6%",
      foreignStampDuty:                "8%",
      affordableHousingTarget:         "1M homes (2026-2035)",
      ringgitPerUsd:                   "4.09",
      ringgitAppreciation2Y:           "+14%",
      medianHomePriceBelowRM300k:      "52% of volume",
      luxurySegmentGrowth:             "+6.5% (RM1M+)",
    },
    keyMarkets: {
      johor:       { outlook: "Fastest growth — RTS Link completion + JS-SEZ",   medianPsfGrowth: "+5.2%" },
      kualaLumpur: { outlook: "Selective premium growth, transit-oriented",       medianPsfGrowth: "+4.2%" },
      selangor:    { outlook: "Stable, strong volume in mid-range",               medianPsfGrowth: "+3.1%" },
      penang:      { outlook: "Steady demand, limited land supply",               medianPsfGrowth: "+3.8%" },
    },
  });
});

// ── GET /api/news ────────────────────────────────────────────────────────────
router.get("/news", (req, res) => {
  const { category, limit } = req.query;
  const articles = getNews({ category, limit: Number(limit) || 20 });
  res.json({ articles, meta: getCacheInfo() });
});

// ── GET /api/news/latest ─────────────────────────────────────────────────────
router.get("/news/latest", (req, res) => {
  const limit = Number(req.query.limit) || 5;
  res.json({ articles: getLatestNews(limit), meta: getCacheInfo() });
});

module.exports = { router };
