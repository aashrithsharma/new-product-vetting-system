# Six10 P2: Standard Operating Procedure (SOP)

This manual strictly governs the Standard Operating Procedures (SOP) for utilizing, troubleshooting, expanding, and auditing the automated Amazon Intelligence framework. 

All team members must follow these procedures systematically to prevent infrastructure damage, API credit blowouts, or Google Sheet locking mechanisms.

---

## 🗂 SECTION 1: Standard Execution Flow (Daily Use)

This flow is used when initiating an active scraping load over a target set.

1. **Access the Scraper Console**
   - Point your browser to the active deployment address (e.g., `https://six10-P2.vercel.app` or `http://localhost:3000`).
   - The basic-auth interceptor will pause access immediately. 
   - Username must always be input exactly as `admin`. Password is the exact text contained inside the Vercel/Local `APP_PASSWORD` environment variable.

2. **Select the Execution Mode**
   - **Mode: Run Single ASIN** -> Intended for discovering competitors. You supply a single root ASIN (e.g. `B09CQJ6M6P`), and the Orchestrator will activate the Claude API to hunt down the 5 nearest direct competitors automatically.
   - **Mode: Batch Scrape** -> Used for manually hard-locking a specific array of ASINs without AI discovery tracking. 

3. **Define Idea Names (CRITICAL FOR EXPORT ORGANIZATION)**
   - Inside the **"Idea Name"** Box, accurately write the contextual name of your project (e.g. `Kitchen Sinks Q4`). 
   - **Why?** The Google Sheets writer engine specifically indexes off this Idea Name. It will attempt to locate a Tab/Worksheet matching this text. If it does not exist, it physically provisions a brand new Tab at the bottom of the active Spreadsheet to maintain isolated intelligence tracking.

4. **Initiate the Pipeline**
   - Click **Start Scraping**.
   - NEVER close the browser window once the loader initiates! The Javascript UI logic inside `index.html` maintains a precise `2000ms` pinging loop directly to the serverless container. Closing the browser severs the execution loop hook, resulting in an orphaned request that will instantly terminate upon Vercel's automated system timeout policy.

5. **Wait and Audit the Live Log Stream**
   - *Info Phase:* Watch the logs confirm the ASIN input.
   - *Discovery Phase:* Within 30 seconds, the engine generates competitor arrays internally.
   - *Verification Phase:* Monitor if the ScraperAPI engine successfully bypasses Amazon anti-bot security. If an output logs a `[WARN]`, the engine has triggered an expensive Javascript-level DOM extraction rendering pass to bypass an Amazon wall. Just wait.
   - *Vetting Phase:* The Target Price and Volume Scenarios log matrix will appear. Run is complete. Check the UI for Google Sheet completion links.

---

## 🗂 SECTION 2: Deploying Google Cloud Service Credentials

If deploying the system to a new team member, or recreating the database pipeline, you must establish an authorized connection protocol deeply within the Google Cloud.

**Step 1: Obtain Authorization Architecture (.JSON)**
1. Log into your company’s Google Cloud Console (https://console.cloud.google.com).
2. Go identically to **IAM & Admin -> Service Accounts**.
3. Create a New Service Account. Navigate into the **"Keys"** tab -> **"Add Key"** -> **"Create New Key"** -> Select **JSON**.
4. Securely download the key to your physical hard drive locally.
5. Create a folder named exactly `credentials` inside your git project directory.
6. Place the `.json` key directly inside it. Do not alter the file extensions.
7. Explicitly define the `.env` variable for `GOOGLE_APPLICATION_CREDENTIALS` to precisely point to: `credentials/your_downloaded_key.json`.

**Step 2: Activating Sheet Write Permissions (IMPORTANT)**
1. Open up the targeted destination `.json` file inside any text editor.
2. Locate the line property named `"client_email": "example-bot@your-cloud-project-id.iam.gserviceaccount.com"`.
3. Copy this email strictly to your clipboard.
4. Navigate strictly to your active, literal online Google Sheet spreadsheet url (where you want the data to dump).
5. Click the giant blue **SHARE** button on the top right axis.
6. Paste the `client_email` into the box, explicitly select **Editor** privileges, and hit Share.
*If this procedure is missed, the system will output "Error: Project lacks 403 Insufficient Permission / Caller Does Not Have Authority" entirely crashing the export matrix pipeline.*

---

## 🗂 SECTION 3: Troubleshooting Vercel Cloud Instability

Because Vercel runs on ephemeral hardware, edge cases might result in UI instability.

### Scenario A: Persistent 'Undefined of Undefined' Crash Loops
- **The Core Issue:** I have pushed a mandatory fix that shields the UI, but Vercel possesses an incredibly aggressive, sticky global Edge Content Delivery Network (CDN). The CDN routinely locks standard `.html` files in memory worldwide to speed up website load execution times organically. Thus, Vercel routes your browser into directly receiving an outdated, cached version of `index.html` regardless of the newest GitHub deployment sync.
- **The Manual Override Fix:** With your scraper tab open, hold down `CTRL` and `SHIFT` and tap `R` simultaneously on Windows (or `Cmd + Shift + R` on Mac). This specifically forces the browser into throwing a Cache Discard protocol command upwards to Vercel, downloading the authentic safe code base and permanently stripping the undefined UI glitching behaviors safely.

### Scenario B: 504 Gateway Timeouts During Long Discovers 
- **The Core Issue:** Generating intelligence natively on 6 large ASINs via proxy routing takes upwards to 3 full clock minutes on Vercel Node boundaries. If it takes longer unexpectedly, Vercel forcefully aborts.
- **The Architecture Fix:** Within `server.js`, a programmatic lock artificially clamps the thread open (`await delay(1600)`). If you touch or modify this metric above `2000` (which is precisely the UI's polling timeline metric), the Vercel connection overlaps the bounds limit, assumes the machine is physically dead, and rapidly spins up multiple separate blind "ghost" containers globally, causing catastrophic state fragmentation. NEVER alter the `delay` beyond `1600`.

### Scenario C: Unreasonable Pricing Target Generation by AI
- **The Core Issue:** Claude 3.5 Sonnet may rarely misidentify the product's fundamental hierarchy (e.g. pricing a pack of 12 against a single pack). You must re-assess the logic payload matrices. 
- **The Fix:** Navigate directly into `vettingEngine.js`. Read locally line 28 through line 60. The manual string prompt dictates what Claude thinks. Aggressively modify that System Prompt exactly to specify tighter volume restrictions. 

---

## 🗂 SECTION 4: Updating the System Securely

Whenever adding features, strictly follow this procedure:

1. Perform edits locally. Test it utilizing `node index.js`.
2. Issue the sequence: `git add .` -> `git commit -m "Your Explicit Change Summary"` -> `git push origin master`.
3. *WARNING:* Wait at least 90 seconds for your GitHub sync to fully propagate into a verified Vercel backend build. Check the Vercel dashboard completely for the "Ready" green light icon. 
4. Hard Refresh the browser. Proceed.
