# Convergence Audit

This directory is the working home for the repo-wide cleanup program.

## Goal
- tighten ownership of business rules
- reduce dangerous duplication
- break oversized files into navigable workflow-based modules
- keep frontend, backend host, Edge runtime, and DB-backed behavior aligned

## Current Snapshot
- Latest hotspot scan date: `2026-04-09`
- No app files currently remain in the `800+` default split bucket.
- Remaining priority hotspots are still the two runtime facades:
  - `backend/src/app/handleSupabaseRequest.mjs` (`12824`)
  - `supabase/functions/_shared/api-handler.ts` (`5654`)
- Recent cleanup progress:
  - `frontend/src/features/access/pages/AdminAccessPage.tsx` is down to `21` lines and now composes page-local modules under `pages/admin-access/`
  - `frontend/src/features/auth/AuthContext.tsx` is down to `312` lines with session helpers, action helpers, and lifecycle effects extracted
  - `frontend/src/features/inventory/components/JobEditorDialog.tsx` is down to `226` lines and now delegates to `components/job-editor/`
  - `frontend/src/features/inventory/components/BoxForm.tsx` is down to `200` lines with form state and delete-dialog orchestration moved under `components/box-form/`
  - `frontend/src/features/inventory/utils/boxHelpers.ts` is now a `13` line compatibility barrel over focused `utils/box/` modules
  - `frontend/src/features/inventory/hooks/useInventoryMutationHooks.ts` is down to `36` lines after the planning mutation split
- Current review-tier frontend hotspots are workflow files in the `500` to `600` line range, not page shells or helper barrels over `800`.

## Phase Docs
- [Phase 1 Light Pass](./phase-1-light-pass.md)
- [Phase 2 Medium Pass](./phase-2-medium-pass.md)
- [Phase 3 Deep Pass](./phase-3-deep-pass.md)

## Repeatable Baseline Scan
Run the hotspot scan from repo root:

```bash
npm --prefix backend run audit:repo:hotspots
```

The scan reports:
- app files over `500`, `800`, and `1500` lines
- large test files
- subtree totals across `frontend/src`, `backend/src`, and `supabase/functions`

## Working Rules
- behavior-preserving first
- one clear source of truth for formulas, status rules, and matching rules
- pages orchestrate, hooks fetch, domain modules own business rules
- backend host and Edge handlers stay thin and delegate
- duplication is acceptable only when runtime boundaries require it and parity checks protect it
