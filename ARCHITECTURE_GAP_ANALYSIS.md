# CogniCore — Blueprint 2 (Target Architecture) Gap Analysis

**STATUS: all build-list items B1–B18 are implemented (see CAPABILITIES.md).** Audit of the 27-item "Target Architecture" blueprint against the v0.2 code.
Legend: ✅ present · 🟡 partial · ❌ missing · 🔮 explicitly "future" in the blueprint itself

This file is the resume point for "continue": work through the **Build list** at the bottom
top to bottom, tick items, and keep `FEATURE_TRACKER.md` in sync.

| # | Blueprint item | Before this pass | What was missing |
|---|---|---|---|
| 1 | Orchestrator: intent → plan → tools → execute → validate → evidence → answer | 🟡 intent + single-tool agent + SQL-only "Deep Analysis" | A real planner that mixes tools (SQL, trend, anomaly, KPI, quality, correlation, documents), runs independent steps in parallel, validates and synthesises |
| 2 | Universal ingestion | 🟡 CSV/XLSX/JSON/SQLite/PG/MySQL/PDF/DOCX/TXT/REST/GraphQL | PPTX, Markdown, scanned-doc OCR, Parquet (🔮 Sheets/ERP/CRM/S3) |
| 3 | Automatic dataset understanding | 🟡 types, PK/FK candidates, relationships, missing, dupes, cardinality | Distributions / percentiles per numeric column |
| 4 | Semantic data catalog | 🟡 column roles + values | Dataset card (owner, source, type, freshness, quality score), entities, **editable business meanings** |
| 5 | Intelligent query engine | ✅ | — |
| 6 | SQL safety layer | 🟡 parser, schema, permission, read-only, sandboxed exec | **Cost / complexity check** (joins, cartesian products, depth, length) |
| 7 | Analytical intelligence | 🟡 trend, anomaly, correlation, forecast | Descriptive stats tool (percentiles, variance, distribution), **seasonality**, moving averages in trend output |
| 8 | Document intelligence | 🟡 parse → chunk → embed → retrieve, page evidence | Section/heading detection, **reranker**, PPTX/MD, OCR hook, injection neutralisation actually applied to retrieved text |
| 9 | Hybrid intelligence | ✅ | — |
| 10 | Local LLM architecture / provider interface | 🟡 Ollama provider behind an interface | Optional OpenAI / Anthropic providers (off by default) |
| 11 | Model router | ❌ | Per-task models (SQL / reasoning / embedding / rerank) |
| 12 | Tool system / registry | 🟡 chart/export/report tools + agent tools, not unified | One registry with metadata (+ Schema, Profiler, Validation tools) and an API |
| 13 | Agent planning | 🟡 SQL-only plan | See #1 |
| 14 | Evidence & provenance | 🟡 query, dataset, rows | columns used, calculation description, timestamp, document page/section on every answer |
| 15 | Answer confidence | 🟡 single number | **Explained** confidence: schema certainty, query validity, completeness, consistency, evidence quality → High/Medium/Low |
| 16 | Data-quality engine | 🟡 missing, dupes, dates, categories, outliers | **Referential integrity**; warnings attached to answers that touch affected columns |
| 17 | Security architecture | 🟡 auth, RBAC, column/row policy, audit, rate limit, injection, PII | **File-content validation**, **session management** (list/revoke), production secret check |
| 18 | Prompt-injection defence | 🟡 question screening | Retrieved/document text treated as untrusted data (boundary + neutralisation) |
| 19 | Memory | 🟡 conversation + session state | **User preferences** (output format, detail) that can never override security |
| 20 | Visualization engine | 🟡 auto chart type, SVG export | PNG export, drill-down; 🔮 geographic maps (needs geodata) |
| 21 | Executive intelligence layer | ❌ | "Today's Intelligence" proactive briefing |
| 22 | What-if / scenario engine | ❌ | Scenario recalculation clearly labelled as simulation |
| 23 | Automated reports | 🟡 | Evidence appendix (queries), anomalies section |
| 24 | Frontend workspaces | 🟡 Chat, Insights, Schema, Actions, Governance, Admin | Command Center, Dashboard, AI Activity, Data/Documents workspace |
| 25 | Observability / AI Trace | ❌ | Per-request trace (intent, plan, tools, SQL, timings, validation) + AI Activity screen |
| 26 | Testing architecture | 🟡 unit + e2e + 5-domain demo | Benchmark suite (query accuracy vs ground truth, security corpus, permission matrix) |
| 27 | Ten-layer organisation | ✅ (documented mapping) | README mapping to the 10 layers |

## Build list (tick as done)
- [x] B1  Provenance + explained confidence (#14, #15)
- [x] B2  SQL cost/complexity check (#6)
- [x] B3  Referential integrity + quality warnings on answers (#16)
- [x] B4  Trace recorder + AI Activity API (#25)
- [x] B5  Orchestrator planner: multi-tool plans, parallel steps, synthesis (#1, #13)
- [x] B6  What-if scenario tool (#22)
- [x] B7  Executive briefing "Today's Intelligence" (#21)
- [x] B8  Descriptive stats + seasonality + distributions (#3, #7)
- [x] B9  Unified tool registry (#12)
- [x] B10 Model router + optional providers (#10, #11)
- [x] B11 Document intelligence: boundary/neutralise, sections, reranker, PPTX/MD, OCR hook (#8, #18)
- [x] B12 Semantic catalog: dataset card + business meanings (#4)
- [x] B13 User preferences memory (#19)
- [x] B14 Security: file validation, sessions, secret check (#17)
- [x] B15 Frontend: Command Center, Dashboard, AI Activity, PNG export, drill-down (#20, #24)
- [x] B16 Benchmark suite (#26)
- [x] B17 Report appendix (#23)
- [x] B18 Docs + final zip

## Deliberately not built (and why)
* Google Sheets / ERP / CRM / S3 connectors — marked "Future connectors" in the blueprint; the REST/GraphQL connector covers most of them via their APIs.
* Parquet — needs a native parser dependency; can be added as an adapter later. CSV/Excel export from a Parquet source works today.
* Geographic map charts — need geodata/tiles and a map library; no honest offline implementation.
* Neural reranker / OCR engine — not bundled (they need model/binary downloads). A lexical+embedding reranker is built, and OCR uses `tesseract` if installed.
