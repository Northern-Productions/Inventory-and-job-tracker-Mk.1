# DEV Performance Timing Audit Implementation Plan

## 1. Summary

Implement a DEV-only performance audit that gathers timing evidence without changing app behavior. The audit answers what is slow, why it is likely slow, how slow is acceptable, which future fix is safest to try first, and how a future fix can be proven.

This pass implements the written plan, helper library, runner, tests, preflight, read-only timing, and safe read-only concurrency. Mutation audit support may be implemented behind strict gates, but mutation timing must not be executed in this pass.

No performance fixes, route behavior changes, response-shape changes, query rewrites, transaction changes, planner-scope changes, indexes, schema changes, migrations, deployments, PROD access, or PROD mutations are included.

## 2. Safety Checklist And Go/No-Go Gates

- Use `backend/.env.dev`.
- Required DEV project ref: `uxiltcpbhthhinonttrc`.
- Hard reject PROD project ref: `tiwpulgvxtwlmqdnyuzd`.
- `backend/.env` may exist, but must not point to PROD.
- Reject any loaded or checked env file containing the PROD ref.
- `.secrets/smoke-user-token.txt` must exist, be gitignored, and be untracked.
- Never print tokens, auth headers, raw sensitive request bodies, secret env values, or sensitive query params.
- Verify `/auth/v1/user` before timing.
- Verify `GET /auth/context` before timing.
- Token must resolve to an approved DEV user. Permission-depth checks are optional/partial if fields are unavailable; do not fail the audit only because deeper permission interpretation is unavailable.
- Capture git status before and after. Dirty files are allowed only for the audit plan, runner, helper, tests, report, and package files if absolutely needed.
- Stop immediately on DEV ref failure, PROD ref detection, missing/tracked/not-ignored token file, auth failure, or report write failure.

Go/no-go gates:

| Gate | Required result | If failed |
|---|---|---|
| Safety preflight | DEV env, token file, auth, permissions, git status pass | Stop, write partial report if safe |
| Read-only audit | Safety/auth still valid | Continue to optional concurrency |
| Read-only concurrency | Only safe read endpoints | Skip if unstable |
| Mutation audit | Explicit flags, read-only safety passed, artifact caps OK | Not executed in this pass |
| Cleanup | Exact `run_id`, route-specific, reviewed safe path only | Otherwise report artifacts and leave them |

## 3. Performance Budgets

Every measured duration maps to exactly one severity.

| Category | Good | Warning | Bad | Critical / High-Risk |
|---|---:|---:|---:|---:|
| Auth/context | <250ms | 250-500ms | 500-1000ms | >=1000ms or auth timeout |
| Simple list/search | <500ms | 500-1500ms | 1500-3000ms | >=3000ms or timeout |
| Complex job/detail | <800ms | 800-2000ms | 2000-5000ms | >=5000ms or timeout |
| Reports/summary | <1000ms | 1000-3000ms | 3000-8000ms | >=8000ms or timeout |
| General mutations | <1000ms | 1000-3000ms | 3000-10000ms | >=10000ms or timeout |
| /jobs/complete | <1500ms | 1500-5000ms | 5000-15000ms | >=15000ms, statement timeout, or 30s transaction risk |

Timeout, auth timeout, statement timeout, or 30-second transaction risk always classifies as critical regardless of measured duration.

## 4. Methodology

- Warmup: `1-3` runs per route, excluded from measured stats.
- Normal read-only routes: at least `10` measured runs.
- Read-only hot paths: at least `20` measured runs where safe.
- Mutation workflows: `3-5` controlled measured workflow runs by default, but mutation timing is not executed in this pass.
- Do not require 20 mutation runs for one-time workflows like `/jobs/complete`.
- Safety takes priority over statistical volume.
- Use nearest-rank percentiles consistently.
- Report min, p50, p75, p95, max, mean, standard deviation, timeout count, and failure count.
- For fewer than 20 measured samples, p95 may be reported but must be marked `low_confidence`.
- For 10-sample routes, p50, p75, and max are primary.
- Separate cold, warmup, warm-cache measured, and concurrency timings.

## 5. Test Data Selection

Select stable DEV inputs without mutation:

- one simple active job
- one complex active job
- one completed job
- one job with allocations
- one job with film order/box relationships
- one safe box for detail/history/allocation reads
- one common sanitized box search term with many matches
- one rare sanitized box search term with few matches
- one no-match sanitized search term
- reports date/window filters where applicable

Record selected job numbers only where needed for repeatability, plus sanitized terms, filters, limits, row counts, and confidence. If suitable DEV data does not exist, mark affected routes skipped or `low_confidence`; do not fake confidence.

## 6. Layered Timing Breakdown

Record where safely measurable:

- browser/page navigation duration
- frontend route load duration
- API/backend call count per page
- total network time
- slowest API call
- duplicate calls
- repeated `/auth/context` calls
- backend handler duration
- RPC/function duration where directly measurable
- DB/query/function duration where safely measurable
- serialization/payload size
- response payload bytes
- returned row count

Every timing value must include `measurementType: measured | estimated | unavailable`. Do not infer backend/RPC/DB sub-timings from total request duration.

## 7. Route Coverage Matrix

| Feature | Frontend route | Backend routes |
|---|---|---|
| Auth | app boot | `/auth/v1/user`, `GET /auth/context` |
| Jobs list | `#/allocations` | `GET /jobs/list`, `/jobs/search`, `/jobs/calendar` |
| Job detail | `#/allocations/:jobNumber` | `GET /jobs/get`, `GET /allocations/by-job` if present |
| Job create/update | dialogs/detail | `POST /jobs/create`, `POST /jobs/update` |
| Auto allocation | allocation dialog | `GET /allocations/preview`, `POST /allocations/apply` |
| Checkout/checkin | job/box detail | `POST /jobs/checkout-all`, `POST /boxes/set-status` |
| Inventory | `#/`, `#/inventory/:boxId` | `GET /boxes/search`, `/boxes/get`, audit/allocation/roll-history by box |
| Add box | `#/inventory/add` | `POST /boxes/add` |
| Film orders | `#/film-orders` | `GET /film-orders/list`, `/film-data/catalog`, `POST /film-orders/create` |
| Receive film | box receive flow | `POST /boxes/receive` |
| Reports | `#/reports` | `GET /reports/summary`, owner asset report if authorized |
| Admin | `#/admin/access` | admin access/username/permission reads |

## 8. Route-Specific Hypotheses

- `/jobs/list`: full-org aggregation or excessive joins may be slow.
- `/jobs/search`: broad search, insufficient indexes, or large payloads may be slow.
- `/jobs/get`: job detail pooled reads and nested payload assembly may be expensive.
- `/jobs/complete`: completion plus detail reload plus org-wide `app_api.reconcile_auto_planned_allocations({})` inside the transaction may cause timeout.
- `/boxes/search`: broad search and large response payloads may be slow.
- `/reports/summary`: wide aggregation may be expensive.
- allocation preview/apply: planning/reconciliation may scan too broadly or repeat work.

Each hypothesis must collect evidence before recommending fixes.

## 9. /jobs/complete Required Sub-Timings

For future tagged DEV mutation runs, record where safely measurable:

- total route duration
- `completeJob` duration
- active allocation cancellation duration
- film order cancellation duration
- job detail reload duration
- `app_api.reconcile_auto_planned_allocations` duration
- transaction duration if measurable
- timeout and statement-timeout behavior
- affected allocation count
- affected film order count
- job number
- created/affected tagged IDs
- planner scope indicator, especially org-wide scope
- active job count at planner run
- candidate box/allocation counts where safe

In this pass, do not edit app routes for instrumentation. If sub-timings are not externally visible, mark them unavailable and recommend future DEV-only instrumentation. Do not alter route behavior, response shape, query logic, transaction semantics, or planner scope.

## 10. Payload And API Call Analysis

For slow routes, inspect payload bytes, returned row count, whether list/search routes return detail-level data, pagination/limit behavior, large nested objects, duplicated objects, frontend data requested but unused, repeated or serial frontend calls, repeated `/auth/context` calls, and duplicate identical calls.

Report total API calls, total network time, slowest call, duplicate calls, auth/context count, serial chains, and future parallelization opportunities. Do not optimize in this task.

## 11. Read-Only Concurrency Checks

Run only after normal read-only timing passes.

- baseline: `1` request
- small concurrency: `3` concurrent requests
- optional safe concurrency: `5` concurrent requests

Allowed routes: `/auth/context`, `/jobs/list`, `/jobs/search`, `/boxes/search`, `/film-orders/list`, `/reports/summary`, and `/jobs/get` for existing read-only jobs. Never run mutation concurrency tests.

## 12. Mutation Safety And DEV Artifact Handling

Mutation audit support requires `--include-dev-mutations`, exact `--confirm-dev-mutation RUN_DEV_PERF_TIMING_AUDIT`, passing preflight, passing read-only safety, confirmed DEV, required permissions, acceptable artifact counts, and no PROD ref.

Use `run_id = PERF_TIMING_<timestamp>_<rand>` and attach it to every created artifact through safe fields. Caps: boxes `10`, jobs `10`, film orders `10`, allocations only as needed for tagged jobs.

Before mutation, pre-check existing `PERF_TIMING_%` artifacts and warn if old artifacts exceed `25` jobs/boxes/orders. On first failed mutation, stop, write partial report, include `run_id` and created IDs, do not retry, and do not broad-cleanup. Cleanup is allowed only when route-specific, verified safe, and exact-run-id scoped.

Mutation timing must not be executed in this pass.

## 13. Database Investigation

DB inspection is optional and read-only. If safe credentials, route context, or response fields are unavailable, mark DB sections partial/unavailable with a clear reason; do not fail the full audit only for that.

Collect where safely possible:

- table row counts
- approximate table sizes
- index list and index sizes
- critical function definitions/checksums
- route-to-SQL/RPC mapping
- safe SELECT-only query plans
- candidate missing indexes as recommendations only
- statement timeout settings if visible

Inspect `buildJobsList`, broad jobs/inventory reads, job detail pooled reads, `/boxes/search`, `/reports/summary`, `app_api.reconcile_auto_planned_allocations`, planner temp table/function shape, and indexes for jobs, boxes, allocations, requirements, film orders, roll history, and caulk tables.

Use the same DEV user/org context as the app route whenever possible. If direct DB metadata is service-role-only or otherwise not representative, mark it `metadata_only`.

Rules: `EXPLAIN` only on safe SELECT statements; no `EXPLAIN ANALYZE` on UPDATE, INSERT, DELETE, RPCs, or mutating functions; no SQL changes, migrations, indexes, or schema changes.

## 14. DEV-vs-PROD Realism Warning

DEV results do not prove PROD performance unless DEV matches PROD schema, functions, indexes, data volume, table bloat, compute tier, statement timeout settings, and concurrency.

No PROD access or PROD mutation is included. If PROD risk must be assessed later, create a separate production-safe metadata/log-only plan covering row counts, table sizes, index coverage, function checksums, timeout logs, statement timeout settings, and slow-query evidence if available.

## 15. Report Sanitization

Never include auth tokens, auth headers, raw sensitive request bodies, secret env values, sensitive query params, or unapproved customer names.

Allowed fields include route names, HTTP methods, sanitized request shape, timing values, payload sizes, row counts, `run_id`, DEV artifact IDs where needed, and sanitized job numbers where needed for repeatability.

Sanitization tests must validate that reports do not leak token-like strings or secret env values.

## 16. Measured-Versus-Estimated Timing Rules

Every timing field must be labeled:

- `measured`: directly measured by the runner or safe instrumentation.
- `estimated`: derived from explicit safe approximation and clearly marked.
- `unavailable`: not exposed safely.

Do not infer RPC/DB sub-timings from total duration. If unavailable, say unavailable and explain why.

## 17. Audit Success, Partial Success, And Failure Criteria

Full success:

- safety/auth preflight passes
- report written
- no secrets in logs/report
- measured routes include sample counts and stats
- failures/timeouts recorded
- DEV artifacts inventoried if mutations ran
- git status before/after captured
- recommendations separate evidence from hypotheses

Partial success:

- mutation timing skipped
- browser tooling unavailable
- DB inspection incomplete
- suitable DEV data missing
- some routes skipped with reasons
- read-only audit completed but mutation audit not run

Failure:

- DEV safety validation fails
- auth validation fails
- token file missing/tracked/not gitignored
- PROD ref detected
- report cannot be written
- mutation phase fails before partial report can be written
- secrets appear in logs/report

## 18. JSON Report Schema

Write to `backend/migration-dry-runs/performance/dev-timing-audit.json`.

Top-level fields:

- `metadata`
- `executiveSummary`
- `safety`
- `performanceBudgets`
- `methodology`
- `testDataSelection`
- `routeMap`
- `readOnlyTimings`
- `mutationTimings`
- `statisticalSummary`
- `payloadAnalysis`
- `frontendRouteAnalysis`
- `apiCallCounts`
- `dbInvestigation`
- `queryPlanFindings`
- `rankings`
- `recommendations`
- `fixQueue`
- `beforeAfterComparisonSupport`
- `created`
- `cleanupStatus`
- `prodRealismWarning`
- `reportSanitization`
- `timingMeasurementTypes`
- `auditOutcome`
- `gitStatus`

`metadata` includes report ID, generated time, environment, expected/rejected refs, org ID, Node version, script version or git commit, run mode, and mutation `runId` if enabled.

Each timing sample includes feature, route, method, sanitized request shape, status, duration, measurement type, payload bytes, row count, timeout flags, sanitized error, warning count, run index, warmup/cold flags, concurrency mode, severity, p95 confidence, created IDs, and cleanup status.

`executiveSummary` includes top bottlenecks, highest-risk route, fastest low-risk future fix candidate, likely causes, PROD timeout risk, confidence, next investigation step, and audit outcome.

`fixQueue` items include priority, route, evidence, suspected cause, recommended future change, risk level, expected impact, validation test, and confidence.

`beforeAfterComparisonSupport` includes baseline path/report ID, route key, before/after duration fields, improvement percentage, regressions, timeout changes, payload changes, API call count changes, and p50/p95/max deltas.

## 19. Implementation Files And Tests

Add or update:

- `docs/performance/dev-timing-audit-plan.md`
- `backend/scripts/dev-timing-audit.mjs`
- `backend/scripts/lib/dev-timing-audit-helpers.mjs`
- `backend/scripts/lib/dev-timing-audit-helpers.test.mjs`
- `backend/migration-dry-runs/performance/dev-timing-audit.json`

Validate with:

- `node --check backend/scripts/dev-timing-audit.mjs`
- `node --test backend/scripts/lib/dev-timing-audit-helpers.test.mjs`

Run broader backend tests only if shared utilities are modified.

## 20. Execution Order

After implementation and tests pass:

1. Run preflight only.
2. If preflight passes, run read-only timing.
3. If read-only passes and routes are safe, run controlled read-only concurrency.
4. Do not run mutation timing in this pass.

Preflight command:

```bash
node backend/scripts/dev-timing-audit.mjs --env backend/.env.dev --expected-project-ref uxiltcpbhthhinonttrc --reject-project-ref tiwpulgvxtwlmqdnyuzd --org-id ecf4f1c5-f153-4072-b814-18a41c52fcdc --auth-token-file .secrets/smoke-user-token.txt --out backend/migration-dry-runs/performance/dev-timing-audit.json --preflight-only
```

Read-only command:

```bash
node backend/scripts/dev-timing-audit.mjs --env backend/.env.dev --expected-project-ref uxiltcpbhthhinonttrc --reject-project-ref tiwpulgvxtwlmqdnyuzd --org-id ecf4f1c5-f153-4072-b814-18a41c52fcdc --auth-token-file .secrets/smoke-user-token.txt --out backend/migration-dry-runs/performance/dev-timing-audit.json --read-only --warmup-runs 2 --normal-read-runs 10 --hot-read-runs 20 --timeout-ms 30000
```

Do not pass `--include-dev-mutations` in this pass.

## 21. Final Deliverables

Return files changed, tests run/results, preflight result, read-only audit result, controlled concurrency result, confirmation that mutation support was implemented but mutation timing was not executed, report path, top bottlenecks, highest-risk route, `/jobs/complete` evidence or unavailable sub-timing explanation, fastest low-risk future fix candidate, skipped routes/reasons, DEV artifacts created, cleanup status, git status before/after, and explicit confirmation that no forbidden actions were performed.

## 22. Not Included In This Audit

Do not include performance fixes, query rewrites, route behavior changes, planner behavior changes, schema changes, migrations, indexes, frontend optimizations, deployments, PROD access, PROD mutation, mutation concurrency tests, or broad automatic cleanup.

The audit stops after evidence gathering and recommendations.
