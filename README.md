# Amazon Intelligence & Setup Vetting Engine

## 📊 Overview
This application is an autonomous intelligence engine designed for aggressive, high-accuracy Amazon product scraping and automated financial/viability vetting. It accepts a target ASIN, autonomously discovers up to 5 direct competitors, performs deep-level data extraction (including hard-to-find dynamic DOM elements like dimensions, weight, and BSR), and executes a mathematical vetting protocol using Anthropic's Claude 3.5 Sonnet.

The output is seamlessly formatted and written to **Google Sheets**, while also offering downloadable **Excel/CSV** reports via a clean Web UI.

## 🚀 Key Features
* **Automated Competitor Discovery:** Converts a single ASIN into a robust 6-item competitive set.
* **Deep Spec Extraction:** Uses heavy fallback rendering via Javascript to locate deeply hidden product `Dimensions` and `Weight`.
* **AI Vetting Matrix:** Calculates True Sales Velocity, Unit Economics, and dynamic Volume Scenarios based on Six10 heuristics.
* **Serverless Shielding:** Engineered specifically for **Vercel** deployment with edge-caching overrides and container keep-awake polling to prevent serverless timeouts.
* **Google Sheets Integration:** Connects rigidly via Service Account to structure the intelligence beautifully into dynamic tables.

## 🛠 Tech Stack
* **Backend:** Node.js, Express.js
* **Frontend:** Vanilla JS, CSS, HTML (App Views)
* **Scraping Engine:** ScraperAPI (Dynamic Javascript Rendering / Anti-Bot Bypass) + Cheerio
* **AI:** Anthropic API (Claude 3.5)
* **Integrations:** Google Sheets API (`googleapis`), `exceljs`, `json2csv`

## ⚙️ Environment Configuration (`.env`)
To run this application, create a `.env` file at the root:

```env
# Application Security
APP_PASSWORD=your_secure_password_here
PORT=3000

# API Keys
SCRAPERAPI_KEY=your_scraperapi_key
ANTHROPIC_API_KEY=your_claude_api_key

# Google Sheets
GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_APPLICATION_CREDENTIALS=credentials/your_service_account.json

# Process Control
CONCURRENCY=5
MIN_DELAY_MS=28000
MAX_DELAY_MS=32000
RETRY_DELAY_MS=10000
```

## 🖥 Local Development
1. Clone the repository natively.
2. Run `npm install` to load all backend dependencies.
3. Ensure `.env` is comprehensively filled out and your Google `credentials` folder exists.
4. Run `node index.js`.
5. Access the Web GUI at `http://localhost:3000`.

## ☁️ Vercel Deployment
This repository is optimized for Vercel. 
1. Push this code to the `master` branch.
2. Connect your GitHub repository to Vercel.
3. Overwrite all **Environment Variables** securely inside the Vercel Dashboard -> Settings.
4. IMPORTANT: Ensure `GOOGLE_APPLICATION_CREDENTIALS` matches the exact path of your shipped JSON key in the repository.
5. Deploy. Access your live `.vercel.app` URL and input the `APP_PASSWORD` to execute remote runs.

## 🔧 Architecture Safety Mechanisms
* **N/A Blanking:** Incomplete data points are rendered as strict hyphens (`-`) rather than `N/A` text blocks to preserve Google Sheet formula matrix stability.
* **Stateless Polling:** If Vercel fragments the container request, the UI shields itself from `undefined` variables and safely retries the active container memory.
