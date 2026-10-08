# START HERE — how to run CogniCore (one folder, nothing else to download)

You only need THIS folder (`CogniCore`). Everything — backend, frontend, sample data, tests, docs — is inside it.

```
CogniCore/
├── server/        ← the backend (Node.js)  runs on http://localhost:4000
├── client/        ← the website (React)    runs on http://localhost:5173
├── sample-data/   ← 5 demo datasets (hospital, HR, finance, retail, education) + a multi-table database
├── START_HERE.md  ← this file
├── README.md      ← full documentation (what each feature is and where its code lives)
├── FEATURE_TRACKER.md             ← blueprint 1 (35 features) checklist
└── ARCHITECTURE_GAP_ANALYSIS.md   ← blueprint 2 (27-item architecture) checklist
```

## One-time setup (install these 3 programs)
1. **Node.js 20 or newer** — https://nodejs.org (choose "LTS")
2. **Ollama** (the free local AI, no API key) — https://ollama.com
3. *(optional)* **Python 3** — only used by the extra statistics tool; the app works without it.

Then, in a terminal, download the two AI models (about 5 GB, once):
```
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

## Run it (two terminals)

**Terminal 1 — backend**
```
cd CogniCore/server
npm install
copy .env.example .env        (Windows)      or      cp .env.example .env     (Mac/Linux)
npm start
```
Open `server/.env` once and change `JWT_SECRET` to any long random text.

**Terminal 2 — frontend**
```
cd CogniCore/client
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

## First use
1. Click **Register** — the **first account you create becomes the Admin**.
2. Upload a file from the `sample-data/` folder (for example `hospital_appointments.csv`) using the sidebar.
3. Ask things like:
   * *Which department has the most appointments?*
   * *What percentage of appointments were completed?*
   * *Are there any data quality problems?*
   * *Is the monthly trend increasing or decreasing?*
   * *Forecast the next 3 months*
   * *Are there any unusual values?*
   * *Give me a management report*
4. Look at the tabs:
   * **Command Center** — "Today's Intelligence": alerts the AI found by itself.
   * **Chat** — ask questions; open "view AI trace", confidence and "where this came from" under each answer.
   * **Dashboard** — automatic charts with filters (pick a value to drill down).
   * **Data Quality** — quality score, KPIs, report downloads (PDF / Word / Excel / CSV).
   * **Catalog** — what every column means (managers can edit the meanings).
   * **Schema** — tables and relationships.   **AI Activity** — every step the AI took.
   * **Actions** — approval workflow.   **Governance** — who can see which columns/rows.
   * **Admin** — users, roles, audit log.   **Settings** — answer style, your sessions, model routing.

Full list of everything it can do: **CAPABILITIES.md**.

## Check that everything works (optional)
```
cd CogniCore/server
npm test                # automated tests
npm run sample-data     # (re)create the demo datasets
npm run benchmark       # accuracy / security / permission benchmark -> benchmark-report.md
```

## If something goes wrong
* "Cannot connect to Ollama" → start the Ollama app, then check `ollama list` shows `qwen2.5:7b`.
* Port already in use → change `PORT` in `server/.env`, and `VITE_API_BASE_URL` in `client/.env`.
* Anything else → send me the exact error text and I will fix it.
