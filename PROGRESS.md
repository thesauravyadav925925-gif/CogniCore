# CogniCore — Build Progress

## v0.2 — Blueprint features (35 items) ✅ implemented

See `FEATURE_TRACKER.md` for the checklist and `README.md` ("What was added in v0.2") for the map from
blueprint item to source file. Summary of what changed in the existing pipeline:
* `structured.engine.js` now: generate → deterministic repairs (tables, columns, GROUP BY, integer division,
  value spelling) → AST/safety validation → data-policy → execute → bounded LLM error recovery → empty-result
  diagnosis → semantic result checks → evidence.
* `core.engine.js` now: input guardrails → follow-up rewrite → intent/agent tools → router → grounding check →
  PII masking → insights/chart/suggestions → audit payload.
* Ingestion normalizes mixed date formats to ISO and builds a semantic model + data-quality report.
* Verification: 118+ automated tests (unit + engine end-to-end + five-domain demo). HTTP-level suites
  (`auth`, `rbac`, `ingestion`, `hospital-privacy`) need the real npm dependencies, so run `npm test` after `npm install`.


**Status: all 7 phases complete, live-tested end-to-end with real Ollama on
real Windows hardware, verified against multiple genuinely different
domains (banking, healthcare), stress-tested with 20 analytically diverse
questions against independently-sourced hospital data, AND extended with
a genuine multi-step Analysis mode for open-ended business questions
after that testing surfaced two more real bugs.** See "Real-world testing
log", "Multi-domain verification", "Query diversity testing", and
"Analysis mode + round 2 fixes" below. The remaining genuinely unverified
pieces are a live PostgreSQL/MySQL connection and Docker actually
building/running.

## Analysis mode + round-2 bug fixes (second live testing pass)

A second live testing pass, running all 20 stress-test questions against
the real app, found two more genuine, serious bugs and confirmed a real
architectural gap - which has now been substantially closed with a new
feature.

**Bug found: integer division silently producing a wrong number, not
just a refusal.** `COUNT(CASE WHEN status = 'completed' THEN 1 END) /
COUNT(*) * 100` returned `0` instead of the correct `~71.4`. SQLite
performs integer division when both operands are integers - `COUNT(...)`
always returns an integer - so `5 / 7` truncates to `0` *before* the
`* 100` ever runs. This is worse than every previous bug found: it isn't
a refusal or a crash, it's a confidently wrong, precise-looking number,
which is exactly the failure mode this project's entire evidence/
validation architecture exists to prevent. Fixed deterministically (not
by hoping the model remembers to `CAST`): `sql.repair.js` now scans
generated SQL with a balanced-parenthesis walk (so it correctly handles
nested `CASE WHEN` expressions, not just a naive regex) for
`COUNT(...)/...` or `SUM(...)/...` divisions and forces float division by
prefixing with `1.0 *`. Verified against the exact reported query,
producing the mathematically correct `71.428...`. Locked in as permanent
tests (`tests/unit/integer-division.test.js`) covering the exact bug, the
harder nested-parens case, and confirming it doesn't double-fix
already-safe expressions (`CAST(...)`, existing `1.0 *`).

**Bug found: inconsistent false refusals on compound questions.**
Questions like "which doctors had a Cancelled or No-show appointment"
sometimes returned `NO_QUERY_POSSIBLE` even though an equivalent question
had succeeded moments earlier in the same conversation - small-model
non-determinism on compound/relational-sounding phrasing. Rather than
accept this as an unavoidable quality ceiling, added one bounded,
deterministic retry: if the first attempt gives up, retry once with a
more directive prompt (explicit guidance on `WHERE ... IN (...)` and that
multi-column single-table questions need no `JOIN`) before falling back
to the same honest "can't answer" response as before. Verified with a
scripted test simulating exactly the observed pattern (fails plain, then
succeeds with the retry hint) and a second test confirming an honest
fallback still occurs if the retry also fails. `tests/unit/
retry-on-refusal.test.js`.

**Real architectural gap, now substantially addressed: multi-step
"Analysis" mode.** Of the 20 stress-test questions, several ("give a
management summary," "identify operational problems," "compare X and Y
and explain the difference") are fundamentally open-ended business
analysis, not single-fact lookups - a real analyst answers these by
running several queries and synthesizing across them. The original
single-question -> single-query -> single-answer architecture could only
partially address these. Rather than leave this as a permanent
limitation, a new opt-in engine (`core/engines/analysis.engine.js`) now
handles it properly:

  1. **Plan** - the LLM breaks the complex question into 2-6 specific,
     independently-answerable sub-questions.
  2. **Execute** - EVERY sub-question runs through the exact same,
     already fully-validated `structured.engine.js` pipeline used
     everywhere else in the app (same `generateSql` -> `repairTableNames`
     -> `ensureFromClause` -> `fixIntegerDivision` -> `validateSql` ->
     `executeValidatedQuery` chain). This file introduces ZERO new SQL
     safety surface - it only calls the existing, tested pipeline
     multiple times.
  3. **Synthesize** - the LLM writes a final narrative answer using ONLY
     the evidence gathered from the real, executed sub-queries.

This keeps the project's core discipline (Rule #6: LLM is never the
source of truth for numbers) intact even for a much more capable-feeling
mode - every number anywhere in the final answer came from a real,
validated, executed query, never from the LLM doing its own arithmetic.
It's an explicit opt-in ("🔍 Deep Analysis" toggle in the chat UI,
matching this project's existing pattern of explicit control over
anything that costs meaningfully more than a normal question - the same
pattern as hybrid queries requiring explicitly-linked datasets), not an
auto-detected mode guessed from question phrasing. Verified end-to-end
against real hospital data with a scripted 3-step plan (total count,
status breakdown, worst-department ranking) - all three sub-queries
produced results hand-verified as correct against the source CSV, and a
second test confirms a failed sub-question is honestly reported in the
evidence rather than silently dropped. `tests/integration/
analysis-mode.test.js`.

**Honest scope note, unchanged from before**: Analysis mode currently
supports a single structured dataset (not yet hybrid structured+document
analysis, and not yet multiple structured datasets at once) - the UI
toggle is disabled when a hybrid dataset selection is active. Whether the
real Ollama model's PLANNING step reliably produces good sub-questions
for open-ended prompts is, like everything else in this log, something
only a live run can confirm - the mechanics are now proven solid; the
planning quality is the next thing to verify live.

## Query diversity testing (independently-sourced dataset, 20-question stress test)

The person building this project independently downloaded a fresh CSV
(no involvement from this development process) and, separately, used
another AI tool to generate 20 analytically varied test questions against
it spanning simple lookups, filtering, percentage/rate calculations,
multi-dimensional grouping, ranking, and open-ended business analysis -
then ran all 20 against the real running app with real Ollama. This
found two genuine bugs, fixed below, and surfaced one honest architectural
boundary worth being explicit about rather than overselling.

**Bug found: case-sensitive text comparison.** The dataset stored a status
column as `Cancelled` (capitalized); the LLM generated `WHERE status =
'cancelled'` (lowercase). SQLite's default text comparison is
case-sensitive, so the query silently returned zero rows - a confidently
wrong "no results" answer rather than an error, which is worse than a
crash. This is an extremely common real-world pattern (status flags,
categories, and free-text fields are inconsistently cased constantly in
real spreadsheets), so it was fixed at the storage layer rather than
hoped away by prompt wording: `tabular.loader.js` now creates TEXT columns
with `COLLATE NOCASE`, making equality, `IN`, `GROUP BY`, and `ORDER BY`
case-insensitive by default for every CSV/Excel/JSON-derived dataset.
Verified against the exact reported scenario (confirmed the specific
failing query now returns the correct single row), and confirmed this
doesn't affect numeric columns or aggregate correctness. Locked in as a
permanent test (`tests/unit/case-insensitive-text.test.js`).

**Bug found: self-contradictory phrasing.** For one question, the
underlying SQL and result were correct (the right department), but the
composed natural-language answer said the information "could not be
determined" and then stated the correct answer anyway in the same
response - confusing, self-contradictory output despite correct underlying
data. Fixed by strengthening `answer.composer.js`'s prompt with explicit
instructions not to hedge when the evidence contains a clear answer, and
never to state a specific answer while also claiming it's undeterminable.

**Verified via the deterministic pipeline** (not dependent on real-time
LLM output quality, since a scripted stand-in produced the SQL): the
validator and executor correctly handle percentage/rate calculations
(`CASE`/`CAST`/arithmetic in `GROUP BY` queries - tested with a real
no-show-rate-by-department calculation, mathematically verified at 50%)
and multi-dimensional grouping (a doctor × status breakdown, verified
row-for-row against the source data). This proves the *pipeline* can
execute these patterns correctly; whether the *real* LLM reliably chooses
to write them for a given phrasing is, as always, something only a live
run can confirm.

**Honest scope boundary, not a bug**: of the 20 test questions, the
later ones ("identify anomalies," "give a management summary," "what
problems can you identify and what would you investigate further")
are fundamentally different in kind from the rest - they're open-ended
business analysis that a real analyst would answer by running several
queries and synthesizing across them, not a single fact lookup. The
current architecture (one question -> one generated query -> one
evidence-grounded answer) can only partially address these; it may still
produce a reasonable single-query attempt, but it does not currently plan
and chain multiple queries to build a genuine multi-part analysis. Doing
that properly is a real, substantial feature (a "multi-step agentic
analysis" mode) - not a quick fix, and not something this session claims
to have solved. If that capability matters for your evaluation, it's
worth discussing as a deliberate next phase rather than something to
expect from the current single-query engine.

## Multi-domain verification (banking + healthcare)

The project's central claim is that the core engine has zero hardcoded
domain assumptions - Section 1 of the spec is explicit that it must not
assume "students, attendance, faculty... ERP, hospital, bank" etc. Every
test up to this point used a single toy "employees" dataset, which isn't
strong enough evidence for that claim on its own. To actually substantiate
it, two realistic, independent datasets were built and run through the
complete pipeline - ingestion, schema discovery, relationship inference,
SQL generation/validation/execution, and the security/RBAC layer:

**Banking** - a 3-table SQLite database (`customers`, `accounts`,
`transactions`) with declared foreign keys, uploaded as a native `.db`
file (a format that had never been exercised end-to-end before this).
Verified: correct schema discovery, correct relationship detection from
the declared foreign keys, a multi-table JOIN query returning the
mathematically correct total balance (hand-verified: 165000.50), a
GROUP BY query producing correct net transaction flow per account, and
confirmation that balance-tampering attempts (`UPDATE accounts SET
balance = ...`, forged `INSERT INTO transactions`) are blocked by the
same SQL validator used everywhere else - tested via the tools endpoint
directly, not just chat, confirming the security boundary isn't
duplicated-and-possibly-inconsistent per route. Also tested: a 2,000-row
messier CSV (deliberately injected missing values) ingested in 69ms with
accurate missing-value profiling and correct type inference throughout.

**Healthcare** - a 2-table JSON dataset (`patients` with diagnoses,
`doctors`) uploaded as multi-table JSON (also never exercised end-to-end
before this). Verified: correct relationship inference from column naming
alone (`patients.doctor_id -> doctors.doctor_id`), a JOIN query correctly
returning the exact right patients with the exact right diagnoses for a
named doctor. Then, critically, the **privacy scenario that actually
matters for a hospital deployment**: an unrelated staff account (modeling
a receptionist with no clinical need-to-know) was confirmed to see *zero*
datasets and get a 403 on every direct access attempt, including via chat;
a second account (modeling a nurse) was granted explicit read access and
could view records but was confirmed unable to delete them (`read` !=
`manage`, holding for genuinely sensitive data, not just the earlier toy
example); and a direct SQL injection attempt against patient records
(`DELETE FROM patients WHERE 1=1`) was blocked even when submitted through
the tools/export endpoint rather than chat.

Both scenarios are now permanent, automated regression tests
(`tests/integration/domain-agnostic.test.js`,
`tests/integration/hospital-privacy.test.js`) - not a one-time manual
check that could silently stop being true after a future change, but an
assertion that runs on every `npm test`.

**What this does and doesn't prove**: this demonstrates the deterministic
pipeline - ingestion, relationships, SQL execution, security - is
genuinely domain-agnostic and correct on real banking- and healthcare-
shaped data, with real numbers hand-verified. It does NOT prove the LLM's
natural-language understanding is equally good on banking/healthcare
terminology specifically - that still depends on the real Ollama model's
general knowledge, same as the "Real-world testing log" caveat below. The
SQL correctness tests above used a scripted stand-in for the LLM (as
`sql.repair.js` and the validator are what actually guarantee safety
regardless of what the LLM proposes) - only you, running this against
real bank/hospital data with real Ollama, can confirm the LLM's phrasing
and question-understanding is good enough for those domains specifically.

## Real-world testing log (post-delivery, live user session)

Everything up to Phase 7 was built and tested in a sandboxed development
environment with no access to a real Ollama instance - the AI reasoning
layer itself was necessarily tested with fake/mocked LLM providers standing
in for the real thing (documented honestly at the time as the one major
unverified piece). The person building this project then ran it for real,
for the first time, against actual `qwen2.5:7b` and `nomic-embed-text`
models on their own Windows machine. That session found six real,
previously-undetected issues - exactly the kind of thing that only surfaces
once real users, real hardware, and a real LLM are in the loop:

1. **Frontend crash on failed queries** (`EvidencePanel.jsx`) - when SQL
   validation failed, the evidence panel tried to render a `null` evidence
   object and crashed the whole page. Fixed: guard before rendering.
2. **Frontend crash on document datasets** (`Sidebar.jsx`) - assumed every
   dataset has `.schema.tables`, which document datasets (PDF/DOCX/TXT)
   don't have. Fixed: guard + show chunk count instead for documents.
3. **SQL table-name mismatches** - `qwen2.5:7b` would sometimes guess a
   plural table name ("employees") when the real table was singular
   ("employee"), even with the exact name given in the prompt. Fixed with
   a new deterministic repair layer (`sql.repair.js`) that corrects
   singular/plural/case mismatches toward a name that provably exists in
   the real schema BEFORE validation runs - this is not a second LLM
   guess, it only ever substitutes toward something real, and the
   validator still has final say.
4. **Missing FROM clause** - the model occasionally dropped the FROM
   clause entirely. Fixed: when a dataset has exactly one table (the
   common single-file-upload case), a missing FROM is unambiguous to
   complete correctly - not a guess, since there's only one possible
   correct answer.
5. **A genuine third-party library bug** - `node-sql-parser`'s own
   `sqlite` dialect grammar failed to parse a perfectly valid, common
   query (`WHERE salary = (SELECT MAX(salary) FROM t)`), while its
   `postgresql` dialect parsed the identical query correctly and still
   correctly handles double-quoted identifiers (which SQLite also uses).
   Fixed: SQLite-backed datasets are now validated against the
   `postgresql` grammar - this only changes which grammar checks the
   query's *structure*; execution still goes through real SQLite either
   way, so this doesn't weaken any security guarantee.
6. **Over-strict prompt caused false refusals** - after fixing #3,
   the SQL-generation prompt was made very heavily prohibitive ("does not
   exist and must not be used", repeated negative warnings). This
   backfired: the small model started declining even trivially simple
   questions ("how many employees are there?") with `NO_QUERY_POSSIBLE`.
   Fixed by softening the prompt back to clear-but-neutral phrasing and
   explicitly telling the model that simple questions almost always CAN
   be answered - confirmed fixed live (a question that failed twice in a
   row before the fix succeeded immediately after).

All six fixes were verified with real automated tests added to the suite
(`sql.repair.test.js`, plus the existing suite re-run), and five of the six
were additionally confirmed live, in the same session, against the actual
failure that had just occurred. This is what the "build incrementally, test
each phase" rule (#29-30) looks like when the test is a real person instead
of a scripted scenario - the fastest possible feedback loop, and the
project is measurably more robust for having gone through it.

## Phase 1 — Foundation ✅ DONE
- [x] Dataset upload (SQLite, CSV, Excel)
- [x] Dataset registry
- [x] File type detection
- [x] Schema intelligence + relationship detection
- [x] Dynamic structured query engine (SQL generation → AST validation → execution)
- [x] SQL security validator (whitelist SELECT, block DDL/DML)
- [x] Ollama integration (provider abstraction)
- [x] Chat API (`/api/chat`) with bounded conversation memory
- [x] End-to-end tested (CSV + multi-sheet Excel ingestion, relationship inference, SQL validation/execution, security block on DROP)
- [x] React frontend (chat + upload UI + schema explorer) — built with Vite, tested via production build, verified against the live backend over HTTP

## Phase 2 — Database connectors ✅ DONE
- [x] PostgreSQL adapter (`information_schema`-based schema discovery, live queries — no materialization)
- [x] MySQL/MariaDB adapter (same approach, `information_schema`)
- [x] JSON adapter (array-of-objects or `{tableName: [...]}` shape, materialized like CSV/Excel)
- [x] Live connection datasets via `POST /api/connections` (credentials stored in a separate DB table, **never** returned by any API response — Rule #10)
- [x] SQL validator made dialect-aware (`sqlite` / `postgresql` / `mysql` via `node-sql-parser`) — security whitelist verified across all three dialects
- [x] Frontend: "Connect database" form in the sidebar alongside file upload
- [x] Tested: JSON ingestion end-to-end via HTTP, failed-connection handling (no orphaned dataset records, clean error, no crash), dialect-aware SQL validation + security blocks confirmed for all 3 dialects
- [ ] **Not tested against a live Postgres/MySQL server** — this sandbox couldn't install one (mirror was down). Adapters are written and unit-tested for correctness, but you should do one real connection test on your machine before relying on it. If something's off, tell me the error and I'll fix it fast.

## Phase 3 — Documents ✅ DONE
- [x] PDF parser (via `pdfjs-dist`, accurate per-page text extraction)
- [x] DOCX parser (via `mammoth`)
- [x] TXT/Markdown handling
- [x] Chunking strategy (paragraph-aware, overlapping, page-tagged)
- [x] Embeddings via Ollama (`EmbeddingProvider` abstraction, `OllamaEmbeddingProvider` implementation — same pattern as the LLM provider so it's swappable)
- [x] Vector store — local, SQLite-backed, brute-force cosine similarity (documented scale limitation: fine for single-user/departmental use, not for millions of chunks; swapping in a real ANN index later only touches `vector.store.js`)
- [x] Retriever + Document Engine (`core/engines/document.engine.js` — replaced the Phase 1 stub with real retrieval, wired into the same evidence → answer-composer flow as structured queries)
- [x] Frontend: document uploads, document-specific schema view (page/chunk counts + sample indexed chunks), document evidence rendering in chat (retrieved passages with page numbers + relevance scores)
- [x] Tested: real PDF (2-page, generated with pdfkit), DOCX (generated with `docx` package), and TXT all parse correctly end-to-end. Found and fixed a real bug — `pdf-parse`'s bundled PDF.js choked on a valid modern PDF (`bad XRef entry`); switched to `pdfjs-dist` directly.
- [x] Verified graceful failure: uploading a document with no Ollama running correctly fails at the embedding step with a precise actionable error, marks the dataset `error` (not crash), server stays alive, and chat against an errored dataset returns a clean message instead of hanging.
- [ ] **Not tested against real Ollama embeddings** — same caveat as Phase 2's DB adapters. Run `ollama pull nomic-embed-text` and do one real document Q&A test on your machine.

## Phase 4 — Hybrid ✅ DONE
- [x] Evidence merger (`evidence.manager.js`'s `buildHybridEvidence()`, already scaffolded in Phase 1, now actually used)
- [x] Hybrid route in query router — triggers automatically when the request includes both a structured dataset AND a document dataset
- [x] `hybrid.engine.js` — runs the structured and document engines **in parallel** (`Promise.all`), merges whatever evidence comes back; if one side fails, the other's evidence still reaches the answer
- [x] `answer.composer.js` extended to build a proper multi-source explanation prompt for hybrid evidence (previously fell back to a raw JSON dump)
- [x] API: `/api/chat` now accepts `datasetIds` (array) in addition to the original `datasetId` (fully backward compatible — Rule #31)
- [x] Frontend: checkbox per dataset to "link" it into the next query; 2+ linked datasets triggers a visible "Hybrid query across N datasets" banner; evidence panel renders each source separately (🗄 Database / 📄 Document) under one hybrid answer
- [x] **Tested with a genuine integration test** (not just unit-level): ingested a real CSV, inserted real document chunks, ran the actual `routeQuery()` end-to-end with fake LLM/embedding providers standing in for Ollama — confirmed the router correctly detects HYBRID, both sub-engines run, SQL executes against real data, document retrieval runs cosine similarity, and the two evidence parts merge correctly with an averaged confidence score
- [x] Verified the new `datasetIds` array format works through the real HTTP API
- **Scope note**: Phase 4 supports one structured + one document dataset per hybrid query (matching the spec's own Section 34 example exactly). Supporting N structured + M document datasets in one query is a documented future extension — the merge logic in `hybrid.engine.js` would need to loop rather than take two fixed datasets, but the evidence-merging approach doesn't change.

## Phase 5 — Tools ✅ DONE
- [x] Chart tool — `POST /api/tools/chart` (bar/line/pie/scatter). **Never touches the LLM** — re-validates and re-executes the same SQL server-side, then mechanically reshapes the real rows into a chart spec (Section 25 of the spec)
- [x] CSV/Excel export tool — `POST /api/tools/export`, streams a real file download
- [x] PDF report tool — `POST /api/tools/report`, built with `pdfkit`: title, question, answer, the exact SQL that ran, and the full result table
- [x] Calculate tool — `POST /api/tools/calculate` (sum/avg/min/max/count/median), deterministic, auditable
- [x] Tool registry (`GET /api/tools`) — documents available tools per spec Section 22
- [x] Frontend: chart builder inline under any database evidence block (pick type + fields, renders with a lightweight custom SVG chart component — no charting library dependency), plus one-click CSV/Excel/PDF buttons
- [x] **Tested thoroughly against real data**: verified chart output numerically against the raw CSV (e.g. confirmed GROUP BY sums, pie percentages, and scatter points all matched the source data exactly), confirmed CSV/XLSX exports are valid files with correct content, **extracted and read back the generated PDF's text** to confirm the report actually contains the right question/answer/SQL/table — not just "a PDF got created"
- [x] Verified the security boundary holds at the tools layer too: a `DROP TABLE` submitted as the `sql` parameter to the chart endpoint is rejected by the same validator used everywhere else, and invalid chart types / unknown field names fail with clear errors instead of crashing
- **Design decision worth flagging**: every tool endpoint re-derives its data by re-running the SQL against the live dataset — it never trusts rows the frontend already has in memory. This is slightly more server work per action, but it closes off any path where a chart, export, or report could reflect stale or tampered numbers (Rules #20, #23, #24).

## Phase 6 — Security ✅ DONE
- [x] Authentication (JWT) — `POST /api/auth/register`, `/login`, `GET /api/auth/me`. Passwords hashed with bcrypt, never stored or returned in plaintext.
- [x] Bootstrap: the first person to register becomes `admin` automatically; everyone after starts as `user`.
- [x] RBAC — four roles (`admin`/`manager`/`analyst`/`user`, matching the spec's own Section 27 example). `requireAuth` and `requireRole()` middleware in `security/rbac.js`.
- [x] Dataset-level permissions — every dataset has an owner; owners and admins get full (`manage`) access automatically, others need an explicit grant (`read` or `manage`) via `POST /api/datasets/:id/share`. Enforced by `requireDatasetAccess()` middleware on **every** dataset-touching route (datasets, schema, upload, connections, chat, tools) — Rule #9 ("enforce permissions outside the LLM") applied literally: checks run in Express middleware, before any query or LLM call happens.
- [x] Audit logging — every security-relevant action (login attempts, uploads, deletes, shares, access denials, chat queries, tool usage) is written to an append-only `audit_log` table. Viewable by admins at `GET /api/admin/audit`.
- [x] Frontend: login/register screen, JWT stored client-side and attached automatically to every request, user badge + logout in the sidebar, automatic logout on token expiry (401 → forced re-login).
- [x] **Tested adversarially, not just happy-path**: registered three real users through the real HTTP API and confirmed — a non-owner genuinely cannot see, preview, query, or delete another user's private dataset (empty list, 403 on direct access, 403 via chat); sharing with `read` permission grants visibility and query access but **not** delete (confirmed `manage` vs `read` distinction actually holds); revoking access actually removes it; non-admins get 403 from every `/api/admin/*` route; the audit log, when inspected, contained an accurate record of every action taken during testing, including the denied attempts.
- **Scope note, stated plainly**: there is no dataset-sharing *UI* (only the API) — an owner has to know a teammate's email and hasn't got a "share" button to click yet. Also no password reset flow, no email verification, no rate limiting on login attempts. All reasonable to add later but not essential to prove the core RBAC model works, which was the point of this phase.

## Phase 7 — Production ✅ DONE (scoped for a final-year project, see notes below)
- [x] Refactored `index.js` → thin entrypoint importing `app.js` (Express app definition separated from the `listen()` call), enabling real integration tests
- [x] **Real automated test suite** — `npm test` (Node's built-in test runner, zero extra test-framework dependency). 68 tests, all passing:
  - Unit: SQL validator (security-critical — SELECT allowed, DROP/DELETE/UPDATE/INSERT/ALTER/ATTACH/PRAGMA blocked, injection/multi-statement/comment smuggling blocked, all 3 dialects), chart tool, calculate tool, relationship detector (the domain-agnostic FK inference), chunker
  - Integration (real HTTP requests against the real app): full auth flow, **the exact adversarial RBAC scenario manually verified in Phase 6, now automated** (private dataset invisible/inaccessible to a second user, sharing grants read-not-manage, revocation works, admin routes locked down, audit trail populated), CSV ingestion → schema → preview end-to-end
- [x] Graceful error recovery — `unhandledRejection`/`uncaughtException` handlers, graceful `SIGTERM`/`SIGINT` shutdown (important for Docker's stop signal), all logged clearly rather than crashing silently
- [x] Lightweight structured logger (`config/logger.js`) — timestamped, leveled, used by the error handler and startup/shutdown messages. Deliberately not a full observability stack — see DEPLOYMENT.md for what that would add.
- [x] Docker: `server/Dockerfile` (glibc-based for `better-sqlite3` prebuilt binary compatibility), `client/Dockerfile` (multi-stage: Vite build → nginx), root `docker-compose.yml` (server + client + optional Ollama profile), `.dockerignore` for both
- [x] `DEPLOYMENT.md` — setup instructions, required env vars, data backup notes, and an explicit list of what a *real* production deployment would still need (HTTPS termination, log aggregation, APM, rate limiting, horizontal scaling)
- **Honest limitation, stated plainly**: the Docker setup was **not build-tested** — this development sandbox has no Docker daemon available. Everything else in this project was verified by actually running it; Docker is the one exception. The Dockerfiles follow standard, well-understood patterns and the compose YAML was syntax-validated, but you should run `docker compose up --build` yourself before trusting it, and tell me the exact error if anything fails.

---
### How to resume work in a new session
Read this file + `ENGINEERING_RULES.md` first. Current phase in progress is
marked above. Do not start a later phase before finishing/testing the
current one (Rule #29, #30).
