/**
 * Stellarise Valuation API Server
 *
 * Tries to connect to Postgres on boot.
 * If connected  → uses Prisma routes (full persistence).
 * If unavailable → falls back to memory routes (local dev without Docker).
 */

require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const path       = require("path");
const cron       = require("node-cron");
const fs         = require("fs");

const { refreshNews } = require("./scrapers/newsScraper");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security headers ─────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'"],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        imgSrc:     ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameSrc:   ["'none'"],
        objectSrc:  ["'none'"],
      },
    },
    hsts:       { maxAge: 31536000, includeSubDomains: true, preload: true },
    frameguard: { action: "deny" },
    xPoweredBy: false,
  })
);

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
      // Allow requests with no origin (mobile apps, Postman, server-to-server, health checks)
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

// ── Global rate limiter — 200 req / 15 min per IP ────────────────────────────
app.use(
  rateLimit({
    windowMs:       15 * 60 * 1000,
    max:            200,
    standardHeaders: true,
    legacyHeaders:  false,
    message:        { error: "Too many requests. Please try again later." },
  })
);

// ── Stricter limiter for valuation endpoint — 30 req / 15 min per IP ─────────
app.use(
  "/api/valuation/estimate",
  rateLimit({
    windowMs:       15 * 60 * 1000,
    max:            30,
    standardHeaders: true,
    legacyHeaders:  false,
    message:        { error: "Valuation rate limit reached. Please try again in 15 minutes." },
  })
);

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
