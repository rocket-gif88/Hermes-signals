require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const Parser = require("rss-parser");

const app = express();
const rssParser = new Parser();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  NEWS_API_KEY: process.env.NEWS_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CONFIDENCE_THRESHOLD: parseInt(process.env.CONFIDENCE_THRESHOLD || "70"),
  SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL_MINUTES || "15"),
};

// ─── STATE ──────────────────────────────────────────────────────────────────
const seenHeadlines = new Set(); // deduplication cache
let signalLog = [];              // in-memory log for /status endpoint
let lastScanTime = null;
let totalSignalsFired = 0;

// ─── RSS SOURCES ─────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: "Reuters Business", url: "https://feeds.reuters.com/reuters/businessNews" },
  { name: "Reuters Markets",  url: "https://feeds.reuters.com/reuters/financials" },
  { name: "FT Markets",       url: "https://www.ft.com/markets?format=rss" },
  { name: "CNBC Finance",     url: "https://www.cnbc.com/id/10000664/device/rss/rss.html" },
  { name: "MarketWatch",      url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
];

// ─── NEWS FETCHERS ────────────────────────────────────────────────────────────

async function fetchFinnhubNews() {
  try {
    const categories = ["general", "forex", "crypto", "merger"];
    const allItems = [];
    for (const cat of categories) {
      const res = await axios.get("https://finnhub.io/api/v1/news", {
        params: { category: cat, token: CONFIG.FINNHUB_API_KEY },
        timeout: 8000,
      });
      if (Array.isArray(res.data)) {
        allItems.push(
          ...res.data.slice(0, 20).map((item) => ({
            title: item.headline,
            summary: item.summary || "",
            source: `Finnhub/${item.source || cat}`,
            url: item.url,
            publishedAt: new Date(item.datetime * 1000).toISOString(),
          }))
        );
      }
    }
    return allItems;
  } catch (e) {
    console.error("[Finnhub] Fetch error:", e.message);
    return [];
  }
}

async function fetchNewsAPI() {
  try {
    const res = await axios.get("https://newsapi.org/v2/top-headlines", {
      params: {
        category: "business",
        language: "en",
        pageSize: 50,
        apiKey: CONFIG.NEWS_API_KEY,
      },
      timeout: 8000,
    });
    return (res.data.articles || []).map((a) => ({
      title: a.title,
      summary: a.description || "",
      source: `NewsAPI/${a.source?.name || "unknown"}`,
      url: a.url,
      publishedAt: a.publishedAt,
    }));
  } catch (e) {
    console.error("[NewsAPI] Fetch error:", e.message);
    return [];
  }
}

async function fetchRSSFeeds() {
  const items = [];
  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      for (const item of (parsed.items || []).slice(0, 15)) {
        items.push({
          title: item.title || "",
          summary: item.contentSnippet || item.content || "",
          source: feed.name,
          url: item.link,
          publishedAt: item.pubDate || new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error(`[RSS/${feed.name}] Fetch error:`, e.message);
    }
  }
  return items;
}

// ─── KEYWORD FILTER ──────────────────────────────────────────────────────────

const KEYWORDS = {
  macro: [
    "fed", "federal reserve", "fomc", "rate hike", "rate cut", "interest rate",
    "inflation", "cpi", "pce", "nfp", "jobs report", "unemployment", "gdp",
    "recession", "jerome powell", "treasury", "yield", "10-year", "bond",
    "ecb", "bank of england", "boe", "central bank", "monetary policy",
    "geopolit", "sanctions", "tariff", "trade war", "opec", "oil supply",
    "war", "conflict", "crisis", "election", "default", "debt ceiling",
  ],
  commodities: [
    "gold", "xau", "silver", "xag", "crude oil", "brent", "wti",
    "copper", "platinum", "palladium", "natural gas", "commodity",
  ],
  equities: [
    "earnings", "revenue", "profit", "loss", "guidance", "beat", "miss",
    "buyback", "dividend", "merger", "acquisition", "ipo", "listing",
    "nasdaq", "s&p", "dow jones", "russell", "index", "stock market",
    "nvidia", "apple", "microsoft", "tesla", "amazon", "meta", "google",
    "alphabet", "jpmorgan", "goldman", "morgan stanley", "blackrock",
  ],
  forex: [
    "dollar", "usd", "euro", "eur", "yen", "jpy", "pound", "gbp",
    "forex", "currency", "exchange rate", "dxy", "dollar index",
  ],
};

const ALL_KEYWORDS = Object.values(KEYWORDS).flat();

function keywordFilter(articles) {
  return articles.filter((article) => {
    const text = `${article.title} ${article.summary}`.toLowerCase();
    return ALL_KEYWORDS.some((kw) => text.includes(kw));
  });
}

// ─── DEDUPLICATION ────────────────────────────────────────────────────────────

function deduplicateHeadlines(articles) {
  const fresh = [];
  for (const article of articles) {
    const key = article.title?.toLowerCase().trim().slice(0, 80);
    if (key && !seenHeadlines.has(key)) {
      seenHeadlines.add(key);
      fresh.push(article);
    }
  }
  // Keep cache bounded
  if (seenHeadlines.size > 5000) {
    const arr = [...seenHeadlines];
    arr.splice(0, 1000).forEach((k) => seenHeadlines.delete(k));
  }
  return fresh;
}

// ─── CLAUDE SENTIMENT ANALYSIS ───────────────────────────────────────────────

async function analyzeWithClaude(headlines) {
  const headlineList = headlines
    .map((h, i) => `${i + 1}. [${h.source}] ${h.title}${h.summary ? " — " + h.summary.slice(0, 120) : ""}`)
    .join("\n");

  const prompt = `You are a professional financial analyst. Analyze the following news headlines and identify ONLY high-confidence trade setups.

HEADLINES:
${headlineList}

For each headline that represents a meaningful market-moving event, return a JSON array. Only include items where confidence >= 70.

Return ONLY a valid JSON array, no markdown, no explanation. Format:
[
  {
    "headline_index": 1,
    "asset": "XAU/USD",
    "asset_type": "commodity",
    "direction": "bullish",
    "confidence": 82,
    "catalyst": "one sentence explanation",
    "context": "suggested price action context or zone to watch",
    "urgency": "breaking" 
  }
]

urgency values: "breaking" (happened now), "scheduled" (known event upcoming), "developing" (evolving story)
asset_type values: "commodity", "equity", "forex", "index", "crypto"
direction values: "bullish", "bearish", "neutral" (omit neutral — only include if directional)

If NO headlines meet the 70+ confidence threshold, return an empty array: []`;

  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": CONFIG.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 30000,
      }
    );

    const raw = res.data.content?.[0]?.text || "[]";
    const clean = raw.replace(/```json|```/g, "").trim();
    const signals = JSON.parse(clean);

    // Attach original headline data
    return signals.map((s) => ({
      ...s,
      source: headlines[s.headline_index - 1]?.source || "Unknown",
      url: headlines[s.headline_index - 1]?.url || "",
      title: headlines[s.headline_index - 1]?.title || "",
    }));
  } catch (e) {
    console.error("[Claude] Analysis error:", e.message);
    return [];
  }
}

// ─── TELEGRAM DELIVERY ────────────────────────────────────────────────────────

function directionEmoji(direction) {
  return direction === "bullish" ? "📈" : direction === "bearish" ? "📉" : "➡️";
}

function urgencyEmoji(urgency) {
  return urgency === "breaking" ? "🔴" : urgency === "scheduled" ? "📅" : "🔵";
}

async function sendTelegramSignal(signal) {
  const emoji = directionEmoji(signal.direction);
  const urgEmoji = urgencyEmoji(signal.urgency);
  const bar = "━━━━━━━━━━━━━━━━━━";

  const msg =
    `🗞 <b>HERMES SIGNAL</b>\n` +
    `${bar}\n` +
    `<b>Asset:</b>      ${signal.asset}\n` +
    `<b>Direction:</b>  ${emoji} ${signal.direction.toUpperCase()}\n` +
    `<b>Catalyst:</b>   ${signal.catalyst}\n` +
    `<b>Source:</b>     ${signal.source}\n` +
    `<b>Confidence:</b> ${signal.confidence}/100\n` +
    `<b>Context:</b>    ${signal.context}\n` +
    `${urgEmoji} <b>Urgency:</b>   ${signal.urgency.toUpperCase()}\n` +
    `${bar}\n` +
    `<i>${signal.title.slice(0, 120)}</i>`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      { timeout: 10000 }
    );
    console.log(`[Telegram] Signal sent: ${signal.asset} ${signal.direction} (${signal.confidence})`);
  } catch (e) {
    console.error("[Telegram] Send error:", e.message);
  }
}

async function sendTelegramStatus(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" },
      { timeout: 10000 }
    );
  } catch (e) {
    console.error("[Telegram] Status send error:", e.message);
  }
}

// ─── MAIN SCAN LOOP ───────────────────────────────────────────────────────────

async function runScan() {
  console.log(`\n[Hermes] Scan started at ${new Date().toISOString()}`);
  lastScanTime = new Date().toISOString();

  // 1. Fetch from all sources in parallel
  const [finnhub, newsapi, rss] = await Promise.all([
    fetchFinnhubNews(),
    fetchNewsAPI(),
    fetchRSSFeeds(),
  ]);

  const allArticles = [...finnhub, ...newsapi, ...rss];
  console.log(`[Hermes] Fetched ${allArticles.length} total articles`);

  // 2. Deduplicate
  const freshArticles = deduplicateHeadlines(allArticles);
  console.log(`[Hermes] ${freshArticles.length} fresh headlines after dedup`);

  if (freshArticles.length === 0) {
    console.log("[Hermes] No new headlines. Skipping analysis.");
    return;
  }

  // 3. Keyword pre-filter — only market-relevant headlines reach Claude
  const relevant = keywordFilter(freshArticles);
  console.log(`[Hermes] ${relevant.length} headlines passed keyword filter (${freshArticles.length - relevant.length} dropped)`);

  if (relevant.length === 0) {
    console.log("[Hermes] No keyword-matched headlines. Skipping Claude analysis.");
    return;
  }

  // 4. Analyze keyword-matched headlines in batches of 40
  const BATCH_SIZE = 40;
  let allSignals = [];
  for (let i = 0; i < relevant.length; i += BATCH_SIZE) {
    const batch = relevant.slice(i, i + BATCH_SIZE);
    const signals = await analyzeWithClaude(batch);
    allSignals = allSignals.concat(signals);
    if (i + BATCH_SIZE < relevant.length) {
      await new Promise((r) => setTimeout(r, 2000)); // small delay between batches
    }
  }

  // 5. Filter by threshold
  const qualified = allSignals.filter(
    (s) => s.confidence >= CONFIG.CONFIDENCE_THRESHOLD
  );
  console.log(`[Hermes] ${allSignals.length} signals found, ${qualified.length} above threshold`);

  // 6. Fire Telegram alerts
  for (const signal of qualified) {
    await sendTelegramSignal(signal);
    totalSignalsFired++;
    signalLog.unshift({
      ...signal,
      firedAt: new Date().toISOString(),
    });
  }

  // Keep log bounded
  if (signalLog.length > 200) signalLog = signalLog.slice(0, 200);

  console.log(`[Hermes] Scan complete. ${qualified.length} signals fired.`);
}

// ─── EXPRESS ENDPOINTS ────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    system: "Hermes Signal Engine",
    status: "running",
    lastScan: lastScanTime,
    totalSignalsFired,
    recentSignals: signalLog.slice(0, 10),
  });
});

app.get("/status", (req, res) => {
  res.json({
    status: "running",
    lastScan: lastScanTime,
    totalSignalsFired,
    confidenceThreshold: CONFIG.CONFIDENCE_THRESHOLD,
    scanIntervalMinutes: CONFIG.SCAN_INTERVAL_MINUTES,
    seenHeadlinesCache: seenHeadlines.size,
    keywordCategories: Object.keys(KEYWORDS),
    totalKeywords: ALL_KEYWORDS.length,
    signalLog,
  });
});

app.get("/scan-now", async (req, res) => {
  res.json({ message: "Manual scan triggered" });
  await runScan();
});

app.get("/test-telegram", async (req, res) => {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const chatId = CONFIG.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.json({ ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing from env vars" });
  }

  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: "✅ Hermes test message — Telegram is connected." },
      { timeout: 10000 }
    );
    res.json({ ok: true, telegram_response: response.data });
  } catch (e) {
    res.json({
      ok: false,
      error: e.message,
      telegram_error: e.response?.data || null,
      token_preview: token ? token.slice(0, 10) + "..." : "MISSING",
      chat_id_used: chatId || "MISSING",
    });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ─── CRON SCHEDULE ────────────────────────────────────────────────────────────

const cronExpression = `*/${CONFIG.SCAN_INTERVAL_MINUTES} * * * *`;
cron.schedule(cronExpression, runScan);
console.log(`[Hermes] Scan scheduled every ${CONFIG.SCAN_INTERVAL_MINUTES} minutes`);

// ─── BOOT ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`[Hermes] Server running on port ${PORT}`);
  await sendTelegramStatus(
    `🟢 <b>Hermes Signal Engine online</b>\nScanning every ${CONFIG.SCAN_INTERVAL_MINUTES} min | Threshold: ${CONFIG.CONFIDENCE_THRESHOLD}/100`
  );
  // Run first scan immediately on boot
  await runScan();
});
