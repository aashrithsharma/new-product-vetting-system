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

## 🗂 SECTION 3: Troubleshooting Common Glitches

Because this scraper runs on a cloud server network (Vercel), you might occasionally run into connection hiccups. Here is how both regular users and developers can handle them.

### Scenario A: The Screen Keeps Crashing to "Processing undefined of undefined"
- **The Problem (For Everyone):** You opened the scraper, put in a link, and the progress bar immediately glitched out and printed the word "undefined". This happens because your web browser is stubbornly remembering an old, broken version of the website. 
- **The Fix (For Everyone):** You simply need to force your browser to forget the old website.
  - On **Windows**: Press and hold `Ctrl` + `Shift` + `R`
  - On **Mac**: Press and hold `Cmd` + `Shift` + `R`
  - This is called a "Hard Refresh" and will instantly fix the screen.
- **Developer Details (For Tech Team):** Vercel's global CDN caches `index.html` aggressively. While we have added `Cache-Control: no-store` headers in `server.js` and a protective JSON `typeof` shield in `index.html`, browsers that visited the site previously will often bypass these new headers. A hard refresh forces the browser to discard its local memory and fetch the new protective Javascript logic.

### Scenario B: The Scraper Just Randomly Stops or Times Out
- **The Problem (For Everyone):** The scraper was working normally, but suddenly processing froze entirely and nothing happened for more than 5 minutes.
- **The Fix (For Everyone):** The cloud server simply fell asleep while waiting for Amazon to reply. Just refresh the page and start the scrape again. Do not open multiple tabs doing scrapes at the same time, as this confuses the server.
- **Developer Details (For Tech Team):** Deployments on Vercel Node boundaries strictly sleep when there is no active HTTP request. To solve this, `server.js` uses a `delay(1600)` hook inside `/api/scrape/:runId/progress`. This keeps the API connection open for 1.6 seconds out of every 2-second UI poll. **NEVER** increase this number above 1600. If it hits 2000ms, the connections will overlap, Vercel will interpret the container as busy, and it will spawn blind "ghost" containers, causing immediate "Run Not Found" errors. 

### Scenario C: The AI Output Prices or Numbers Look Very Wrong
- **The Problem (For Everyone):** The AI algorithm evaluated the Amazon listings but generated unrealistic target prices or strange volume scenarios (e.g. comparing a 1-pack of goods against a 12-pack of bulk goods).
- **The Fix (For Everyone):** This is not a software crash; this means Claude (the AI) misunderstood the Amazon product title. Ping the development team so they can adjust the rules the AI uses to think.
- **Developer Details (For Tech Team):** Anthropic Claude 3.5 Sonnet handles the vetting logic. If it fails to identify pack hierarchy, you must edit the System Prompt. Navigate directly into `vettingEngine.js`, localized from line 28 to 60. Adjust the string prompt to forcefully restrict the AI's volume logic and deploy the updated prompt to GitHub.

---

## 🗂 SECTION 4: Updating the System Securely

Whenever adding features, strictly follow this procedure:

1. Perform edits locally. Test it utilizing `node index.js`.
2. Issue the sequence: `git add .` -> `git commit -m "Your Explicit Change Summary"` -> `git push origin master`.
3. *WARNING:* Wait at least 90 seconds for your GitHub sync to fully propagate into a verified Vercel backend build. Check the Vercel dashboard completely for the "Ready" green light icon. 
4. Hard Refresh the browser. Proceed.
