# 🛒 Amazon Competitor Intelligence System

A fully automated Amazon product data scraper that extracts pricing, reviews, ratings, BSR (Best Sellers Rank), brand info, and product images. Results are exported to CSV, Excel, and optionally your own private Google Sheet.

---

## 📖 Table of Contents

1. [How It Works (Overview)](#how-it-works)
2. [Owner Setup — Deploy the App](#owner-setup--deploy-the-app-do-this-once)
3. [Team Usage — How to Scrape](#team-usage--how-to-scrape)
4. [Features](#features)
5. [Project Structure](#project-structure)
6. [API Reference](#api-reference)
7. [Configuration Reference](#configuration-reference)

---

## How It Works

**One shared application, individual Google Sheets per team member.**

- The **app owner (your boss)** pays for one ScraperAPI subscription and deploys the app once on Vercel.
- The **team** accesses a shared web link to use the scraper.
- Each **team member** can send results to **their own private Google Sheet** by pasting their Sheet link into the app before scraping.
- No one on the team needs to write code or touch any configuration.

---

## Owner Setup — Deploy the App (Do This Once)

> **Who does this?** The person who owns the app (your boss / IT admin). You only do this once.

### Step 1 — Get a ScraperAPI Subscription

The app needs a ScraperAPI key to pull Amazon data reliably without getting blocked.

1. Go to [scraperapi.com](https://www.scraperapi.com/) and create an account.
2. Choose a subscription plan (the whole team shares this one key).
3. Once logged in, copy your **API Key** from the dashboard. Keep it safe for Step 4.

---

### Step 2 — Create the Google "Robot" (Service Account)

The app uses a Service Account (a special Google robot) to write data into Google Sheets automatically. You create it once and share its email address with your team.

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Click **Select a project > New Project**. Give it a name like `Amazon Scraper`.
3. In the search bar at the top, search for **Google Sheets API** and click **Enable**.
4. In the left sidebar, go to **IAM & Admin > Service Accounts**.
5. Click **Create Service Account**, give it a name (e.g. `scraper-robot`), and click **Done**.
6. Click on the Service Account you just created, then go to the **Keys** tab.
7. Click **Add Key > Create New Key > JSON**. A `.json` file will download to your computer.
8. Open that `.json` file in Notepad. Copy **everything** inside — you'll need it in Step 4.
9. ⚠️ **Important:** Note the `client_email` field inside the JSON (ends in `@...gserviceaccount.com`). This is the **Robot's Email Address**. You will share this with the whole team.

---

### Step 3 — Deploy on Vercel

1. Go to [vercel.com](https://vercel.com/) and log in with your GitHub account.
2. Click **Add New > Project** and import the **Amazon Scraper** GitHub repository.
3. Before hitting Deploy, open the **Environment Variables** section and add **all four** of these:

| Variable Name | What to put in the Value field |
|---|---|
| `SCRAPERAPI_KEY` | Your ScraperAPI key from Step 1 |
| `GOOGLE_CREDENTIALS` | The entire contents of the `.json` file from Step 2 |
| `APP_PASSWORD` | A password you choose — the team will use this to log into the app |

4. Click **Deploy**. Vercel will give you a live URL (e.g. `amazon-scraper.vercel.app`).

---

### Step 4 — Share with the Team

Send the team these three things:
- 🔗 The **Vercel App URL**
- 🔑 The **App Password** you set above
- 📧 The **Robot's Email Address** from Step 2 (so the team can share their sheets with it)

---

## Team Usage — How to Scrape

> **Who does this?** Everyone on the team who wants to use the scraper. Follow these steps before your first scrape.

### One-Time Setup — Link Your Google Sheet

You only need to do this once per Google Sheet.

1. Open your **Google Drive** and create a new blank Google Sheet.
2. Click the **Share** button (top right corner of Google Sheets).
3. In the "Add people" box, paste the **Robot's Email Address** that your boss gave you.
4. Set the permission to **Editor** and click **Send**.

> ✅ The robot is now allowed to write data into your sheet. Without this step, the app will get a "Permission Denied" error.

---

### Every Time You Scrape

1. Open the **App URL** in your browser and log in with the **App Password**.
2. Choose your input method — **Paste ASINs** or **Paste Amazon URLs**.
3. Enter the products you want to scrape (up to 10 at a time).
4. **Tick the "Also write results to Google Sheets" checkbox.**
5. In the **"Google Sheet ID or URL"** field that appears, paste the link to your Google Sheet (e.g. `https://docs.google.com/spreadsheets/d/1abc123.../edit`).
6. Click **▶ Scrape Competitor Data** and wait for it to finish.
7. Once complete, your data will appear in your Google Sheet and you can also download it as CSV or Excel.

> 💡 **Tip:** If you leave the Google Sheet field blank, results will go to the default company sheet (if one is configured).

---

## ✨ Features

- **Multi-method price extraction** — hidden input fields, DOM selectors, ScraperAPI structured data, and network interception.
- **High-speed Parallel Processing** — processes multiple ASINs simultaneously using a configurable concurrency pool.
- **ScraperAPI Integration** — built-in support for ScraperAPI to ensure a 100% success rate on difficult items.
- **Stealth browser** — uses Playwright + `puppeteer-extra-plugin-stealth` to avoid bot detection.
- **Smart ASIN parsing** — accepts raw ASINs, `/dp/` URLs, or full Amazon product URLs (`.com`, `.in`, `.co.uk`, etc.).
- **Multiple output formats** — CSV, Excel (with embedded product images), and Google Sheets.
- **Per-user Google Sheet** — each team member can paste their own Sheet link at scrape time.
- **Second Chance retry** — failed ASINs automatically get one retry with a fresh browser session.
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
└── credentials/
    └── google-service-account.json  # (Local use only) Google API service account key
```

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
  "customSheetId": "your_google_sheet_id_or_full_url",
  "triggerSource": "frontend"
}
```

| Field | Description |
|---|---|
| `mode` | `"urls"` or `"asins"` |
| `urls` / `asins` | Array of Amazon URLs or raw ASINs |
| `writeToSheets` | `true` to also write to Google Sheets |
| `formats` | `["csv"]`, `["xlsx"]`, or `["csv", "xlsx"]` |
| `customSheetId` | *(Optional)* A specific Sheet ID or full URL. Overrides the server default. |

---

## ⚙️ Configuration Reference

All server settings are managed via environment variables (Vercel) or a local `.env` file.

| Key | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `CONCURRENCY` | `5` | Number of ASINs processed in parallel |
| `SCRAPERAPI_KEY` | *(Required)* | ScraperAPI key for anti-bot bypass |
| `GOOGLE_CREDENTIALS` | *(Required on Vercel)* | Full JSON content of the Google Service Account key |
| `GOOGLE_APPLICATION_CREDENTIALS` | `credentials/google-service-account.json` | Path to key file (for local use only) |
| `GOOGLE_SHEET_ID` | *(Optional)* | Default Google Sheet ID if no custom one is provided |
| `APP_PASSWORD` | *(Required)* | Password to access the web UI |
| `BATCH_SIZE` | `25` | Max ASINs per browser session |
| `RETRY_DELAY_MS` | `10000` | Delay before retrying a failed ASIN |


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
