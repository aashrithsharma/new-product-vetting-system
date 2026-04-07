# Six10 P2: Amazon Intelligence & Automated Viability Scraper

## 📖 Comprehensive Project Overview

The **Six10 P2 System** is a heavy-duty, highly resilient automated Amazon competitive intelligence extractor. It has been specifically designed for financial and operational analysts to generate "Target Prices", "Volume Scenarios", and deep structural data points like product `Dimensions` and `Weight` from otherwise invisible DOM layers on Amazon product pages.

Instead of manual competitor research, this engine automatically expands a single **ASIN** input into a full 6-item competitive set, parses all dynamic web elements through residential proxies, mathematically computes Sales Velocity, and integrates native output instantly into **Google Sheets**, Excel workbooks, and CSV files.

---

## 🏗 Detailed System Architecture

This project connects four massive technical environments to achieve automation:
1. **The Orchestrator (`orchestrator.js`):** The brain of the operation. It receives UI requests, batches ASINs, governs concurrency (safely running parallel requests without triggering Amazon captures), and pushes status logs seamlessly back to the UI interface.
2. **The Extraction Engine (`scraper.js`):** Uses an ultra-aggressive API connection through **ScraperAPI**. It first attempts an ultra-fast raw HTML pull. If it realizes that crucial data is missing (like hidden Dimensions or Weight due to Amazon using late-stage Javascript population), it automatically rejects the HTML and executes an expensive "Layer 3 Javascript Render" to pull the data directly from the hidden Amazon DOM elements.
3. **The Artificial Intelligence Vet (`vettingEngine.js`):** Using **Anthropic Claude 3.5 Sonnet**, it ingests all 6 competitively linked items, extracts pricing patterns, understands BSR constraints, and mathematically projects Unit Economics (Best Case vs Most Likely Case).
4. **The Structural Integrators (`sheets.js` & `exporter.js`):** Intercepts the raw data streams. Any empty data elements (like missing review counts) are strictly converted into rigid hyphens (`-`) rather than text strings ("N/A"). This prevents Google Sheets mathematical formulas from fatally `VALUE!` crashing.

---

## ⚙️ Exhaustive Environment Setup Guide (`.env`)

To successfully launch this project, every single environment variable below must be declared. Missing even one variable will result in critical cascading failures. 

Create a `.env` file cleanly in the core root directory:

```env
# --------------------------------------------------
# 1. CORE APPLICATION SECURITY
# --------------------------------------------------
PORT=3000
# APP_PASSWORD protects the web interface from unauthorized access.
# On Vercel, navigating to the URL will immediately demand this username/password (Login: admin)
APP_PASSWORD=YourStrongPasswordHere

# --------------------------------------------------
# 2. THIRD-PARTY API KEYS
# --------------------------------------------------
# ScraperAPI provides residential rotating proxies + anti-bot DOM rendering. 
SCRAPERAPI_KEY=your_scraper_api_key_here

# Anthropic provides the mathematical heuristics via Claude 3.5 Sonnet.
ANTHROPIC_API_KEY=your_claude_api_key_here

# --------------------------------------------------
# 3. GOOGLE SHEETS PIPELINE
# --------------------------------------------------
# The unique ID extracted from the Google Sheets URL.
GOOGLE_SHEET_ID=your_sheet_id_here
# The exact relative directory path to your Service Account JSON Key file.
GOOGLE_APPLICATION_CREDENTIALS=credentials/your_service_account_key.json

# --------------------------------------------------
# 4. SCRAPING PERFORMANCE LIMITS & DELAYS (DO NOT RANDOMLY ALTER)
# --------------------------------------------------
# Number of parallel network connections to ScraperAPI. Extremely important to keep under 5 or 10.
CONCURRENCY=5
# Rotational background delays between execution batches.
MIN_DELAY_MS=28000
MAX_DELAY_MS=32000
RETRY_DELAY_MS=10000
```

---

## ☁️ Vercel Deployment & Infrastructure Tuning

Deploying to Vercel requires specific system tuning handled within this repository's codebase natively. Because Vercel relies on Stateless Edge Containers, executing a standard long-running background scraping job will result in instant execution timeouts and "Undefined" UI UI crashes.

**How This Codebase Prevents Vercel Failure:**
1. **The 1.6s Keep-Awake Hook (`server.js`):** To aggressively prevent the Vercel container from sleeping the backend scraping engine out of memory between UI polling, the `server.js` route explicitly delays itself by exactly `1600ms`. This keeps the CPU pinned at active execution speeds while cleanly answering the browser before its 2000ms loop hits, preventing Vercel from duplicating the container.
2. **State Protection (`index.html`):** If Vercel accidentally throws a rare `504 Gateway Timeout` or hits to an empty cold container, the UI is hard-coded to ignore the glitch silently, ensuring the user table never receives an `undefined` crash string.

**Deployment Steps on Vercel:**
1. Go to Vercel.com and click **Add New Project**.
2. Select the `six10-P2` repository directly from GitHub.
3. Before deploying, expand the **Environment Variables** drop-down.
4. Copy every single variable from your `.env` directly into Vercel. 
5. Click **Deploy**. Vercel will instantly begin applying the Node.js functions.

---

## 🛠 Advanced Features & Development Notes

- **Dimension Cleansing Logic:** `Dimensions` provided by Amazon natively come in very weird formats (e.g., `4 x 5 x 2  ; 5 Ounces`). The `scraper.js` strictly runs a Regex cleanser to isolate dimensions and pull out trailing data elements before passing it down the pipeline.
- **N/A Wipeout:** To fix financial formulas generated by the original project, `exporter.js` maps through the entire nested ASIN map structure right before JSON dump, specifically intercepting arrays and nested dictionaries to turn every localized "N/A" value into "-" natively.
