# DRY Audit

The repo-wide cleanup program now lives under [`docs/convergence`](./docs/convergence/README.md).

## Current Audit Home
- [Phase 1 Light Pass](./docs/convergence/phase-1-light-pass.md)
- [Phase 2 Medium Pass](./docs/convergence/phase-2-medium-pass.md)
- [Phase 3 Deep Pass](./docs/convergence/phase-3-deep-pass.md)

## Why This Moved
- the repo now needs a broader convergence program, not just a narrow DRY note
- oversized files and folder structure are now first-class audit targets
- source-of-truth ownership and parity checks are part of the same program

## Existing Low-Risk Consolidations Still Stand
- shared page-level action access checks
- shared inventory read-query option builders
- shared job cache sync and caulk invalidation helpers

## Latest Snapshot
- latest hotspot scan date: `2026-04-09`
- no app files remain in the `800+` split bucket
- remaining priority hotspots are `backend/src/app/handleSupabaseRequest.mjs` and `supabase/functions/_shared/api-handler.ts`
- `frontend/src/features/inventory/components/BoxForm.tsx` and `frontend/src/features/inventory/utils/boxHelpers.ts` are no longer in the review-tier hotspot queue after the latest frontend split
- current review-tier cleanup queue now lives in the convergence phase docs

## Repeatable Baseline Scan
Run:

```bash
npm --prefix backend run audit:repo:hotspots
```

Use that output as the current hotspot baseline before starting a new cleanup batch.
