/**
 * Source Sync Worker
 *
 * Periodically fetches new transaction data from NAPIC and other sources.
 * In production, use BullMQ queues for job processing. This MVP uses node-cron.
 *
 * Architecture (ready for NestJS + BullMQ migration):
 *   - Each source has an adapter module
 *   - Worker processes source-sync jobs on a schedule
 *   - NormalizedItem records are created and emitted as events
 *   - Scheduler triggers re-sync every 6 hours
 */

const cron = require("node-cron");
const { fetchNapicPublications, generateSeedTransactions, generateAreaTrends } = require("../adapters/napicAdapter");
const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "..", "prisma", "seed-transactions.json");

// ── Source Registry ─────────────────────────────────────────────────────────

const SOURCES = [
  {
    name: "napic.jpph",
    description: "NAPIC / JPPH Official Transaction Data",
    url: "https://napic.jpph.gov.my/en/latest-publication",
    schedule: "0 */6 * * *", // every 6 hours
    adapter: "napicAdapter",
  },
  {
    name: "iproperty.listings",
    description: "iProperty.com.my Listing Data",
    url: "https://www.iproperty.com.my",
    schedule: "0 */12 * * *", // every 12 hours
    adapter: "ipropertyAdapter", // future
  },
  {
    name: "edgeprop.transactions",
    description: "The Edge Property Transaction Records",
    url: "https://www.theedgeproperty.com.my",
    schedule: "0 0 * * 1", // weekly on Monday
    adapter: "edgePropAdapter", // future
  },
];

// ── Job Processor ───────────────────────────────────────────────────────────

async function processSourceSync(sourceName) {
  const run = {
    id: `run_${Date.now()}`,
    sourceName,
    status: "running",
    itemsFound: 0,
    itemsImported: 0,
    errors: [],
    startedAt: new Date().toISOString(),
  };

  console.log(`[worker] Starting source-sync for ${sourceName}...`);

  try {
    switch (sourceName) {
      case "napic.jpph": {
        // Check for new publications
        const pubs = await fetchNapicPublications();
        run.itemsFound = pubs.length;

        // Regenerate seed data (in production: parse actual NAPIC PDFs/data)
        const transactions = generateSeedTransactions();
        const trends = generateAreaTrends(transactions);

        fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
        fs.writeFileSync(DATA_PATH, JSON.stringify({ transactions, trends, generatedAt: new Date().toISOString() }, null, 2));

        run.itemsImported = transactions.length;
        run.status = "completed";
        console.log(`[worker] NAPIC sync complete: ${transactions.length} transactions refreshed`);
        break;
      }

      default:
        run.status = "skipped";
        run.errors.push(`No adapter implemented for ${sourceName}`);
        console.log(`[worker] Skipping ${sourceName} — adapter not yet implemented`);
    }
  } catch (err) {
    run.status = "failed";
    run.errors.push(err.message);
    console.error(`[worker] Error in ${sourceName}:`, err.message);
  }

  run.completedAt = new Date().toISOString();
  return run;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

function startScheduler() {
  console.log("[worker] Starting sync scheduler...\n");
  console.log("[worker] Registered sources:");
  SOURCES.forEach((s) => console.log(`  - ${s.name} (${s.schedule})`));
  console.log();

  // Schedule each source
  for (const source of SOURCES) {
    if (source.adapter === "napicAdapter") {
      cron.schedule(source.schedule, () => processSourceSync(source.name));
    }
  }

  // Initial sync on startup
  processSourceSync("napic.jpph");
}

// ── CLI entry point ─────────────────────────────────────────────────────────

if (require.main === module) {
  startScheduler();
}

module.exports = { processSourceSync, startScheduler, SOURCES };
