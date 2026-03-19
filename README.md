# 🛒 Amazon Competitor Intelligence System

A fully automated Amazon product data scraper that extracts pricing, reviews, ratings, BSR (Best Sellers Rank), brand info, and product images. Results are exported to CSV, Excel, and Google Sheets.

---

## ✨ Features

- **Multi-method price extraction** — hidden input fields, DOM selectors, ScraperAPI structured data, and network interception.
- **High-speed Parallel Processing** — processes multiple ASINs simultaneously using a configurable concurrency pool.
- **ScraperAPI Integration** — built-in support for ScraperAPI to ensure a 100% success rate on difficult items.
- **Stealth browser** — uses Playwright + `puppeteer-extra-plugin-stealth` to avoid bot detection.
- **Smart ASIN parsing** — accepts raw ASINs, `/dp/` URLs, or full Amazon product URLs (`.com`, `.in`, `.co.uk`, etc.).
- **Multiple output formats** — CSV (vertical layout), Excel (with embedded product images), and Google Sheets.
- **Second Chance retry** — failed ASINs automatically get one retry with a fresh browser session (also parallelized).
- **Drop-folder trigger** — drop a CSV into the `watch/` folder to trigger a scrape automatically.
- **Duplicate deduplication** — ensures each unique ASIN is scraped only once per run.

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

### 4. Provide ScraperAPI Key

Open the `.env` file in the root directory and place your ScraperAPI key:

```env
SCRAPERAPI_KEY=your_key_here
```

### 5. Start the server

```bash
npm start
```

The web UI will be available at **http://localhost:3000**

---

## 🔧 Configuration

All settings are managed via the `.env` file:

| Key | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `CONCURRENCY` | `5` | Number of ASINs to process in parallel |
| `SCRAPERAPI_KEY` | *(Required)* | Your ScraperAPI API key for bypass/high-accuracy extraction |
| `GOOGLE_SHEET_ID` | *(Required)* | Google Sheets document ID (from URL) |
| `GOOGLE_APPLICATION_CREDENTIALS` | `credentials/google-service-account.json` | Path to service account key |
| `BATCH_SIZE` | `25` | Max ASINs per individual browser session |
| `RETRY_DELAY_MS` | `10000` | Delay before retrying a failed ASIN |
| `MIN_DELAY_MS` | `28000` | Minimum delay between ASINs (to stay safe) |

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
- `urls` / `asins`: Array of Amazon URLs or raw ASINs.
- `writeToSheets`: `true` to also write to Google Sheets.
- `formats`: `["csv"]`, `["xlsx"]`, or `["csv", "xlsx"]`.

---

## 🔄 Trigger Methods

### 1. Web UI
Open **http://localhost:3000**, paste URLs or ASINs, and click **Scrape**.

### 2. API (programmatic)
`POST /api/scrape` as shown above.

### 3. Drop-folder (CSV)
Drop a `.csv` file into the `watch/` folder. The watcher detects it automatically and starts a scrape. Format: One ASIN or URL per line.

---

## 💰 Price Extraction — How It Works

Prices are extracted using a robust priority chain:
1. **Hidden Input**: Server-rendered price strings often found in search/variants.
2. **Exact DOM Selector**: High-priority CSS selectors used in standard buy boxes.
3. **Buy Box Offscreen**: Accessibility labels containing formatted price strings.
4. **Price whole + fraction**: Reconstructed from separate integer and decimal elements.
5. **Network interception**: Real-time JSON monitoring of Amazon's own price API responses.

---

## 📋 Supported ASIN Input Formats

The system is flexible with inputs:
- `B09TMN644Z` (Raw ASIN)
- `https://www.amazon.com/dp/B09TMN644Z` (Standard DP)
- `https://www.amazon.in/dp/B0979RDMR4?th=1` (International variants)
- `https://www.amazon.com/gp/product/B07VVK39F7` (Alternate structures)

---

## 🗓️ Google Sheets Setup

1. Create a Google Cloud project and enable the **Google Sheets API**.
2. Create a **Service Account** and download the JSON key.
3. Place the key at `credentials/google-service-account.json`.
4. Share your Google Sheet with the service account email (**Editor** access).
5. Set `GOOGLE_SHEET_ID` in `.env` to the sheet's document ID.

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

- **Node.js**: >= 18
- **Chromium**: `npx playwright install chromium`
- **ScraperAPI**: Account for anti-bot bypass.
- **Google Cloud**: Service account and key.
