# CogniCore Engineering Rules

These are non-negotiable. Every phase must be checked against this list
before being considered "done".

1. CogniCore must remain domain-agnostic.
2. Never hardcode table names.
3. Never hardcode column names.
4. Never assume an ERP schema.
5. Never assume the dataset is a college, hospital, bank, or company.
6. Never make the LLM the source of truth.
7. Never trust raw LLM-generated SQL.
8. Validate SQL before execution.
9. Enforce permissions outside the LLM.
10. Never expose secrets to the frontend.
11. Never commit `.env`.
12. Never place API keys in source code.
13. Ollama must be the default LLM provider.
14. LLM providers must be abstracted behind an interface.
15. Data ingestion must be independent of query reasoning.
16. Structured data and unstructured documents must have separate execution pipelines.
17. RAG must be an engine, not the core architecture.
18. The query router must determine the appropriate execution path.
19. Hybrid queries must be supported.
20. Numerical answers must originate from deterministic computation.
21. Document answers must be grounded in retrieved evidence.
22. Every answer should preserve source/provenance information.
23. Charts must use validated data.
24. Reports must use validated results.
25. Do not silently fabricate missing data.
26. If the system cannot confidently answer, it must say so.
27. Do not unnecessarily rewrite working components.
28. Before changing existing functionality, inspect the existing implementation.
29. Build incrementally.
30. Test each phase before starting the next.
31. Preserve backward compatibility whenever practical.
32. Keep configuration separate from business logic.
33. Keep security enforcement deterministic.
34. Keep provider-specific code isolated.
35. Design every major component with future extensibility in mind.

## Phase 1 self-audit

| Rule | Status | Where enforced |
|---|---|---|
| #1-5 domain-agnostic | ✅ | No table/column names anywhere in `core/`, `structured/`, `schema/`. Relationship detection is purely structural (`relationship.detector.js`). |
| #6 LLM not source of truth | ✅ | `structured.engine.js`: LLM only drafts SQL and later explains results; numbers come from `sql.executor.js`. |
| #7-8 SQL validation | ✅ | `sql.validator.js` — AST-based whitelist, `node-sql-parser`, blocks DDL/DML, validates tables against actual schema. |
| #11-12 secrets | ✅ | `.env` gitignored, `.env.example` has placeholders only, no keys in source. |
| #13-14 LLM abstraction | ✅ | `llm.provider.js` interface, `ollama.provider.js` implementation, `model.manager.js` single selection point. |
| #15-16 ingestion vs reasoning | ✅ | `ingestion/` has zero knowledge of query logic; `structured/` has zero knowledge of file parsing. |
| #17-19 router | ✅ | `query.router.js` supports STRUCTURED/DOCUMENT routes now; HYBRID slot reserved for Phase 4. |
| #20 deterministic numbers | ✅ | All numeric results come from `sql.executor.js` against real data, never invented by the LLM. |
| #22 provenance | ✅ | `evidence.manager.js` attaches dataset_id, query, row counts to every answer. |
| #25-26 no fabrication | ✅ | `result.validator.js` + `answer.composer.js` explicitly handle zero-row / low-confidence cases. |

## Phase 2 self-audit

| Rule | Status | Where enforced |
|---|---|---|
| #1-5 domain-agnostic | ✅ | Postgres/MySQL adapters discover schema purely from `information_schema` — no assumed table/column names. |
| #7-8 SQL validation | ✅ | `sql.validator.js` made dialect-aware; whitelist verified for SQLite, PostgreSQL, and MySQL syntax. |
| #10 no secrets to frontend | ✅ | `connection_credentials` table is separate from `datasets`; only `dataset.registry.js` internals ever call `getCredentials()`. API responses only ever see the sanitized `location` string. |
| #15-16 ingestion vs reasoning | ✅ | `connection.pipeline.js` is a distinct entry point from file-based `ingestion.pipeline.js`; both converge on the same adapter interface so the structured engine doesn't know or care which was used. |
| #35 extensibility | ✅ | Adding Postgres/MySQL required only new adapter files + one factory entry — zero changes to `core/`, `structured/`, or `evidence/`. |

## Phase 3 self-audit

| Rule | Status | Where enforced |
|---|---|---|
| #6 LLM not source of truth | ✅ | `document.engine.js` only retrieves chunks; `answer.composer.js` is the sole place that explains them. The LLM never decides which chunks are relevant to fetch — cosine similarity does. |
| #16 separate pipelines | ✅ | `document.pipeline.js` is completely separate from `ingestion.pipeline.js` / `connection.pipeline.js` — documents have no SQL schema at all, by design. |
| #17 RAG is an engine, not the core | ✅ | RAG lives entirely inside `documents/` + `core/engines/document.engine.js`; the query router treats it as one route among several (STRUCTURED/DOCUMENT/HYBRID/UNKNOWN), not as the architecture itself. |
| #21 document answers grounded in evidence | ✅ | `evidence.manager.js`'s `buildDocumentEvidence()` carries the exact retrieved text + page + score; `answer.composer.js`'s prompt explicitly forbids inventing facts not in the evidence. |
| #25-26 no fabrication | ✅ | Zero relevant chunks → explicit "couldn't find anything relevant" answer, not a guess. Embedding-provider failures surface as a clear error, not silent zero-result. |
| #29-30 incremental + tested | ✅ | Verified with real generated PDF/DOCX/TXT files before moving on; found and fixed a genuine `pdf-parse` compatibility bug during testing rather than after. |

## Phase 4 self-audit

| Rule | Status | Where enforced |
|---|---|---|
| #6 LLM not source of truth | ✅ | `hybrid.engine.js` merges evidence mechanically; the LLM only explains the merged evidence afterward, in `answer.composer.js`. |
| #18-19 router + hybrid support | ✅ | `query.planner.js` detects the structured+document mix automatically; `query.router.js` dispatches to `hybrid.engine.js`. |
| #22 provenance preserved | ✅ | `buildHybridEvidence()` keeps each source's full evidence object (dataset name, SQL query, retrieved passages with page numbers) inside `evidence.parts` — nothing is flattened away. |
| #27-28 no unnecessary rewrites | ✅ | Reused `structured.engine.js` and `document.engine.js` unchanged in logic (only added `embeddingProvider` as an explicit parameter to `document.engine.js` for consistency with `structured.engine.js`, which already took `llmProvider` as a parameter). |
| #29-30 incremental + tested | ✅ | Verified via a real integration test: real CSV ingestion, real cosine-similarity chunk retrieval, real SQL validation/execution, with only the LLM/embedding *network calls* faked (since no Ollama in the build sandbox) — the actual hybrid routing and evidence-merging logic was exercised for real, not mocked. |
| #31 backward compatibility | ✅ | `datasetId` (singular) still works exactly as before; `datasetIds` (array) is additive. |

## Phase 5 self-audit

| Rule | Status | Where enforced |
|---|---|---|
| #6, #20, #25-26 numbers deterministic, LLM never source of truth | ✅ | `tools/shared.js`'s `resolveValidatedResult()` re-runs the real SQL for every tool call; the LLM is never in the chart/export/report code path at all. |
| #23 tools are controlled capabilities | ✅ | Every tool only runs on an explicit user action (button click → REST call). `tool.registry.js` documents them; nothing lets an LLM chain tool calls autonomously. |
| #24 reports use validated results | ✅ | `report.tool.js` only ever receives `{columns, rows}` freshly pulled by `resolveValidatedResult()` — verified by extracting and reading back the actual generated PDF's text in testing. |
| #7-8 SQL validation | ✅ | Confirmed a `DROP TABLE` submitted through the chart endpoint's `sql` field is rejected by the same `sql.validator.js` used by chat — the tools layer doesn't get a security shortcut. |
| #29-30 incremental + tested | ✅ | Every tool (chart × 4 types, CSV, XLSX, PDF, calculate) was tested against real ingested data with hand-verified expected values, not just "did it return 200". |

## Phase 6 self-audit

| Rule | Status | Where enforced |
|---|---|---|
| #9 permissions enforced outside the LLM | ✅ | `requireDatasetAccess()` middleware runs in Express, before the query router or any LLM call. Verified with a real cross-user test: a non-owner's chat request to a dataset they don't have access to is rejected with 403 *before* `handleUserQuery()` ever runs — the LLM never even sees the question. |
| #10 no secrets to frontend | ✅ | Password hashes are stripped in `AuthRegistry._sanitizeUser()` before any API response; JWT secret lives only in `.env`. |
| #12 no API keys in source | ✅ | `JWT_SECRET` is env-only, with a loud startup warning if left at the insecure default. |
| #27 non-negotiable rewrite discipline | ✅ | Existing route logic (upload, connections, datasets, schema, chat, tools) was extended with auth/permission checks, not rewritten from scratch — verified each route still does exactly what it did in Phases 1-5, just gated. |
| #29-30 incremental + tested | ✅ | This phase got the most adversarial testing of any so far: real multi-user isolation tests (not mocked), confirming a private dataset is genuinely invisible and inaccessible to a second user until explicitly shared, and that `read` vs `manage` permission levels are actually distinct in practice. |

## Phase 7 self-audit

| Rule | Status | Where enforced |
|---|---|---|
| #29-30 build incrementally, test each phase | ✅ | This is the phase that made all prior testing *repeatable*: the manual adversarial RBAC test from Phase 6 is now `tests/integration/rbac.test.js`, running automatically on every `npm test` rather than living only in this conversation's history. |
| #27-28 no unnecessary rewrites, inspect before changing | ✅ | The `index.js` → `app.js` split preserved every existing route/middleware exactly - `git diff`-style review shows it's a pure extraction, not a rewrite. Verified by re-running the full manual boot/HTTP checks after the split, not just trusting the refactor. |
| #32 config separate from business logic | ✅ | `NODE_ENV=test` isolates all test-run storage (`data-test/`, `uploads-test/`) from dev/prod data purely through `config/env.js` - no test-specific code paths in the actual application logic anywhere. |
| Honesty about scope/limitations (implicit throughout the spec's engineering discipline) | ✅ | `DEPLOYMENT.md` explicitly states what wasn't build-tested (Docker) and what a real production deployment still needs beyond this phase, rather than presenting Phase 7 as more finished than it is. |
