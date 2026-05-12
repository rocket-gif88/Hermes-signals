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
  TWELVE_DATA_API_KEY: process.env.TWELVE_DATA_API_KEY,
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
  { name: "FT Markets",       url: "https://www.ft.com/markets?format=rss" },
  { name: "CNBC Finance",     url: "https://www.cnbc.com/id/10000664/device/rss/rss.html" },
  { name: "MarketWatch",      url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
  { name: "Investing.com",    url: "https://www.investing.com/rss/news.rss" },
  { name: "ForexLive",        url: "https://www.forexlive.com/feed/news" },
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

// ─── ASSET SYMBOL MAP ────────────────────────────────────────────────────────

const ASSET_SYMBOL_MAP = {
  // Commodities
  "wti": "WTI/USD", "crude": "WTI/USD", "crude oil": "WTI/USD", "cl": "WTI/USD", "cl=f": "WTI/USD", "cl/wti": "WTI/USD",
  "brent": "BRENT/USD", "brent crude": "BRENT/USD",
  "gold": "XAU/USD", "xau": "XAU/USD", "xau/usd": "XAU/USD",
  "silver": "XAG/USD", "xag": "XAG/USD", "xag/usd": "XAG/USD",
  "natural gas": "XNG/USD", "ng": "XNG/USD", "nat gas": "XNG/USD",
  "copper": "XCU/USD", "hg": "XCU/USD",
  "c2h6": null, "ethane": null, "lng": null, // no liquid market symbol

  // Forex
  "usd/inr": "USD/INR", "inr": "USD/INR", "rupee": "USD/INR", "usd/inr bearish": "USD/INR",
  "gbp/usd": "GBP/USD", "gbpusd": "GBP/USD", "pound": "GBP/USD",
  "eur/usd": "EUR/USD", "eurusd": "EUR/USD", "euro": "EUR/USD",
  "usd/jpy": "USD/JPY", "usdjpy": "USD/JPY", "yen": "USD/JPY",
  "usd/cny": "USD/CNY", "cny/usd": "USD/CNY", "usdcny": "USD/CNY", "yuan": "USD/CNY",
  "dxy": "DXY", "dollar index": "DXY", "usd index": "DXY",
  "usd/sar": "USD/SAR", "sar": "USD/SAR",
};

function resolveSymbol(asset) {
  if (!asset) return null;
  const key = asset.toLowerCase().trim();
  if (key in ASSET_SYMBOL_MAP) return ASSET_SYMBOL_MAP[key];
  // Partial match fallback
  for (const [k, v] of Object.entries(ASSET_SYMBOL_MAP)) {
    if (k && v && (key.includes(k) || k.includes(key))) return v;
  }
  return null;
}

function getTier(asset, hasLevels) {
  if (hasLevels) return { label: "🟢 TIER 1 — ACTIONABLE", note: "Full trade plan below" };
  const equityPattern = /^[A-Z]{1,5}$/.test(asset) && !["WTI","DXY","VIX","SPY","TLT","GLD","SLV"].includes(asset.toUpperCase());
  if (equityPattern) return { label: "🟡 TIER 2 — AWARENESS", note: "No levels (equity signal)" };
  return { label: "🟠 TIER 2 — AWARENESS", note: "No levels for this asset type" };
}

// ─── PRICE + ATR FETCH ────────────────────────────────────────────────────────

async function fetchPriceAndATR(symbol) {
  if (!symbol || !process.env.TWELVE_DATA_API_KEY) return null;
  try {
    // Fetch last 15 daily candles for ATR calculation
    const res = await axios.get("https://api.twelvedata.com/time_series", {
      params: {
        symbol,
        interval: "1h",
        outputsize: 20,
        apikey: process.env.TWELVE_DATA_API_KEY,
      },
      timeout: 8000,
    });

    const values = res.data?.values;
    if (!values || values.length < 5) return null;

    const candles = values.map(v => ({
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }));

    // Calculate ATR (14-period)
    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
      trueRanges.push(tr);
    }
    const atr = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
    const currentPrice = candles[0].close;

    return { currentPrice, atr, symbol };
  } catch (e) {
    console.error(`[Price] Fetch error for ${symbol}:`, e.message);
    return null;
  }
}

function calculateLevels(currentPrice, atr, direction) {
  const isBull = direction === "bullish";
  const dp = currentPrice < 10 ? 5 : currentPrice < 100 ? 4 : currentPrice < 1000 ? 2 : 1;
  const fmt = (n) => n.toFixed(dp);
  const pct = (a, b) => (((b - a) / a) * 100).toFixed(2);

  // Entry zone: 0.25 ATR pullback from current price
  const entryHigh = isBull ? currentPrice : currentPrice + 0.25 * atr;
  const entryLow  = isBull ? currentPrice - 0.25 * atr : currentPrice;
  const entryMid  = (entryHigh + entryLow) / 2;

  // SL: 1.5 ATR beyond entry mid
  const sl   = isBull ? entryMid - 1.5 * atr : entryMid + 1.5 * atr;
  const tp1  = isBull ? entryMid + 1.5 * atr : entryMid - 1.5 * atr;
  const tp2  = isBull ? entryMid + 3.0 * atr : entryMid - 3.0 * atr;

  const risk   = Math.abs(entryMid - sl);
  const reward = Math.abs(tp2 - entryMid);
  const rr     = (reward / risk).toFixed(1);

  return {
    current:    fmt(currentPrice),
    entryLow:   fmt(entryLow),
    entryHigh:  fmt(entryHigh),
    sl:         fmt(sl),
    tp1:        fmt(tp1),
    tp2:        fmt(tp2),
    slPct:      pct(entryMid, sl),
    tp1Pct:     pct(entryMid, tp1),
    tp2Pct:     pct(entryMid, tp2),
    rr,
    atr:        fmt(atr),
  };
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

  const prompt = `You are a professional financial analyst. Analyze the following news headlines and identify trade-relevant events.

HEADLINES:
${headlineList}

For each headline that has ANY directional impact on a financial asset, return a JSON array with your honest confidence score.

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
direction values: "bullish", "bearish" — only include directional signals, skip truly neutral headlines

IMPORTANT RULES:
- Return ONE signal per asset only — never bundle multiple tickers (e.g. do NOT write "CL, RBOB, HO" — pick the most relevant one)
- Use clean standard asset names: "WTI", "Brent", "XAU/USD", "GBP/USD", "EUR/USD", "USD/JPY", "USD/INR", etc.
- Return ALL directional signals with honest confidence scores
- The calling app will apply its own threshold filter
- If NO headlines have any directional market impact, return: []`;

  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
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

  // Attempt to fetch price levels for commodities/forex
  let levelsBlock = "";
  const symbol = resolveSymbol(signal.asset);
  if (symbol) {
    const priceData = await fetchPriceAndATR(symbol);
    if (priceData) {
      const L = calculateLevels(priceData.currentPrice, priceData.atr, signal.direction);
      levelsBlock =
        `${bar}\n` +
        `<b>Current:</b>    ${L.current}\n` +
        `<b>Entry Zone:</b> ${L.entryLow} – ${L.entryHigh}\n` +
        `<b>Stop Loss:</b>  ${L.sl} (${L.slPct}%)\n` +
        `<b>TP1:</b>        ${L.tp1} (${L.tp1Pct}%)\n` +
        `<b>TP2:</b>        ${L.tp2} (${L.tp2Pct}%)\n` +
        `<b>R:R</b>         1:${L.rr}\n`;
    }
  }

  const hasLevels = levelsBlock.length > 0;
  const tier = getTier(signal.asset, hasLevels);

  const msg =
    `🗞 <b>HERMES SIGNAL</b>\n` +
    `${tier.label}\n` +
    `${bar}\n` +
    `<b>Asset:</b>      ${signal.asset}\n` +
    `<b>Direction:</b>  ${emoji} ${signal.direction.toUpperCase()}\n` +
    `<b>Catalyst:</b>   ${signal.catalyst}\n` +
    `<b>Source:</b>     ${signal.source}\n` +
    `<b>Confidence:</b> ${signal.confidence}/100  |  ${urgEmoji} ${(signal.urgency || "").toUpperCase()}\n` +
    levelsBlock +
    `${bar}\n` +
    `<i>${(signal.title || "").slice(0, 120)}</i>`;

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
  const BATCH_SIZE = 20;
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
  const aboveThreshold = allSignals.filter(
    (s) => s.confidence >= CONFIG.CONFIDENCE_THRESHOLD
  );
  console.log(`[Hermes] ${allSignals.length} signals found, ${aboveThreshold.length} above threshold`);

  // 6. Deduplicate by asset — keep highest confidence, drop conflicts
  const assetMap = new Map();
  for (const signal of aboveThreshold) {
    const key = signal.asset?.toLowerCase().trim();
    if (!key) continue;
    const existing = assetMap.get(key);
    if (!existing) {
      assetMap.set(key, signal);
    } else if (existing.direction !== signal.direction) {
      // Conflicting directions — keep higher confidence, flag it
      if (signal.confidence > existing.confidence) {
        assetMap.set(key, signal);
      }
      console.log(`[Hermes] Conflict on ${signal.asset}: ${existing.direction}(${existing.confidence}) vs ${signal.direction}(${signal.confidence}) — keeping higher`);
    } else if (signal.confidence > existing.confidence) {
      // Same direction, higher confidence — replace
      assetMap.set(key, signal);
    }
  }
  // Filter out invalid/unresolvable asset names
  const INVALID_PATTERNS = [/xxx/i, /^n\/a$/i, /^unknown$/i, /^n\.a\.$/i];
  const ALIAS_MAP = {
    "spx": "SPY", "s&p 500": "SPY", "s&p500": "SPY",
    "gbpusd": "GBP/USD", "eurusd": "EUR/USD", "usdjpy": "USD/JPY",
    "usd/inr": "USD/INR", "inr/usd": "USD/INR", "inr": "USD/INR",
    "xau": "XAU/USD", "gold": "XAU/USD",
    "xag": "XAG/USD", "silver": "XAG/USD",
    "wti": "WTI", "crude": "WTI", "crude oil": "WTI",
    "brent crude": "Brent",
    "natural gas": "NG", "nat gas": "NG",
    "dxy": "DXY", "dollar index": "DXY",
  };

  const cleanedSignals = Array.from(assetMap.values()).map(s => {
    const key = s.asset?.toLowerCase().trim();
    if (ALIAS_MAP[key]) s.asset = ALIAS_MAP[key];
    return s;
  }).filter(s => {
    if (!s.asset) return false;
    if (INVALID_PATTERNS.some(p => p.test(s.asset))) {
      console.log(`[Hermes] Filtered invalid asset: ${s.asset}`);
      return false;
    }
    return true;
  });

  // Re-dedup after normalization (catches SPX+SPY, GBP/USD+GBPUSD etc.)
  const finalMap = new Map();
  for (const s of cleanedSignals) {
    const key = s.asset.toLowerCase().trim();
    const existing = finalMap.get(key);
    if (!existing || s.confidence > existing.confidence) {
      finalMap.set(key, s);
    }
  }

  const qualified = Array.from(finalMap.values())
    .sort((a, b) => b.confidence - a.confidence);
  console.log(`[Hermes] ${qualified.length} signals after dedup`);

  // 7. Fire Telegram alerts
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

  console.log(`[Hermes] Scan complete. ${qualified.length} signals fired (from ${aboveThreshold.length} above threshold).`);
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

app.get("/debug", async (req, res) => {
  try {
    const finnhub = await fetchFinnhubNews();
    const sample = finnhub.slice(0, 15);
    const filtered = keywordFilter(sample);
    const toAnalyze = filtered.length > 0 ? filtered : sample;

    // Call Claude directly and expose raw response
    const headlineList = toAnalyze
      .map((h, i) => `${i + 1}. [${h.source}] ${h.title}`)
      .join("\n");

    let claudeRaw = null;
    let claudeError = null;
    let claudeParsed = null;

    try {
      const claudeRes = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4000,
          messages: [{ role: "user", content: `You are a financial analyst. For each headline below that has directional market impact, return a JSON array with asset, direction (bullish/bearish), confidence (0-100), and catalyst. Return ALL signals, no minimum threshold. Headlines:\n${headlineList}` }],
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
      claudeRaw = claudeRes.data.content?.[0]?.text || "NO TEXT IN RESPONSE";
      try {
        const clean = claudeRaw.replace(/```json|```/g, "").trim();
        claudeParsed = JSON.parse(clean);
      } catch(parseErr) {
        claudeParsed = "PARSE ERROR: " + parseErr.message;
      }
    } catch(apiErr) {
      claudeError = {
        message: apiErr.message,
        status: apiErr.response?.status,
        data: apiErr.response?.data,
        anthropic_key_preview: CONFIG.ANTHROPIC_API_KEY ? CONFIG.ANTHROPIC_API_KEY.slice(0, 15) + "..." : "MISSING",
      };
    }

    res.json({
      step1_fetched: sample.length,
      step2_keyword_matches: filtered.length,
      step2_matched_titles: filtered.map(a => a.title),
      step3_claude_raw: claudeRaw,
      step3_claude_parsed: claudeParsed,
      step3_claude_error: claudeError,
      current_threshold: CONFIG.CONFIDENCE_THRESHOLD,
    });
  } catch (e) {
    res.json({ error: e.message, stack: e.stack });
  }
});

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
