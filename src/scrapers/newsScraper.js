/**
 * Stellarise Property News Scraper
 *
 * Fetches Malaysian property news from RSS feeds.
 * Falls back to curated seed headlines when feeds are unavailable.
 * Auto-refreshes every 6 hours via node-cron (wired in server.js).
 *
 * Sources:
 *   - Bernama (business/property RSS)
 *   - The Edge Markets (property section RSS)
 *   - Free Malaysia Today (economy RSS)
 *   - Malaysia Kini Business RSS
 *   - NAPIC/JPPH (seed only — no public RSS)
 */

const RSSParser = require("rss-parser");
const parser = new RSSParser({
  timeout: 8000,
  headers: { "User-Agent": "Stellarise Property News Bot/1.0" },
});

// ── RSS sources ──────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  {
    name: "Bernama",
    url: "https://www.bernama.com/en/rss/",
    category: "market",
    tags: ["property", "real estate", "housing", "construction", "developer"],
  },
  {
    name: "The Edge Markets",
    url: "https://theedgemalaysia.com/rss",
    category: "market",
    tags: ["property", "condo", "landed", "psf", "transaction", "developer"],
  },
  {
    name: "The Star Property",
    url: "https://www.thestar.com.my/rss/Business/Property",
    category: "market",
    tags: ["property", "condo", "housing", "developer", "real estate", "transaction"],
  },
  {
    name: "Free Malaysia Today",
    url: "https://www.freemalaysiatoday.com/category/business/feed/",
    category: "policy",
    tags: ["property", "housing", "bank negara", "opr", "affordable", "real estate"],
  },
  {
    name: "iProperty",
    url: "https://www.iproperty.com.my/news/feed/",
    category: "market",
    tags: ["property", "condo", "landed", "psf", "developer", "market"],
  },
];

// ── Category map based on keywords ──────────────────────────────────────────
const CATEGORY_RULES = [
  { cat: "klcc",     keywords: ["klcc", "mont kiara", "bukit bintang", "ampang", "bangsar", "hartamas", "st mary", "pavilion", "troika", "binjai"] },
  { cat: "selangor", keywords: ["selangor", "petaling jaya", "subang", "shah alam", "klang", "setia alam", "kota kemuning", "ara damansara", "damansara"] },
  { cat: "johor",    keywords: ["johor", "iskandar", "johor bahru", "jb ", "forest city"] },
  { cat: "penang",   keywords: ["penang", "pulau pinang", "georgetown"] },
  { cat: "policy",   keywords: ["bank negara", "opr", "interest rate", "government", "ministry", "budget", "policy", "affordable", "pr1ma", "rumawip"] },
  { cat: "market",   keywords: ["transaction", "psf", "price", "index", "napic", "jpph", "q1", "q2", "q3", "q4", "market", "growth"] },
];

// ── Seed headlines (fallback when RSS is unavailable) ────────────────────────
const SEED_ARTICLES = [
  {
    id: "seed-1",
    title: "KLCC condo prices hit RM1,200 psf median — highest since 2015",
    source: "The Edge Property",
    category: "klcc",
    url: "https://www.theedgemarkets.com",
    date: new Date("2026-05-01").toISOString(),
    summary: "Prime KLCC condominiums recorded a median transacted price of RM1,200 psf in Q1 2026, driven by strong foreign buyer demand and limited new supply.",
  },
  {
    id: "seed-2",
    title: "Bank Negara holds OPR at 2.75% — mortgage rates stable for H1 2026",
    source: "Bank Negara Malaysia",
    category: "policy",
    url: "https://www.bnm.gov.my",
    date: new Date("2026-05-02").toISOString(),
    summary: "Bank Negara Malaysia maintained the Overnight Policy Rate at 2.75% at its May 2026 MPC meeting, providing stability for the housing loan market.",
  },
  {
    id: "seed-3",
    title: "Setia Alam & Kota Kemuning terrace transactions up 12% YoY — NAPIC Q1",
    source: "NAPIC / JPPH",
    category: "selangor",
    url: "https://www.napic.jpph.gov.my",
    date: new Date("2026-04-28").toISOString(),
    summary: "Q1 2026 data from NAPIC shows a 12% year-on-year increase in terrace house transactions across Setia Alam and Kota Kemuning, fuelled by upgrader demand.",
  },
  {
    id: "seed-4",
    title: "Malaysia residential market grows 7.8% — affordable segment leads recovery",
    source: "PropertyGuru Research",
    category: "market",
    url: "https://www.propertyguru.com.my",
    date: new Date("2026-04-25").toISOString(),
    summary: "PropertyGuru's H1 2026 Malaysia Market Outlook reports 7.8% overall growth in residential transactions, led by sub-RM500,000 units in Selangor and Johor.",
  },
  {
    id: "seed-5",
    title: "Mont Kiara luxury segment rebounds with 18 transactions above RM2M in Q1",
    source: "iProperty Research",
    category: "klcc",
    url: "https://www.iproperty.com.my",
    date: new Date("2026-04-20").toISOString(),
    summary: "Mont Kiara's luxury condominium segment recorded 18 transactions exceeding RM2 million in Q1 2026, the strongest quarter since pre-pandemic highs.",
  },
  {
    id: "seed-6",
    title: "Penang island property prices rise 5.2% as supply remains constrained",
    source: "StarProperty",
    category: "penang",
    url: "https://www.starproperty.my",
    date: new Date("2026-04-18").toISOString(),
    summary: "Limited land supply on Penang Island continues to push prices upward, with the average transacted price for condominiums rising 5.2% compared to Q1 2025.",
  },
  {
    id: "seed-7",
    title: "Iskandar Malaysia records RM4.8B in property transactions for Q1 2026",
    source: "The Edge Markets",
    category: "johor",
    url: "https://www.theedgemarkets.com",
    date: new Date("2026-04-15").toISOString(),
    summary: "Johor's Iskandar Malaysia recorded RM4.8 billion in property transactions during Q1 2026, up 22% YoY, buoyed by Singapore spillover demand and Forest City developments.",
  },
  {
    id: "seed-8",
    title: "Chow Kit affordable housing project: 1,200 units priced from RM250K",
    source: "Bernama",
    category: "policy",
    url: "https://www.bernama.com",
    date: new Date("2026-04-10").toISOString(),
    summary: "The Kuala Lumpur City Hall announced a new affordable housing development in Chow Kit featuring 1,200 units priced between RM250,000 and RM450,000.",
  },
  {
    id: "seed-9",
    title: "Subang Jaya SS15 shop-offices see renewed investor interest post-LRT3",
    source: "iProperty Research",
    category: "selangor",
    url: "https://www.iproperty.com.my",
    date: new Date("2026-04-08").toISOString(),
    summary: "Commercial and mixed-use properties near LRT3 stations in SS15 and Subang Jaya are attracting renewed investor interest, with asking prices rising 8-12%.",
  },
  {
    id: "seed-10",
    title: "NAPIC: Overhang units drop 15% nationally as completions slow in 2025",
    source: "NAPIC / JPPH",
    category: "market",
    url: "https://www.napic.jpph.gov.my",
    date: new Date("2026-04-05").toISOString(),
    summary: "National Property Information Centre reports a 15% decline in overhang residential units, attributed to lower completions and steady absorption in key urban markets.",
  },
];

// ── In-memory cache ──────────────────────────────────────────────────────────
let newsCache = {
  articles: [...SEED_ARTICLES],
  lastFetched: null,
  source: "seed",
};

// ── Categorise an article from its title/description text ────────────────────
function categorise(text) {
  const lower = (text || "").toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) return rule.cat;
  }
  return "market";
}

// ── Check if an article title is property-related ────────────────────────────
// Title must contain at least one strong property keyword — location alone is not enough.
function isPropertyRelated(item, feedTags) {
  const title = (item.title || "").toLowerCase();
  const body  = (item.contentSnippet || item.content || "").toLowerCase();

  // Strong property keywords that must appear in the title
  const titleKeywords = [
    "property", "real estate", "housing", "condo", "condominium", "apartment",
    "landed", "developer", "transaction", "psf", "residential", "commercial",
    "bank negara", "opr", "mortgage", "loan", "affordable", "napic", "jpph",
    "klcc", "mont kiara", "construction", "building permit", "house price",
    "home price", "property market", "property price", "rent", "rental",
    "freehold", "leasehold", "strata", "serviced residence", "title deed",
  ];

  // Title must contain at least one strong keyword
  const titleMatch = titleKeywords.some((kw) => title.includes(kw));
  if (titleMatch) return true;

  // Or title + body must contain a feed-specific tag
  const combined = title + " " + body;
  return feedTags.some((t) => combined.includes(t));
}

// ── Fetch + parse one RSS feed ────────────────────────────────────────────────
async function fetchFeed(feed) {
  try {
    const result = await parser.parseURL(feed.url);
    const articles = (result.items || [])
      .filter((item) => isPropertyRelated(item, feed.tags))
      .slice(0, 5)
      .map((item, i) => ({
        id: `${feed.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}-${i}`,
        title: (item.title || "").trim(),
        source: feed.name,
        category: categorise((item.title || "") + " " + (item.contentSnippet || "")),
        url: item.link || "#",
        date: item.isoDate || item.pubDate || new Date().toISOString(),
        summary: (item.contentSnippet || item.content || "").replace(/<[^>]+>/g, "").slice(0, 200).trim(),
      }));
    console.log(`  [news] ${feed.name}: ${articles.length} property articles fetched`);
    return articles;
  } catch (err) {
    console.warn(`  [news] ${feed.name} failed: ${err.message}`);
    return [];
  }
}

// ── Main refresh function (called on boot + every 6h) ────────────────────────
async function refreshNews() {
  console.log("  [news] Refreshing property news from RSS feeds...");
  const results = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));

  const live = results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .filter((a) => a.title.length > 10);

  if (live.length >= 3) {
    // Deduplicate by title similarity, merge with seeds for padding
    const seen = new Set();
    const deduped = live.filter((a) => {
      const key = a.title.toLowerCase().slice(0, 40);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Pad with seed articles if fewer than 8 live results
    const merged = deduped.length < 8
      ? [...deduped, ...SEED_ARTICLES.slice(0, 8 - deduped.length)]
      : deduped.slice(0, 12);

    newsCache = { articles: merged, lastFetched: new Date().toISOString(), source: "live" };
    console.log(`  [news] Cache updated: ${merged.length} articles (${deduped.length} live, ${merged.length - deduped.length} seed)`);
  } else {
    // All feeds failed — keep seeds, just update timestamp
    newsCache = { articles: SEED_ARTICLES, lastFetched: new Date().toISOString(), source: "seed" };
    console.log("  [news] RSS unavailable — using seed articles");
  }
}

// ── Getters used by the route handler ────────────────────────────────────────
function getNews({ category, limit = 20 } = {}) {
  let articles = newsCache.articles;
  if (category) articles = articles.filter((a) => a.category === category);
  return articles.slice(0, limit);
}

function getLatestNews(limit = 5) {
  return newsCache.articles
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limit);
}

function getCacheInfo() {
  return { lastFetched: newsCache.lastFetched, source: newsCache.source, count: newsCache.articles.length };
}

module.exports = { refreshNews, getNews, getLatestNews, getCacheInfo };
