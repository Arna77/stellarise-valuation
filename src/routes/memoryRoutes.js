/**
 * Memory-mode routes — used as fallback when Postgres is unavailable.
 * Identical logic to the original in-memory implementation.
 */

const express = require("express");
const { estimatePropertyValue } = require("../engine/valuationEngine");
const { getNews, getLatestNews, getCacheInfo } = require("../scrapers/newsScraper");

const router = express.Router();

let comparableTransactions = [];
let areaTrends = [];
let valuationEstimates = [];

function initStores(data) {
  if (data.transactions) comparableTransactions = data.transactions;
  if (data.trends)       areaTrends = data.trends;
}

router.get("/health", (_req, res) => {
  res.json({ status: "ok", db: "memory", ts: new Date().toISOString() });
});

router.post("/valuation/estimate", (req, res) => {
  const body = req.body;
  const required = ["propertyType", "address", "postcode", "state", "builtUpSqft", "tenure"];
  const missing  = required.filter((f) => !body[f]);
  if (missing.length > 0) return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });

  const subject = {
    id:              generateId(),
    propertyType:    body.propertyType,
    projectName:     body.projectName     || null,
    addressLine:     body.address,
    postcode:        String(body.postcode),
    city:            body.city            || "",
    state:           body.state,
    tenure:          body.tenure,
    builtUpSqft:     Number(body.builtUpSqft),
    landAreaSqft:    body.landAreaSqft    ? Number(body.landAreaSqft) : null,
    bedrooms:        body.bedrooms        || null,
    bathrooms:       body.bathrooms       || null,
    carParks:        body.carParks        || null,
    floorLevel:      body.floorLevel      || null,
    cornerFlag:      body.cornerFlag      || false,
    endLotFlag:      body.endLotFlag      || false,
    viewQuality:     body.viewQuality     || "normal",
    furnishingLevel: body.furnishingLevel || "unfurnished",
    renovationLevel: body.renovationLevel || "original",
    yearCompleted:   body.yearCompleted   || null,
    gatedGuarded:    body.gatedGuarded    || false,
  };

  const compPool = comparableTransactions.filter(
    (c) => c.state === subject.state && (c.postcode === subject.postcode || c.city === subject.city)
  );
  const subjectTrends = areaTrends.filter(
    (t) => t.areaCode === subject.postcode || t.areaCode === subject.city
  );

  const result   = estimatePropertyValue(subject, compPool, subjectTrends);
  const estimate = { id: `val_${generateId()}`, subjectPropertyId: subject.id, ...result, createdAt: new Date().toISOString() };
  valuationEstimates.push(estimate);

  res.json({ estimateId: estimate.id, ...result });
});

router.get("/valuation/:id", (req, res) => {
  const estimate = valuationEstimates.find((e) => e.id === req.params.id);
  if (!estimate) return res.status(404).json({ error: "Estimate not found" });
  res.json(estimate);
});

router.get("/comparables", (req, res) => {
  let results = [...comparableTransactions];
  if (req.query.projectName)  results = results.filter((c) => c.projectName?.toLowerCase().includes(req.query.projectName.toLowerCase()));
  if (req.query.propertyType) results = results.filter((c) => c.propertyType === req.query.propertyType);
  if (req.query.state)        results = results.filter((c) => c.state === req.query.state);
  if (req.query.postcode)     results = results.filter((c) => c.postcode === req.query.postcode);
  if (req.query.builtUpSqft) {
    const target = Number(req.query.builtUpSqft);
    results = results.filter((c) => Math.abs(Number(c.builtUpSqft) - target) / target <= 0.25);
  }
  results.sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate));
  res.json({ total: results.length, comparables: results.slice(0, 20) });
});

router.post("/valuation/review-request", (req, res) => {
  const { estimateId, reviewType } = req.body;
  if (!estimateId || !reviewType) return res.status(400).json({ error: "estimateId and reviewType required" });
  if (!["agent", "valuer"].includes(reviewType)) return res.status(400).json({ error: "reviewType must be 'agent' or 'valuer'" });
  const estimate = valuationEstimates.find((e) => e.id === estimateId);
  if (!estimate) return res.status(404).json({ error: "Estimate not found" });
  res.json({ id: `rev_${generateId()}`, estimateId, reviewType, status: "pending", createdAt: new Date().toISOString() });
});

router.get("/market-stats", (_req, res) => {
  res.json({
    lastUpdated: "2026-04-01",
    source: "NAPIC / Bank Negara / IMF / iProperty.com.my",
    stats: {
      gdpGrowth: "4.5%", opr: "2.75%", residentialTransactionGrowthYoY: "+7.8%",
      klAveragePriceGrowth: "+4.2%", totalListings: 189157, unsoldUnitsGrowth: "+31.6%",
      foreignStampDuty: "8%", affordableHousingTarget: "1M homes (2026-2035)",
      ringgitPerUsd: "4.09", ringgitAppreciation2Y: "+14%",
      medianHomePriceBelowRM300k: "52% of volume", luxurySegmentGrowth: "+6.5% (RM1M+)",
    },
    keyMarkets: {
      johor:       { outlook: "Fastest growth — RTS Link completion + JS-SEZ",   medianPsfGrowth: "+5.2%" },
      kualaLumpur: { outlook: "Selective premium growth, transit-oriented",       medianPsfGrowth: "+4.2%" },
      selangor:    { outlook: "Stable, strong volume in mid-range",               medianPsfGrowth: "+3.1%" },
      penang:      { outlook: "Steady demand, limited land supply",               medianPsfGrowth: "+3.8%" },
    },
  });
});

router.get("/news", (req, res) => {
  const { category, limit } = req.query;
  res.json({ articles: getNews({ category, limit: Number(limit) || 20 }), meta: getCacheInfo() });
});

router.get("/news/latest", (req, res) => {
  res.json({ articles: getLatestNews(Number(req.query.limit) || 5), meta: getCacheInfo() });
});

function generateId() {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

module.exports = { router, initStores };
