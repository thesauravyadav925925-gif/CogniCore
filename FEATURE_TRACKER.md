# CogniCore — Blueprint Feature Tracker

Source: the user's "Complete Functionality Blueprint" (35 features + Level 3 items).
This file is the resume point: when told "continue", read this file, do the first
unchecked batch, tick it off, and keep going. Status is only ticked when the code
exists AND (where possible) was exercised by a test in `server/tests/`.

Legend: [ ] not started · [~] written, not yet tested · [x] done + tested

## Batch 1 — Understanding & reliability core
- [x] F2/F20 Semantic layer (`server/src/semantic/`)
- [x] F1/F15 Profiling + data quality (dupes, invalid dates, mixed types, inconsistent categories) (`server/src/quality/`)
- [x] F5 Join-path planner for multi-table reasoning (`server/src/schema/join.planner.js`)
- [x] F17 Query validation: columns, GROUP BY, value literals (`sql.validator.js`, `sql.values.repair.js`)
- [x] F18 Automatic error recovery (fuzzy column repair + LLM retry with error)
- [x] F19 Result validation (percent sanity, reconciliation, empty-result probe, contradiction check)
- [x] F6/F7 Follow-up resolution + context state (`server/src/core/followup.resolver.js`)
- [x] F3/F4 Prompt upgrade (semantic layer, window functions, growth, contribution)

## Batch 2 — Analytics
- [x] F10 Anomaly detection (IQR, z-score, MAD, time-series, isolation forest)
- [x] F11 Trend analysis
- [x] F12 Comparative analysis
- [x] F27 Forecasting (moving avg, linear, Holt, backtest)
- [x] F9 Insight generation
- [x] F13 KPI generation
- [x] F8 Automatic visualization selection
- [x] F26 Python/data-science tool (whitelisted Python runner + JS fallback)
- [x] F28/F29 Data exploration + smart suggestions

## Batch 3 — Agent, reports, exports
- [x] F25 Intent router + tool dispatcher (agent/, wired in core.engine, e2e tested)
- [x] F14 Management report (PDF / DOCX / Excel / CSV)
- [x] F30 Exports: report PDF/DOCX/XLSX/CSV, analysis Excel, chart SVG — routes under /api/analytics, tested at module level
- [x] New API routes wiring everything — analytics, policies, knowledge, actions, connections/api mounted

## Batch 4 — Enterprise
- [x] F22 Roles — roles+capabilities enforced on routes (unit tested; HTTP tests need real express)
- [x] F23 Data-level security: enforced + tested in engine; admin API/UI for policies pending — engine + tools routes + policy API; tested
- [x] F24 Audit log: engine returns audit{sql,tables,rows,success}; route must persist it — chat route persists sql/tables/rows/tool/guardrail flags
- [x] F35 Guardrails (injection, PII masking, grounding/contradiction, rate limit) - wired in core.engine; rate limiter to mount in chat route
- [x] F31 REST / GraphQL connector — REST+GraphQL connector, SSRF-guarded, tested; route POST /api/connections/api
- [x] F32/F33 N structured + M documents hybrid — N structured + M documents; tested with two structured sources
- [x] F34 Action execution with confirmation + human approval workflow — propose->approve->execute workflow, tested
- [x] Persistent organizational knowledge — store + API; injected into SQL prompt

## Batch 5 — Frontend
- [x] Insights, auto-chart, KPI cards, suggestions, badges, report/action cards in chat (MessageBubble, AutoChart, InsightsBlock, MessageExtras)
- [x] Tabs: Insights (quality, KPIs, explore, report downloads), Actions (approval workflow), Governance (policies + knowledge), Admin (users/roles/audit)
- [x] REST/GraphQL source form; api.js additions
- NOTE: client files syntax-checked with TypeScript and 5 presentational components server-rendered in tests; a full `vite build` could not be run in the offline sandbox

## Batch 6 — Proof & docs
- [x] F21 Five sample domains + domain-agnostic demo test — sample-data/ + domain-agnostic-demo.test.js passes for 5 domains + multi-table
- [x] Tests for every new module — 118 tests pass (4 HTTP-level files need real express)
- [x] README / PROGRESS / .env.example / Dockerfile (python3) updated
- [x] Final zip: CogniCore-Final-v0.2.zip


## Blueprint 2 (27-item target architecture) — see ARCHITECTURE_GAP_ANALYSIS.md
- [x] All items B1–B18 built and tested (planner, scenarios, briefing, trace, model router, document intelligence, catalog, preferences, security hardening, workspaces UI, benchmark suite, report appendix, docs).
