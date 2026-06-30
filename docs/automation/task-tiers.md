# Codex Task Tiers

Use this guide after `npm --prefix backend run codex:refresh` and before choosing checks. The classifier is conservative; Codex still owns the final engineering judgment.

## Tier 0 - Docs / Tooling Only

Scope:

- Documentation, runbooks, repo tooling, safe read-only scripts, test helpers.
- No runtime app behavior.

Examples:

- `AGENTS.md`
- `docs/automation/*`
- Codex refresh/classifier/release doctor scripts

Required checks:

- `git diff --check`
- `git diff --cached --check` when staged
- `node --check` for changed Node scripts
- Targeted `node --test` for changed tooling helpers

Release expectations:

- No app deploy expected.
- No migrations.
- No DEV/PROD data mutation.

## Tier 1 - Frontend Visual / Text / Layout Only

Scope:

- CSS, copy, spacing, layout, visual component polish.
- No workflow state changes.

Examples:

- Owner Companies spacing.
- Button copy or card contrast.
- Status color polish.

Required checks:

- Targeted frontend/component tests.
- `npm --prefix frontend run test`
- `npm --prefix frontend run build`
- Browser visual check when useful.

Release expectations:

- Vercel/frontend verification on release.
- No Edge deploy or migrations unless another changed file requires them.

## Tier 2 - Frontend Workflow

Scope:

- User-facing flows, route behavior, cache invalidation, optimistic updates, client API payloads.
- May be read-only or mutation-like from the user perspective.

Examples:

- Film Order Intake created boxes.
- Scan navigation behavior.
- Job editor save payload shaping.

Required checks:

- Targeted tests for the changed workflow.
- `npm --prefix frontend run test`
- `npm --prefix frontend run build`
- Authenticated DEV browser verification for protected workflows.
- Before/after verification for mutation workflows when safe fixture data exists.

Release expectations:

- Vercel/frontend verification on release.
- Edge/API deploy only if shared API surfaces changed.

## Tier 3 - Backend / API / Local Runtime

Scope:

- Local backend services, repositories, route handlers, read models, mutation handlers.
- No Supabase Edge/shared deploy surface unless shared files also changed.

Examples:

- Local Box Details helper import fix.
- Backend read-model mapper fix.

Required checks:

- Targeted backend tests.
- `npm --prefix backend run test:unit`
- `npm --prefix backend run contract:parity` if API route contracts changed.
- Frontend checks if UI/client behavior was touched.

Release expectations:

- Local runtime smoke if backend startup or routes changed.
- Edge deploy only if Supabase shared/API code also changed.

## Tier 4 - Edge / Shared / API

Scope:

- Supabase Edge functions.
- Shared API handlers/contracts/domain route maps.
- Code used by both local backend and Edge.

Examples:

- Box Details owner mapper used by Edge/API.
- Shared route contract updates.

Required checks:

- `npm --prefix backend run edge:test`
- `npm --prefix backend run contract:parity`
- `npm --prefix backend run test:unit`
- Route smoke for new/changed API paths.
- Frontend tests/build if client calls changed.

Release expectations:

- Supabase Edge/API deploy decision required on release.
- Verify Edge `/health` build SHA after deploy.

## Tier 5 - Schema / Migration / RPC

Scope:

- `backend/migrations/**`
- `supabase/migrations/**`
- SQL/RPC/schema latest guards.

Examples:

- Inventory ownership.
- New RPC or changed RPC signature.

Required checks:

- Backend/Supabase migration mirror verification.
- Migration-specific tests.
- `npm --prefix backend run check:schema:latest`
- DEV migration apply only after guarded DEV target verification when local testing requires it.
- Route/API smoke if runtime depends on the schema.

Release expectations:

- PROD migrations only with explicit release approval.
- Confirm migration history before and after apply.
- Never use ambiguous linked Supabase mutation commands.

## Tier 6 - Material Flow / Inventory Mutation / Allocation / Check-In / Caulk Reconciliation

Scope:

- Highest-risk operational workflows.
- Any change that can alter allocations, film LF, caulk quantities, check-in/check-out, ownership, film order sync, transfer, job readiness, or reconciliation.

Examples:

- Caulk reconciliation.
- Allocation planner changes.
- Checked-out box allocatable LF.
- Film order linked-box synchronization.

Required checks:

- Read `docs/material-flow-rules.md` before implementation.
- Targeted frontend/backend/Edge/schema checks for every touched surface.
- DEV fixture creation/verification after target guard.
- Authenticated browser verification for the real user workflow when available.
- Before/after database or API state verification for mutation paths.
- Protected-state checks for unsafe/non-eligible records.

Release expectations:

- Controlled migration, Edge, and Vercel plan as applicable.
- Read-only PROD verification unless an approved safe PROD fixture mutation exists.
- Stop if the fixture path is unsafe or if behavior conflicts with material-flow rules.

## Classifier Commands

```powershell
npm --prefix backend run codex:refresh
npm --prefix backend run codex:classify -- --base origin/main --head HEAD
```

The classifier helps choose the starting tier. If a task spans multiple tiers, use the highest applicable tier.
