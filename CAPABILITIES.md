# What CogniCore can do — the complete capability list

CogniCore is a **domain-agnostic, local-first enterprise AI copilot**. You give it organisational data (files, databases, APIs, documents);
it understands the data on its own, answers questions with evidence, analyses it, warns you about problems, produces reports, and can take
controlled actions — with no domain-specific code and no paid API (it runs on Ollama by default).

Legend: ✅ built and covered by automated tests · 🟡 built, works with a stated limit · ⛔ deliberately not included

---
## 1. Bring in any data
| Capability | Status |
|---|---|
| CSV, Excel (.xlsx/.xls), JSON, SQLite files | ✅ |
| PostgreSQL, MySQL / MariaDB live connections (read-only) | ✅ (needs your database) |
| REST and GraphQL APIs (safe against internal-network attacks) | ✅ |
| PDF, Word (.docx), PowerPoint (.pptx), Markdown, plain text | ✅ |
| Scanned PDFs through OCR | 🟡 works if Tesseract + Poppler are installed on the server; otherwise a clear message |
| Many files / datasets at once, asked together | ✅ |
| File-content checking (a ".csv" that is really a program is refused; zip-bomb protection) | ✅ |
| Parquet, Google Sheets, ERP/CRM, S3 | ⛔ (listed as "future connectors" in the blueprint) |

## 2. Understand the data automatically (no hardcoding)
- Detects file type, tables, columns, data types, primary/foreign-key candidates and relationships between tables ✅
- Gives every column a meaning: identifier, date, money, count, percentage, category, yes/no, free text, personal data ✅
- Measures missing values, duplicates, unique values, ranges, percentiles and distributions ✅
- Normalises mixed date formats to one standard format on load ✅
- **Semantic catalog**: dataset card (owner, source, freshness, quality score), entities, attributes, relationships ✅
- **Business meanings**: managers can write what a column means; the AI then uses it ✅
- **Organisation knowledge**: persistent definitions such as "Active customer = ordered in last 90 days" ✅

## 3. Ask in plain English
- Counts, filters, sorting, top-N, grouping, averages/sums, date queries, multi-condition questions ✅
- Percentages, ratios, growth vs previous period, differences, ranking, running totals, moving averages, contribution to total ✅
- Multi-table questions — it works out the JOIN path itself (customers → orders → products → payments) ✅
- Follow-ups and context ("How much?", "Compare it with the second highest", "Only Q4") ✅
- Cross-source questions (database + spreadsheet + API + documents in one answer) ✅
- Document questions with evidence: file, page/slide and section ✅ (hybrid search + local reranker)

## 4. Trust: answers that check themselves
- SQL is **never** run blindly: syntax → real tables/columns → read-only → safety → **cost/complexity check** → execute ✅
- Auto-fixes wrong table/column names, missing GROUP BY, integer-division percentages, wrong value spelling ("cancelled" → "Cancelled") ✅
- If a query fails it reads the error and retries (bounded) ✅
- Result validation: impossible percentages, totals that don't add up, empty results caused by capitalisation ✅
- The AI's wording is checked against the evidence: invented numbers or self-contradiction are replaced by a deterministic answer ✅
- **Explained confidence** (High / Medium / Low with five measured reasons — not a made-up percentage) ✅
- **Provenance**: source, tables, columns, query, calculation in words, rows scanned/returned, timestamp ✅
- **Data-quality warnings** on answers that touch problem columns ✅
- Every answer shows its evidence and the exact SQL ✅

## 5. Analyse
- Data-quality report: missing, placeholders, duplicates (rows and IDs), invalid/mixed dates, inconsistent categories, numbers-as-text, impossible values, outliers, **orphaned foreign keys** ✅
- Anomaly detection: IQR, z-score, MAD, time-series, Isolation Forest ✅
- Trend analysis (direction, change, peaks, moving average, **seasonality**) ✅
- Comparison (groups, periods, year-vs-year) ✅
- Correlation / regression / percentiles through a **whitelisted Python tool** (falls back to JavaScript) — and it states "correlation ≠ causation" ✅
- Forecasting (moving average, linear, Holt, seasonal; chosen by back-testing; shows uncertainty and is clearly labelled a forecast) ✅
- **What-if scenarios** ("What happens if attendance improves by 10%?") — clearly labelled SIMULATED ✅
- KPI generation from column roles (totals, averages, rates, growth, completeness) ✅
- Automatic insights ("Revenue increased 18%…", concentration, extremes, outliers) ✅
- **Planner for broad questions** ("Analyze our company performance and tell me what needs attention"): builds a plan, runs independent steps in parallel, validates, then summarises ✅
- **Today's Intelligence**: proactive red/orange/green alerts across all your datasets without being asked ✅
- Smart suggestions after every answer, and "What can I ask about this dataset?" ✅

## 6. Show and deliver
- Automatic chart choice: KPI card, line, area, bar, horizontal bar, stacked bar, pie, scatter, histogram ✅ — download as **PNG or SVG**
- Auto-generated **dashboard** with filters and drill-down ✅
- Management report: executive summary, key metrics, trends, problems, anomalies, category analysis, recommendations, supporting data, **evidence appendix with every query** — as **PDF, Word, Excel, CSV** ✅
- Query results → CSV; analysis → Excel workbook (data + question + answer + SQL + insights) ✅
- Interactive map charts | ⛔ (needs geodata)

## 7. Security and governance
- Sign-in, 5 roles (admin, manager, analyst, employee, viewer) with capabilities ✅
- Dataset ownership and sharing ✅
- **Column-level and row-level security enforced in code** (the AI is never the security layer) — also applied to charts, exports, reports, dashboards ✅ (row filters: SQLite-backed files and PostgreSQL; MySQL refuses instead)
- Personal-data detection and **masking** for low-privilege roles ✅
- **Prompt-injection defence**: questions are screened; document text is treated as untrusted data, neutralised and fenced ✅
- Audit log: who asked what, SQL, tables, rows, tool, guardrail flags ✅
- Rate limiting, input validation, safe file handling ✅
- **Revocable sessions** (sign out one/all devices) and refusal to start in production with a weak secret ✅
- **Actions need human approval** (email / save report / approved webhooks): propose → manager approves → runs ✅

## 8. See what the AI did
- **AI Activity**: every question's trace — intent, plan, tool, SQL, validation, timings ✅
- **Model routing**: different models for SQL, reasoning, rewriting, planning; embeddings local; rerank needs no model ✅
- Fully local by default (Ollama). OpenAI / Anthropic providers exist but are **off** unless you configure them ✅

## 9. Memory
- Conversation memory and session state (previous question, filters, period) ✅
- Dataset memory (profile, relationships, meanings) ✅
- **User preferences** (answer style / detail level) — formatting only, can never override security ✅

## 10. Proof it works
- 130+ automated tests, including the same questions asked of five unrelated domains (healthcare, HR, finance, retail, education) plus a multi-table retail database ✅
- **Benchmark suite** (`npm run benchmark`, `npm run benchmark:llm`): checks answers against SQL ground truth, 10 injection attacks, 10 SQL attacks and a permission matrix per domain ✅

---
## Honest limits
1. The quality of **natural-language → SQL** on hard questions depends on your local model. The safety layers catch and repair many mistakes, but no layer makes a small model perfect — run `npm run benchmark:llm` to measure it on your machine.
2. Forecasts are statistical projections from history, never facts; they need at least 4 periods.
3. Row-level restrictions are not available on MySQL connections (access is refused instead).
4. Emails are only recorded in an outbox unless SMTP is configured (and `nodemailer` installed).
5. OCR, Parquet, map charts, and ERP/CRM/Sheets/S3 connectors are not bundled.
6. The test suite could not be run against a real Ollama, real browser, or real Postgres/MySQL during development — do a quick click-through after setup.
