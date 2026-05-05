/**
 * Stellarise Valuation API Server
 *
 * Malaysia Property Valuation Tool — Express MVP
 * Ready for migration to NestJS + BullMQ.
 *
 * Endpoints:
 *   POST /api/valuation/estimate
 *   GET  /api/valuation/:id
 *   GET  /api/comparables
 *   POST /api/valuation/review-request
 *   GET  /api/market-stats
 *   GET  /                              (frontend)
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const { router, initStores } = require("./routes/valuationRoutes");
const { generateSeedTransactions, generateAreaTrends } = require("./adapters/napicAdapter");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security headers (helmet) ────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    frameguard: { action: "deny" },
    xPoweredBy: false,
  })
);

// ── CORS — restrict to Stellarise origins ────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://stellarise.io",
  "https://www.stellarise.io",
  "https://valuation.stellarise.io",
  // Allow localhost for local dev
  "http://localhost:3001",
  "http://localhost:8888",
  "http://localhost:8899",
  "http://127.0.0.1:8888",
  "http://127.0.0.1:8899",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, server-to-server)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    maxAge: 86400, // Cache preflight for 24 h
  })
);

// ── Body size limit ──────────────────────────────────────────────────────────
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Global rate limiter — 200 req / 15 min per IP ────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
app.use(globalLimiter);

// ── Stricter limiter for valuation endpoint — 30 req / 15 min per IP ─────────
const valuationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Valuation rate limit reached. Please try again in 15 minutes." },
});
app.use("/api/valuation/estimate", valuationLimiter);

// ── Load or generate seed data ──────────────────────────────────────────────
const seedPath = path.join(__dirname, "..", "prisma", "seed-transactions.json");

let seedData;
if (fs.existsSync(seedPath)) {
  seedData = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
  console.log(`  Loaded ${seedData.transactions.length} transactions from cache`);
} else {
  console.log("  No cached data. Generating seed transactions...");
  const transactions = generateSeedTransactions();
  const trends = generateAreaTrends(transactions);
  seedData = { transactions, trends, generatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  fs.writeFileSync(seedPath, JSON.stringify(seedData, null, 2));
  console.log(`  Generated ${transactions.length} transactions`);
}

initStores(seedData);

// ── Routes ──────────────────────────────────────────────────────────────────
app.use("/api", router);

// ── Serve frontend ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Stellarise Property Valuation Tool`);
  console.log(`  ──────────────────────────────────`);
  console.log(`  Local:      http://localhost:${PORT}`);
  console.log(`  Estimate:   POST http://localhost:${PORT}/api/valuation/estimate`);
  console.log(`  Comparables: GET http://localhost:${PORT}/api/comparables`);
  console.log(`  Stats:      GET  http://localhost:${PORT}/api/market-stats\n`);
});
