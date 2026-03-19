# 🛒 Amazon Competitor Intelligence System

A fully automated Amazon product data scraper that extracts pricing, reviews, ratings, BSR (Best Sellers Rank), brand info, and product images. Results are exported to CSV, Excel, and Google Sheets — with optional Slack notifications.

---

## ✨ Features

- **Multi-method price extraction** — hidden input fields, DOM selectors, ScraperAPI structured data, and network interception
- **High-speed Parallel Processing** — processes multiple ASINs simultaneously using a configurable concurrency pool
- **ScraperAPI Integration** — built-in support for ScraperAPI to ensure 100% success rate on difficult items
- **Stealth browser** — uses Playwright + `puppeteer-extra-plugin-stealth` to avoid bot detection
- **Smart ASIN parsing** — accepts raw ASINs, `/dp/` URLs, or full Amazon product URLs (`.com`, `.in`, `.co.uk`, etc.)
- **Multiple output formats** — CSV (vertical layout), Excel (with embedded product images), and Google Sheets
- **Second Chance retry** — failed ASINs automatically get one retry with a fresh browser session (also parallelized)
- **Drop-folder trigger** — drop a CSV into the `watch/` folder to trigger a scrape automatically
- **Duplicate deduplication** — same ASIN from multiple inputs is scraped only once

---

## 📁 Project Structure

```
scrapper-amazon/
├── index.js          # Entry point — starts Express server + scheduler
├── server.js         # REST API (scrape, status, download, cancel)
├── orchestrator.js   # Manages scrape runs, retries, and finalization
├── scraper.js        # Playwright browser engine + price extraction logic
├── exporter.js       # Generates CSV and Excel (with embedded images)
├── sheets.js         # Google Sheets integration
├── scheduler.js      # Daily cron job (reads data/watchlist.csv)
├── watcher.js        # File-drop watcher (monitors watch/ folder)
├── notifier.js       # Slack webhook notifications
├── urlParser.js      # ASIN extraction from URLs, raw ASINs, etc.
├── logger.js         # Winston-based logger (console + rotating files)
├── config.js         # Centralized configuration from .env
├── userAgents.js     # Rotating user-agent pool
├── utils.js          # Shared helpers (delay, etc.)
│
├── data/
│   └── watchlist.csv         # ASINs/URLs for the daily scheduled run
├── watch/                    # Drop CSVs here to trigger an instant scrape
├── processing/               # Files move here while being processed
├── outputs/                  # Generated CSV and Excel files
├── logs/                     # Rotating log files
├── credentials/
│   └── google-service-account.json  # Google API service account key
└── public/                   # Frontend web UI (served statically)
```

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Install Playwright browsers

```bash
npx playwright install chromium
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values (see [Configuration](#-configuration) below).

### 4. Start the server

```bash
node index.js
# or
npm start
```

The web UI will be available at **http://localhost:3000**

---

## 🔧 Configuration

Copy `.env.example` to `.env` and fill in your values:

| `PORT` | `3000` | Port the server listens on |
| `CONCURRENCY` | `5` | Number of ASINs to process in parallel |
| `SCRAPERAPI_KEY` | *(optional)* | API key for ScraperAPI fallback/concurrent checks |
| `GOOGLE_SHEET_ID` | *(required)* | Google Sheets document ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | `credentials/google-service-account.json` | Path to service account key |
| `SLACK_WEBHOOK_URL` | *(optional)* | Slack Incoming Webhook URL |
| `BATCH_SIZE` | `25` | Max ASINs per individual browser session |
| `RETRY_DELAY_MS` | `10000` | Delay before retrying a failed ASIN |
| `DEFAULT_AMAZON_DOMAIN` | `amazon.com` | Fallback domain when none is detected from URL |

---

## 📡 API Reference

### Start a scrape

```http
POST /api/scrape
Content-Type: application/json

{
  "mode": "urls",
  "urls": [
    "https://www.amazon.com/dp/B09TMN644Z",
    "B07VVK39F7"
  ],
  "formats": ["csv", "xlsx"],
  "writeToSheets": true,
  "triggerSource": "frontend"
}
```

- `mode`: `"urls"` or `"asins"`
- `urls` / `asins`: Array of Amazon URLs or raw ASINs (max 10 per run)
- `writeToSheets`: `true` to also write to Google Sheets
- `formats`: `["csv"]`, `["xlsx"]`, or `["csv", "xlsx"]`

**Response:**
```json
{ "runId": "1773545396712", "status": "started" }
```

---

### Poll run progress

```http
GET /api/scrape/:runId/progress
```

Returns real-time status: `completedAsins`, `succeededAsins`, `failedAsins`, `logLines`, `isComplete`, etc.

---

### Download output file

```http
GET /api/scrape/:runId/download/csv
GET /api/scrape/:runId/download/xlsx
```

---

### Cancel a run

```http
DELETE /api/scrape/:runId
```

---

### Get system status

```http
GET /api/status
```

---

## 🔄 Trigger Methods

### 1. Web UI
Open **http://localhost:3000**, paste URLs or ASINs, and click **Scrape**.

### 2. API (programmatic)
`POST /api/scrape` as shown above.

### 3. Drop-folder (CSV)
Drop a `.csv` file into the `watch/` folder. The watcher detects it automatically and starts a scrape. One ASIN or URL per line.

```
watch/
└── products.csv   ← drop here
```

---

---

## 💰 Price Extraction — How It Works

Prices are extracted using a priority chain (highest → lowest):

| Priority | Method | Source |
|---|---|---|
| 1st | **Hidden Input** | `<input name="items[*][customerVisiblePrice][displayString]">` — server-rendered |
| 2nd | **Exact DOM Selector** | `#corePrice_feature_div span.apex-pricetopay-value span.a-offscreen` |
| 3rd | **Buy Box offscreen** | `.a-offscreen` inside known buy-box containers |
| 4th | **Price whole + fraction** | `.a-price-whole` + `.a-price-fraction` reconstructed |
| 5th | **Global offscreen** | Any `.a-offscreen` on the page containing `₹`, `$`, or `INR` |
| Fallback | **Network interception** | JSON/HTML API responses from Amazon's offer endpoints |

> Network interception is last-resort only. It is restricted to actual API responses (`application/json`, `text/html`) and specific Amazon offer endpoints — CSS/JS bundles are excluded to avoid false-positive prices.

---

## 📊 Output Format

Results are exported in a **vertical layout** — each row is a field, each column is a product.

| Field | Description |
|---|---|
| Product Link | Original Amazon URL |
| Product Image | Embedded in Excel; URL in CSV |
| Form | Item form (tablet, liquid, etc.) |
| Brand Name | Brand/manufacturer |
| ASIN | Amazon Standard Identification Number |
| Selling Price | Current buy-box price (INR) |
| Stars | Average star rating |
| Reviews | Total review count |
| Title | Full product title |

---

## 🔁 Retry Logic

- **First pass**: All ASINs are scraped in **parallel** using a worker pool (default: 5 at a time).
- **Second Chance pass**: Any ASIN that failed (except `NO_PRODUCT`) is retried once with a fresh browser session. The retry pass is also parallelized.
- Each ASIN is **never retried more than once**.

---

## 📋 Supported ASIN Input Formats

```
B09TMN644Z                                          ← raw ASIN
https://www.amazon.com/dp/B09TMN644Z                ← /dp/ URL
https://www.amazon.in/dp/B0979RDMR4?th=1            ← amazon.in URL
https://www.amazon.com/Some-Product/dp/B07FDJMC9Q   ← full URL with title slug
https://www.amazon.com/gp/product/B07VVK39F7        ← /gp/product/ URL
```

---

## 🔔 Slack Notifications

Set `SLACK_WEBHOOK_URL` in `.env`. After each run completes, a summary is posted:

```
🟢 Scrape Run Complete (Web App)

• Total: 10
• Succeeded: 10
• Failed: 0
• Blocked: 0
• Duration: 3.42 minutes

📊 Open Google Sheet
```

If any ASINs failed, they are listed with their failure reason.

---

## 🗓️ Google Sheets Setup

1. Create a Google Cloud project and enable the **Google Sheets API**
2. Create a **Service Account** and download the JSON key
3. Place the key at `credentials/google-service-account.json`
4. Share your Google Sheet with the service account email (Editor access)
5. Set `GOOGLE_SHEET_ID` in `.env` to the sheet's document ID

---

## 🪵 Logging

Logs are written to:
- **Console** — all levels
- **`logs/`** — daily rotating files via `winston-daily-rotate-file`

Key log prefixes:

| Prefix | Meaning |
|---|---|
| `[SCRAPER]` | Browser/navigation events |
| `[PRICE]` | Price extraction pipeline steps |
| `[NET]` | Network response interception |
| `[PAGE-SUMMARY]` | DOM element presence after page load |
| `[ORCHESTRATOR]` | Run management, parallel workers, finalization |
| `[WATCHER]` | Drop-folder file detection |
| `[EXPORTER]` | CSV/Excel generation |
| `[SHEETS]` | Google Sheets write events |
| `[NOTIFIER]` | Slack notification events |
| `[PARSER]` | ASIN extraction steps |

---

## 🛠️ Running with PM2 (Production)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

---

## ⚙️ Requirements

- Node.js >= 18
- Chromium (installed via `npx playwright install chromium`)
- Google Service Account JSON (for Sheets integration)
- Slack Webhook URL (optional, for notifications)
