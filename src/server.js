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

const { refreshNews }  = require("./scrapers/newsScraper");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
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
