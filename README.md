# 🛒 Amazon Competitor Intelligence System

A fully automated Amazon product data scraper. Extracts pricing, reviews, ratings, BSR, brand info, and product images. Exports to CSV, Excel, and individual Google Sheets per user.

---

## 🧭 How It Works

- **One ScraperAPI subscription** (paid by you) powers all scraping for the whole team.
- **One Google Service Account** (set up by you) allows the app to write into any Google Sheet.
- **The team just opens the app URL**, pastes their Amazon links, pastes their own Google Sheet link, and hits Scrape. That's it — they never touch any code or config.

---

## 🔧 Owner Setup — Do This Once

> **This is only for you (the app owner).** The team does not need to do any of this.

---

### Step 1 — Get a ScraperAPI Key

The scraper uses ScraperAPI to reliably pull Amazon data without getting blocked.

1. Go to [scraperapi.com](https://www.scraperapi.com/) and sign up.
2. Choose a paid subscription plan (the whole team shares these credits).
3. Copy your **API Key** from the dashboard — you'll need it in Step 3.

---

### Step 2 — Create the Google Service Account

The app uses a Google Service Account (a "robot" Google user) to write data into Google Sheets on behalf of the team. You create it once.

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Click **Select a project → New Project**. Name it something like `Amazon Scraper`.
3. In the top search bar, search **Google Sheets API** → click it → click **Enable**.
4. In the left sidebar, go to **IAM & Admin → Service Accounts**.
5. Click **Create Service Account**, give it a name (e.g. `scraper-robot`), and click **Done**.
6. Click on the new Service Account → go to the **Keys** tab.
7. Click **Add Key → Create New Key → JSON**. A `.json` file downloads to your computer.
8. Open it in Notepad — copy **everything** inside (the full JSON block). You'll need this in Step 3.
9. ⚠️ Find the `client_email` field in the JSON. It looks like `scraper-robot@yourproject.iam.gserviceaccount.com`. **Share this email with the team** — they'll each need to invite it into their Google Sheet.

---

### Step 3 — Deploy on Vercel

1. Go to [vercel.com](https://vercel.com/) and log in with your GitHub account.
2. Click **Add New → Project** → import the **Amazon Scraper** GitHub repository.
3. Before clicking Deploy, open the **Environment Variables** section and add these:

| Variable Name | What to paste |
|---|---|
| `SCRAPERAPI_KEY` | Your ScraperAPI key from Step 1 |
| `GOOGLE_CREDENTIALS` | The full contents of the `.json` file from Step 2 |
| `APP_PASSWORD` | A password of your choice — the team uses this to log in |

4. Click **Deploy**. Vercel will give you a live URL (e.g. `amazon-scraper.vercel.app`).

---

### Step 4 — Tell the Team

Send the team **three things**:

- 🔗 The **App URL** (your Vercel link)
- 🔑 The **App Password** you set above
- 📧 The **Robot Email Address** from Step 2 — they need to share their Google Sheet with this address (Editor access) before scraping

> The team's only one-time step is: create a Google Sheet → click Share → paste the robot email → give Editor access. After that, they just paste their sheet link into the app every time they scrape.

---

## ⚙️ Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `SCRAPERAPI_KEY` | ✅ Yes | ScraperAPI key for Amazon data extraction |
| `GOOGLE_CREDENTIALS` | ✅ Yes | Full JSON of the Google Service Account key |
| `APP_PASSWORD` | ✅ Yes | Password to access the web UI |
| `GOOGLE_SHEET_ID` | No | A default Sheet ID if team doesn't provide their own |
| `PORT` | No | Server port (default: 3000) |
| `CONCURRENCY` | No | Parallel ASINs processed at once (default: 5) |
| `BATCH_SIZE` | No | Max ASINs per browser session (default: 25) |

---

## ✨ Features

- **Multi-method price extraction** — hidden inputs, DOM selectors, ScraperAPI structured data, and network interception.
- **Parallel processing** — scrapes multiple ASINs simultaneously.
- **Per-user Google Sheet** — each team member can paste their own Sheet link at scrape time.
- **Second Chance retry** — failed ASINs are automatically retried with a fresh session.
- **Smart ASIN parsing** — accepts raw ASINs or full Amazon URLs (`.com`, `.in`, `.co.uk`, etc.).
- **Multiple output formats** — CSV, Excel (with embedded product images), and Google Sheets.
- **Drop-folder trigger** — drop a `.csv` into the `watch/` folder to trigger a scrape automatically.
- **Daily scheduled scrape** — configured via `data/watchlist.csv` and runs at 7 AM automatically.

---

## 📁 Project Structure

```
scrapper-amazon/
├── index.js          # Entry point — starts server + scheduler
├── server.js         # REST API routes
├── orchestrator.js   # Manages scrape runs, retries, finalization
├── scraper.js        # Playwright browser engine + price logic
├── exporter.js       # Generates CSV and Excel output files
├── sheets.js         # Google Sheets integration (supports dynamic Sheet IDs)
├── scheduler.js      # Daily cron job (reads data/watchlist.csv)
├── watcher.js        # Watches watch/ folder for dropped CSVs
├── urlParser.js      # ASIN extraction from any URL format
├── config.js         # All config from environment variables
│
├── data/watchlist.csv      # ASINs for the daily scheduled run
├── watch/                  # Drop CSVs here to trigger instant scrapes
├── outputs/                # Generated CSV and Excel files
├── logs/                   # Rotating log files
└── credentials/
    └── google-service-account.json  # (Local use only — use GOOGLE_CREDENTIALS on Vercel)
```

---

## 📡 API Reference

### POST `/api/scrape`

```json
{
  "mode": "urls",
  "urls": ["https://www.amazon.com/dp/B09TMN644Z", "B07VVK39F7"],
  "formats": ["csv", "xlsx"],
  "writeToSheets": true,
  "customSheetId": "paste-sheet-id-or-full-url-here"
}
```

| Field | Description |
|---|---|
| `mode` | `"urls"` or `"asins"` |
| `urls` / `asins` | Array of Amazon URLs or raw ASINs (max 10) |
| `writeToSheets` | Set `true` to write results to Google Sheets |
| `formats` | `["csv"]`, `["xlsx"]`, or `["csv", "xlsx"]` |
| `customSheetId` | Full Google Sheet URL or bare Sheet ID — overrides the server default |
