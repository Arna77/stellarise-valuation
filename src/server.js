/**
 * Stellarise Valuation API Server
 *
 * Tries to connect to Postgres on boot.
 * If connected  → uses Prisma routes (full persistence).
 * If unavailable → falls back to memory routes (local dev without Docker).
 */

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const cron    = require("node-cron");
const fs      = require("fs");

const { refreshNews } = require("./scrapers/newsScraper");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security headers (no external package needed) ────────────────────────────
app.use((req, res, next) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  res.setHeader("Content-Security-Policy", "default-src 'self'; frame-src 'none'; object-src 'none'");
  next();
});

// ── In-memory rate limiter (no external package needed) ──────────────────────
// Stores: { ip → [timestamp, ...] }
const _rlStore = new Map();
function makeRateLimiter(windowMs, max, message) {
  return (req, res, next) => {
    const ip  = req.ip || (req.connection && req.connection.remoteAddress) || "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;
    const hits = (_rlStore.get(ip) || []).filter(t => t > cutoff);
    if (hits.length >= max) {
      return res.status(429).json({ error: message });
    }
    hits.push(now);
    _rlStore.set(ip, hits);
    // Prune old entries every ~500 requests to avoid unbounded memory growth
    if (_rlStore.size > 500) {
      for (const [k, v] of _rlStore) {
        if (v.every(t => t <= cutoff)) _rlStore.delete(k);
      }
    }
    next();
  };
}

// Global: 200 req / 15 min per IP
app.use(makeRateLimiter(15 * 60 * 1000, 200, "Too many requests. Please try again later."));

// Estimate endpoint: 30 req / 15 min per IP
app.use("/api/valuation/estimate", makeRateLimiter(15 * 60 * 1000, 30, "Valuation rate limit reached. Please try again in 15 minutes."));

// ── CORS — restrict to Stellarise origins ────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://stellarise.io",
  "https://www.stellarise.io",
  "https://valuation.stellarise.io",
  "http://localhost:3001",
  "http://localhost:8888",
  "http://localhost:8899",
  "http://127.0.0.1:8888",
  "http://127.0.0.1:8899",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow no-origin requests (server-to-server, health checks, Postman)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods:        ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials:    false,
    maxAge:         86400,
  })
);

// ── Body size limit ──────────────────────────────────────────────────────────
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "index.html"))
);

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  let useDatabase = false;

  if (process.env.DATABASE_URL) {
    const prisma = require("./db/prismaClient");
    try {
      await prisma.$connect();
      console.log("  [db] Connected to Postgres");
      useDatabase = true;
    } catch {
      console.warn("  [db] Postgres unavailable — falling back to memory mode");
    }
  } else {
    console.warn("  [db] No DATABASE_URL — running in memory mode");
  }

  if (useDatabase) {
    // ── Postgres mode ─────────────────────────────────────────────────────
    const { router }       = require("./routes/valuationRoutes");
    const { seedDatabase } = require("./db/seedDatabase");
    app.use("/api", router);
    await seedDatabase();
    console.log("  [db] Running in Postgres mode");
  } else {
    // ── Memory fallback ───────────────────────────────────────────────────
    const { router, initStores } = require("./routes/memoryRoutes");
    const { generateSeedTransactions, generateAreaTrends } = require("./adapters/napicAdapter");
    app.use("/api", router);

    const seedPath = path.join(__dirname, "..", "prisma", "seed-transactions.json");
    let seedData;
    if (fs.existsSync(seedPath)) {
      seedData = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
      console.log(`  [mem] Loaded ${seedData.transactions.length} transactions from cache`);
    } else {
      console.log("  [mem] Generating seed transactions...");
      const transactions = generateSeedTransactions();
      const trends       = generateAreaTrends(transactions);
      seedData = { transactions, trends, generatedAt: new Date().toISOString() };
      fs.mkdirSync(path.dirname(seedPath), { recursive: true });
      fs.writeFileSync(seedPath, JSON.stringify(seedData, null, 2));
      console.log(`  [mem] Generated ${transactions.length} transactions`);
    }
    initStores(seedData);
  }

  app.listen(PORT, () => {
    const mode = useDatabase ? "Postgres" : "Memory";
    console.log(`\n  Stellarise Property Valuation Tool (${mode})`);
    console.log(`  ──────────────────────────────────────────`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Health:  GET  http://localhost:${PORT}/api/health`);
    console.log(`  News:    GET  http://localhost:${PORT}/api/news/latest\n`);
  });

  // Fetch news on boot, then every 6 hours
  refreshNews();
  cron.schedule("0 */6 * * *", () => {
    console.log("  [cron] Refreshing property news...");
    refreshNews();
  });
}

boot().catch((err) => {
  console.error("  [boot] Fatal:", err.message);
  process.exit(1);
});
