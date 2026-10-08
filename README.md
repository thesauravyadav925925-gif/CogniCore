# CogniCore

**Domain-Agnostic Enterprise AI Copilot** — upload arbitrary structured or
unstructured data, ask questions in plain language, get answers backed by
deterministic execution and explained by a local Ollama LLM.

This repo is being built in phases (see `PROGRESS.md`). **All 7 phases are complete, live-tested end-to-end against real Ollama models on real hardware, and verified against realistic banking and healthcare datasets** to substantiate the domain-agnostic claim with real evidence — see `PROGRESS.md`'s "Multi-domain verification" and "Real-world testing log" sections.

## What works right now (all 7 phases)

- **Accounts & permissions**: register/login (JWT), roles (admin/manager/analyst/user),
  first user becomes admin. Every dataset has an owner; nobody else can see,
  query, or delete it until explicitly shared via `POST /api/datasets/:id/share`.
  Every security-relevant action (logins, uploads, deletes, shares, denied
  access attempts, chat queries) is written to an audit log, viewable by
  admins at `GET /api/admin/audit`.
- Upload SQLite / CSV / Excel / JSON / **PDF / DOCX / TXT** files
- **Connect live to PostgreSQL or MySQL/MariaDB** (`POST /api/connections`) —
  no file needed, schema is read directly from `information_schema`
- Automatic file-type detection, schema discovery, type inference
- Relationship detection between tables (naming heuristics — no hardcoded
  domain knowledge)
- Natural-language question → LLM-drafted SQL → **AST-validated for the
  correct dialect** (SQLite/PostgreSQL/MySQL) → executed read-only →
  explained by Ollama
- **Document Q&A (RAG)**: PDF/DOCX/TXT are parsed → chunked → embedded
  locally (via Ollama's embedding models) → retrieved by relevance →
  explained by Ollama, with page numbers and relevance scores shown in
  the evidence panel
- **Hybrid queries**: link a structured dataset (spreadsheet/database) and a
  document (policy/handbook) together in the sidebar, then ask a question
  that needs both — e.g. *"which employees don't meet the minimum leave
  requirement according to the policy?"* — and CogniCore queries the
  database, retrieves the relevant policy passage, and answers using both
- **Tools**: turn any answer's underlying data into a bar/line/pie/scatter
  chart, export it as CSV/Excel, or generate a PDF report — all built from
  freshly re-validated query results, never from anything the LLM said
- **🔍 Deep Analysis mode**: for open-ended questions ("give me a management
  summary", "identify operational problems") that need more than one fact,
  check the "Deep Analysis" toggle below the chat input — CogniCore plans
  several sub-questions, runs each through the same fully-validated SQL
  pipeline as every other question, and synthesizes a final answer from the
  real results. Every number in the answer still comes from an executed
  query, never from the LLM doing its own math.
- Full evidence/provenance trail on every answer
- Bounded conversational memory ("them" resolves to the previous result)
- Database credentials are stored server-side only and are **never** returned
  by any API response (see "Security note" below)

### Note on the local vector store
Document embeddings are stored in SQLite and searched with brute-force
cosine similarity in JavaScript — no external vector database required.
This is intentional and matches the project's "no mandatory external
service" philosophy, but it does not scale past roughly tens of thousands
of chunks per dataset. If you need that scale, swap `documents/vector.store.js`
for a real ANN index (e.g. `sqlite-vec`, `hnswlib-node`) — the retriever
and document engine don't need to change.

### Security note on database connections
When you connect to Postgres/MySQL, the password you enter is stored in a
separate internal table (`connection_credentials`) that no API route ever
reads from except the adapters themselves. Every dataset the frontend can
see only shows a sanitized `postgresql://user@host:port/db` string with no
password. If you're deploying this for real, put that credentials table
behind proper encryption-at-rest — Phase 6 (Security) is where
authentication/RBAC/encryption gets formalized.

## What was added in v0.2 (the 35-feature blueprint)

Everything below is implemented in the backend with automated tests (see `FEATURE_TRACKER.md` for the
feature-by-feature status). Nothing is hardcoded to a domain: the five demo datasets in `sample-data/`
(healthcare, HR, finance, retail, education) plus a multi-table retail database run through the same engine.

| Blueprint item | Where it lives |
|---|---|
| 1 Universal ingestion (CSV/Excel/JSON/PDF/TXT/SQLite/Postgres/MySQL/**REST & GraphQL**/multi-file) | `server/src/ingestion/` (+ `api.connector.js`) |
| 2, 20 Automatic schema understanding + **semantic layer** | `server/src/semantic/` |
| 3, 4 NL→SQL incl. percentages, growth, ranking, running totals, moving averages, contribution | `structured/sql.generator.js`, `sql.patterns.js` |
| 5 Multi-table reasoning (automatic join paths) | `schema/join.planner.js` |
| 6, 7 Follow-ups & context | `core/followup.resolver.js`, `core/session.state.js` |
| 8 Automatic visualization | `analytics/viz.js`, `report/chart.svg.js`, `client/.../AutoChart.jsx` |
| 9 Insights | `analytics/insights.js` |
| 10 Anomaly detection (IQR, z-score, MAD, time-series, Isolation Forest) | `analytics/anomaly.js` |
| 11, 12 Trend & comparative analysis | `analytics/trend.js`, `compare.js` |
| 13 KPI generation | `analytics/kpi.js` |
| 14, 30 Management report + exports (PDF/DOCX/Excel/CSV/chart image) | `server/src/report/` |
| 15 Data-quality analysis | `quality/data.quality.js` |
| 16 Evidence & explainability | evidence panel (existing) + repairs/recovery badges |
| 17, 18, 19 Query validation, error recovery, result validation | `structured/sql.analyzer.js`, `sql.values.repair.js`, `result.checks.js`, `core/engines/structured.engine.js` |
| 22, 23 Roles + data-level security (column & row policies) | `security/rbac.js`, `security/data.policy.js` |
| 24 Audit logs | chat route writes SQL, tables, rows, tool, guardrail flags |
| 25 Agent / tool routing | `server/src/agent/` |
| 26 Python/data-science tool (fixed whitelist, no arbitrary code) | `server/src/python/` |
| 27 Forecasting (backtested, clearly labelled as projections) | `analytics/forecast.js` |
| 28, 29 Exploration & smart suggestions | `analytics/exploration.js` |
| 31 API integration | `ingestion/api.connector.js`, `POST /api/connections/api` |
| 32, 33 Cross-source reasoning (N databases/sheets/APIs + M documents) | `core/engines/hybrid.engine.js` |
| 34 Action execution with human approval | `server/src/actions/` |
| 35 Enterprise guardrails (prompt injection, PII masking, grounding, rate limit) | `server/src/guardrails/` |
| Level 3: persistent organizational knowledge | `server/src/knowledge/` |

### Roles
`admin` everything · `manager` + approve actions, manage policies & knowledge · `analyst` query, upload, reports, python, propose actions ·
`employee` query/charts/export (use row policies to confine to own records) · `viewer` query/charts, PII masked.
(`user` is the legacy name and behaves like `analyst`.)

### New API endpoints
`GET /api/analytics/:id/{semantic,quality,kpis,explore,report}` · `GET /api/analytics/:id/report/download?format=pdf|docx|xlsx|csv` ·
`POST /api/analytics/:id/{chart-svg,export-analysis,python}` · `GET|POST|DELETE /api/policies/:id` · `GET|POST|DELETE /api/knowledge` ·
`GET|POST /api/actions`, `POST /api/actions/:id/{approve,reject}` · `POST /api/connections/api`.

### Try the five-domain demo
```bash
cd server
npm run sample-data      # writes ../sample-data/*.csv and retail_multitable.db
# upload each file in the UI, then ask the same questions of every one:
#   "Are there any data quality problems?"   "Are there any unusual values?"
#   "Is the monthly trend increasing or decreasing?"   "Forecast the next 3 months"
#   "Show the key metrics"   "Give me a management report"
```

### Known limits (honest list)
* The data-science tool uses Python's standard library (no scikit-learn/Prophet/ARIMA); forecasting uses moving-average, linear, Holt and a seasonal decomposition with backtested model selection.
* Row-level policies are enforced for SQLite-backed datasets and PostgreSQL; on MySQL they fail closed (access denied).
* Email actions are recorded in an outbox unless SMTP_* is configured (and `npm i nodemailer`).
* Natural-language quality still depends on the local LLM (default `qwen2.5:7b`); deterministic repairs and validators reduce, but cannot eliminate, wrong SQL.

## v0.3 — Target-architecture blueprint (27 items)

Gap analysis and status: `ARCHITECTURE_GAP_ANALYSIS.md`. The full capability list: **`CAPABILITIES.md`**.

### The ten layers and where they live
| Layer | Code |
|---|---|
| 1 Experience (Command Center, Chat, Dashboard, Data Quality, Catalog, Schema, AI Activity, Actions, Governance, Admin, Settings) | `client/src/components/` |
| 2 API & security (auth, sessions, RBAC, rate limit, upload validation) | `server/src/api/`, `server/src/security/`, `guardrails/rate.limit.js` |
| 3 Orchestration (intent, planner, tool router, follow-ups) | `server/src/agent/`, `core/core.engine.js`, `core/followup.resolver.js` |
| 4 Intelligence (reasoning, memory, entity/column resolution) | `core/`, `memory/`, `agent/column.resolver.js` |
| 5 Analytics (SQL, statistics, anomaly, trend, forecast, scenario) | `server/src/analytics/`, `structured/` |
| 6 Knowledge (semantic catalog, business meanings, org knowledge, RAG) | `semantic/`, `knowledge/`, `documents/` |
| 7 Tools (registry + SQL/Python/files/charts/reports/export) | `tools/catalog.js`, `python/`, `report/` |
| 8 Data (CSV, Excel, JSON, DB, PDF, DOCX, PPTX, API) | `ingestion/` |
| 9 Local AI (Ollama + model router + optional providers) | `llm/` |
| 10 Governance & observability (audit, evidence, provenance, AI trace, benchmark) | `evidence/`, `observability/`, `benchmark/` |

### New endpoints
`GET /api/analytics/briefing` · `GET /api/analytics/registry` · `GET /api/analytics/:id/{catalog,dashboard}` · `PUT|DELETE /api/analytics/:id/catalog/meaning` ·
`GET /api/analytics/:id/tool/{schema,profile}` · `POST /api/analytics/:id/tool/validate` · `GET /api/traces`, `GET /api/traces/:id` ·
`GET|PUT /api/preferences` · `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/logout`, `POST /api/auth/logout-all` · `GET /api/admin/models`.

### Benchmarks
```bash
cd server
npm run benchmark       # no model needed: tools, security corpus, permission matrix, regression (writes benchmark-report.md)
npm run benchmark:llm   # also scores natural-language→SQL accuracy with your Ollama model against SQL ground truth
```

## Prerequisites

1. **Node.js 18+**
2. **Ollama** installed and running locally: https://ollama.com
   ```bash
   ollama serve
   ollama pull qwen2.5:7b          # chat/SQL-generation model — update .env if you use a different one
   ollama pull nomic-embed-text    # embedding model, needed for PDF/DOCX/TXT document Q&A
   ```

## Setup

```bash
cd server
npm install
cp .env.example .env      # already done for you, but edit it — see below
npm run dev                # or: npm start
```

Server runs at `http://localhost:4000`.

### Important: set a real JWT_SECRET before using this beyond your own machine
`.env.example` ships with a placeholder `JWT_SECRET`. The server prints a
loud warning on startup if it's still set. Generate a real one:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
and put it in `server/.env` as `JWT_SECRET=<that value>`.

### First-time login
There's no seed user — **the first account you register becomes admin**.
Register through the frontend, or via curl:
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "a-real-password"}'
# → returns { "user": {...}, "token": "..." }  - save the token, every other
#   request needs it as: -H "Authorization: Bearer <token>"
```

## Run the frontend

```bash
cd client
npm install
npm run dev
```

Opens at `http://localhost:5173`. It talks to the backend at
`http://localhost:4000` by default (see `client/.env`,
`VITE_API_BASE_URL`). You'll see:

- **Sidebar** — drag/drop or click to upload a dataset (SQLite/CSV/Excel), with live status (processing/ready/error) and a health dot showing whether Ollama is reachable. Check the box on 2+ datasets to link them for a hybrid query. Your name/role and a sign-out button are at the bottom.
- **Chat tab** — ask questions; every answer shows an expandable **Evidence** panel with the exact SQL that ran, the row count, sample results, and a confidence score. Hybrid answers show each source (🗄 database / 📄 document) separately. Under any database evidence, use **📊 Chart** to build a chart inline, or **⬇ CSV / ⬇ Excel / 📄 PDF Report** to export.
- **Schema tab** — every discovered table/column/type, plus auto-detected relationships between tables (e.g. `students.department_id → departments.department_id`), and click any table to preview its rows. For documents, shows page/chunk counts and sample indexed passages instead.

## Quick test via curl (no frontend needed)

```bash
# 0. Register (first user becomes admin) and save the token
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "a-real-password"}'
TOKEN="paste the token from the response here"

# 1. Check health / Ollama connectivity (public, no auth needed)
curl http://localhost:4000/api/health

# 2. Upload a dataset (any CSV/XLSX/SQLite file)
curl -F "file=@/path/to/your/data.csv" -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/upload
# → returns { "dataset": { "dataset_id": "ds_xxxxxxxx", ... } }

# 3. Ask a question
curl -X POST http://localhost:4000/api/chat \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question": "how many rows are there?", "datasetId": "ds_xxxxxxxx"}'

# 4. Explore the discovered schema
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/schema/ds_xxxxxxxx

# 5. Or connect to a live database instead of uploading a file
curl -X POST http://localhost:4000/api/connections \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "type": "postgres",
    "host": "localhost", "port": 5432,
    "database": "mydb", "user": "myuser", "password": "mypass"
  }'

# 6. Or upload a PDF/DOCX/TXT for RAG-based document Q&A
curl -F "file=@/path/to/handbook.pdf" -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/upload
curl -X POST http://localhost:4000/api/chat \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question": "how many days of annual leave do I get?", "datasetId": "ds_xxxxxxxx"}'

# 7. Share a dataset you own with a teammate (owner or admin only)
curl -X POST http://localhost:4000/api/datasets/ds_xxxxxxxx/share \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email": "teammate@example.com", "permission": "read"}'

# 8. (admin only) view the audit log
curl -H "Authorization: Bearer $TOKEN" "http://localhost:4000/api/admin/audit?limit=50"
```

## Running the tests

```bash
cd server
npm test
```

Runs the full suite via Node's built-in test runner (no extra test
framework dependency) — 68 tests: unit tests for the security-critical SQL
validator (every blocked-statement type, injection/comment-smuggling
attempts, all 3 SQL dialects), the chart/calculate tools, and the
domain-agnostic relationship detector; plus integration tests that spin up
the real Express app and hit it with real HTTP requests, including a full
adversarial RBAC scenario (a second user genuinely cannot see, query, or
delete another user's private dataset until explicitly shared, and
`read` access genuinely cannot delete). Tests run against an isolated
`data-test/` database, never your real dev data.

## Running with Docker

```bash
docker compose up --build
```

Builds and starts the server (`:4000`) and the client (`:5173`). By default
it expects Ollama running natively on your host — see `DEPLOYMENT.md` for
the full guide, required environment variables (especially `JWT_SECRET`),
data backup notes, and an honest note that the Docker setup hasn't been
build-tested in the environment this project was developed in (no Docker
daemon was available there) — please try it and report back if anything's
off.

## Project structure

```
CogniCore/
├── server/              Node/Express backend
│   ├── src/
│   │   ├── api/         routes + middleware
│   │   ├── core/        engine orchestration, router, planner, sessions
│   │   ├── ingestion/    file detection, adapters, dataset registry
│   │   ├── schema/       schema reading/analysis/relationship detection
│   │   ├── structured/   SQL generation, validation, execution
│   │   ├── documents/     parser, chunker, embedder, retriever, vector store (RAG)
│   │   ├── tools/         chart, export, calculate, PDF report tools
│   │   ├── security/      auth (JWT/bcrypt), RBAC middleware, audit log
│   │   ├── llm/          provider abstraction (Ollama default)
│   │   ├── evidence/     provenance/evidence building
│   │   └── response/     answer composition
│   ├── data/             internal SQLite registry + per-dataset DBs (gitignored)
│   └── uploads/          raw uploaded files (gitignored)
└── client/               React (Vite) frontend — auth, chat, upload, schema explorer
    └── src/
        ├── components/    Sidebar, ChatPanel, SchemaExplorer, EvidencePanel, AuthScreen, etc.
        ├── services/       api.js — all backend calls, JWT attached automatically
        └── state/          AppState.jsx (datasets/session), AuthState.jsx (user/token)
```

## Engineering rules this project follows

See `ENGINEERING_RULES.md` — the 35 non-negotiable rules from the master
architecture spec (no hardcoded domain assumptions, LLM is never the source
of truth, SQL is always AST-validated before execution, etc).

## Roadmap

See `PROGRESS.md` for phase-by-phase status, and `DEPLOYMENT.md` for
production deployment instructions and honest scope notes.
