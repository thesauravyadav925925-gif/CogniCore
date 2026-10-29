# ERRATA — S4 Runner/Oracle Interface Defect

**Status:** Defect record. No prior S4 run produced a reconciled summary;
nothing is withdrawn.
**Date:** 2026-10-29
**Scope:** `harness/runners/s4_runner.js` — Part B purged-clone table scoping.
**Fix:** runner `34b7c6f`; run artifacts `7ad24e0`.

## 1. Defect

`snapshotTables` (s4_runner.js:275) built the Part B purged clone solely from
`tableRefs` (tables referenced by the preregistered query set). Policy-declared
tables were omitted: `declarations.fkDerivedPurges[*].table` and `[*].refTable`
(FK-derived purge for the no-tenant-key child) and `policy.rowFilters[*].table`.
The materialised purged clone therefore could not be constructed for the
declared policy surface and the runner crashed before completing any run.

## 2. Impact

Six pre-fix attempts (run dirs 2026-10-29T04-34…04-50) ended as DRY_RUN
preflight, manifest-only crashes, or one mid-run interruption (04-50: partial
`results.jsonl`, no summary). **No run ever produced a reconciled
`valid:true` summary, so no S4 result was ever quotable and nothing is
invalidated.** Preregistered totals (Part A 14, Part B 10, PREREG_S4 §6) are
unchanged by the fix, which touches runner bookkeeping only, not the
preregistered query set or oracle semantics.

## 3. Fix

`s4_runner.js:275` now unions `tableRefs` with the FK-derived purge pair
tables and every `policy.rowFilters` table before building the purged clone.

## 4. First quotable S4 baseline (post-fix)

Run: `security-eval/runs/2026-10-29T04-58-35-185Z_s4_HEAD/` at harness fix
`34b7c6f` — the only quotable S4 run; all earlier dirs are preflight or crash
attempts.

| Metric | Value |
|---|---|
| Part A evaluated | 14/14, quotable |
| Part A primary endpoint (PREREG_S4 §6, per-FD FULL_RECONSTRUCTION count) | **2**: FD-1 (`job_grade → salary_band`), FD-2 (`zip → state`) |
| FD-3 (`role_code, state → salary_tier`, chained via FD-2) | `NO_RECONSTRUCTION` — the chained arm did not reconstruct |
| Control arm | `NO_RECONSTRUCTION` — oracle discriminates; reconstruction verdicts are not artifacts |
| Part B evaluated | 10/10, quotable |
| Part B leaks | 0 |
| Part B CP(95%) zero-event upper bound | ≤ 25.8866% (n=10; exact 0.2588655508930522) |
