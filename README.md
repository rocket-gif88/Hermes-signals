# Hermes Signal Engine

> News-driven trade signal engine. Scans macro & equity news every 15 minutes, runs Claude sentiment analysis, fires high-confidence signals via Telegram.

---

## Stack
- Node.js / Express → Railway
- Claude Haiku (sentiment analysis)
- Telegram Bot (signal delivery)
- Sources: Finnhub, NewsAPI, Reuters/FT/CNBC/MarketWatch RSS

---

## Setup

### 1. Clone & install
```bash
git clone https://github.com/YOUR_USER/hermes-signals
cd hermes-signals
npm install
```

### 2. Environment variables
Copy `.env.example` to `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `FINNHUB_API_KEY` | finnhub.io → free account |
| `NEWS_API_KEY` | newsapi.org → free account |
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | @userinfobot or your channel ID |
| `ANTHROPIC_API_KEY` | console.anthropic.com |

### 3. Run locally
```bash
npm start
```

### 4. Deploy to Railway
- New project → Deploy from GitHub
- Add all env vars in Railway dashboard
- Auto-deploys on push

---

## Endpoints

| Route | Description |
|---|---|
| `GET /` | System status + last 10 signals |
| `GET /status` | Full signal log + config |
| `GET /scan-now` | Trigger manual scan |
| `GET /health` | Health check for Railway |

---

## Signal Format (Telegram)

```
🗞 HERMES SIGNAL
━━━━━━━━━━━━━━━━━━
Asset:      XAU/USD
Direction:  📈 BULLISH
Catalyst:   Fed signals pause on rate hikes
Source:     Reuters Markets
Confidence: 82/100
Context:    Watch $2,310–2,320 for reaction entry
🔴 Urgency:   BREAKING
━━━━━━━━━━━━━━━━━━
Fed holds rates steady for third consecutive meeting...
```

---

## Tuning

- `CONFIDENCE_THRESHOLD` — raise to 80+ for fewer, higher-quality signals. Lower to 60 for more coverage.
- `SCAN_INTERVAL_MINUTES` — 15 is the sweet spot. Don't go below 10 (NewsAPI rate limits).
- Batch size is 40 headlines per Claude call. Adjust in `server.js` if needed.

---

## Cost Estimate (Claude Haiku)
~$0.10–0.25/day at 15-min scans with 50–150 fresh headlines per cycle.
