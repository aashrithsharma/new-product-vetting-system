# Standard Operating Procedure (SOP)
**Amazon Scraper Application**

This document outlines the step-by-step procedures for operating, deploying, and troubleshooting the Amazon Intelligence Scraper. Follow these rigidly to maintain operational integrity.

---

## 1. Routine Operation (Triggering Scrapes)

### Single ASIN Execution (Recommended)
1. Go to your local GUI (`localhost:3000`) or your active Vercel GUI (`___ .vercel.app`).
2. Log in using `admin` as the username, and the password defined in your `APP_PASSWORD` environment variable.
3. Switch the toggle on the dashboard to **Run Single ASIN**.
4. Enter a single Target ASIN (e.g. `B09CQJ6M6P`).
5. (Optional) Provide an "Idea Name" like `Kitchen Sink Project`. If left blank, it defaults automatically.
6. Click **Start Scraping**.
7. Keep the tab open. The progress bar will sequentially update across 3 phases:
   - *Phase 1:* Auto-discovering up to 5 direct competitors.
   - *Phase 2:* Aggressive deep-scraping via Proxy API (gathering weights/dimensions).
   - *Phase 3:* Anthropic AI generating Unit Economics & Target Prices.
8. Upon success, check the generated Google Sheet link or download the `.xlsx` Excel directly from the UI.

---

## 2. Platform Deployment (Vercel)

### Step 1: Pre-Commit Checks
* NEVER commit your `.env` file containing live keys into GitHub. 
* Double-check your `server.js` and ensure Vercel stateless safety protocols (the `1600ms` awake-delay block and Cache Header overrides) are fully applied.

### Step 2: Push to GitHub Core
1. Add tracking: `git add .`
2. Commit files: `git commit -m "Deployment Update"`
3. Push to master: `git push origin master`

### Step 3: Vercel Environmental Configuration
1. Login to Vercel -> Select the Project -> Go to **Settings**.
2. Go to **Environment Variables**.
3. Re-create your local `.env` line-by-line here. Ensure the following are matched precisely:
   - `SCRAPERAPI_KEY`
   - `ANTHROPIC_API_KEY`
   - `GOOGLE_SHEET_ID`
   - `APP_PASSWORD`
4. If testing newly deployed code and encountering UI glitches, instruct your browser to **Hard Refresh** (`Ctrl+Shift+R`) to nuke the old Vercel CDN cache.

---

## 3. Integrating Google Sheets

1. Go to Google Cloud Console.
2. Select your project and generate a new Service Account JSON Key.
3. Place this `.json` key directly into the root `credentials/` folder inside the project.
4. Update the `.env` variable `GOOGLE_APPLICATION_CREDENTIALS` to directly map to the new filename (e.g., `credentials/my_new_key.json`).
5. **Critically Important:** Open the physical Google Sheet via your browser. Click the "Share" button and explicitly share the file to the `"client_email"` listed inside your JSON file, giving it "Editor" permissions. Otherwise, the sheets engine will critically fail to write the final reports.

---

## 4. Troubleshooting Guide

| Issue | Root Cause | Immediate Action |
|-------|------------|------------------|
| **UI reads "Undefined of Undefined"** | Browser aggressively caching old, glitchy Vercel API files. | Press `Ctrl+Shift+R` to force the browser to update. No code changes required. |
| **Google Sheets 403 / "Insufficient Permissions"** | The service account email lacks permission to edit the sheet. | Open the Google Sheet > Share > Add the service account email as an Editor. |
| **All specifications returning `-` (dashes) or N/A** | ScraperAPI IP block or page layout change by Amazon. | Run the scraper locally and inspect terminal outputs. Ensure `CONCURRENCY` is kept at a safe range (5). |
| **Vercel Background Crash** | Vercel Serverless containers halting out. | Ensure the `vercelHalt` keep-awake timing in `server.js` stays specifically locked at `1600ms`. Do not exceed `2000`ms. |
| **401 Unauthorized Error on Vercel** | Vercel's internal preview settings override the scraper. | Ensure you are accessing a fully deployed production branch, or authenticate your browser with your Vercel team natively. |

---

## 5. Maintenance Best Practices
- **ScraperAPI Balances:** Routinely monitor your `api.scraperapi.com` dashboard credit usage. High volume batch processing heavily consumes requests due to JS-render retries.
- **Anthropic Prompts:** The instructions governing the AI's math live entirely in `vettingEngine.js`. If logic rules shift (e.g. Sales velocity models), safely alter the prompt matrix there.
