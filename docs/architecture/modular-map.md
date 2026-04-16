# Modular Map

This repo now uses stable facades around smaller feature and domain modules so large refactors can happen without breaking live routes or API contracts.

## Subsystems

- `shared/`
  - Cross-runtime pure domain logic used by frontend, rollback backend, and Supabase Edge.
  - Current shared contracts include allocation coverage, box search, box transfer planning, job-number search, job planning film matching, checkout semantics, and schedule payload aliases.
- `frontend/src/features/inventory/`
  - Route pages, feature hooks, TanStack Query cache helpers, and page-local workflows.
  - Public hook barrels remain stable at `hooks/useInventoryReadQueries.ts`, `hooks/useInventoryMutationHooks.ts`, and `hooks/useInventoryQueries.ts`.
- `backend/src/app/`
  - Rollback/parity host services and repositories.
  - Stable service facades remain `services/boxes.mjs`, `services/allocations.mjs`, `services/jobs.mjs`, `services/access.mjs`, `services/filmOrders.mjs`, and `services/caulk.mjs`.
- `supabase/functions/_shared/`
  - Canonical Edge handler composition, route dispatch, auth, repository access, and shared helper families.
  - Stable entrypoints remain `api-handler.ts`, `routes/readHandlers.ts`, and `routes/mutationHandlers.ts`.

## Current Structure

```text
shared/
  domain/
  checkoutSemantics.mjs
  schedulePayloadAliases.mjs

frontend/src/features/inventory/
  hooks/
    queries/
    mutations/
    useInventoryReadQueries.ts
    useInventoryMutationHooks.ts
    useInventoryQueries.ts
  cache/
    allocations/
    boxes/
    filmOrders/
    jobs/
  pages/
    allocation-job/
    allocations-page/
    box-details/
    reports/

backend/src/app/
  repositories/
    audit/
    boxes/
    inventory-records/
    jobs/
    mappers/
  services/
    runtime/
      boxes/
      checkout/
      deps/

supabase/functions/_shared/
  core/
  repositories/
  routes/
  services/
```

## Stable Facades

- Frontend route callers should keep importing inventory hooks from `frontend/src/features/inventory/hooks/useInventoryQueries.ts`.
- Frontend shared-domain callers may still use `frontend/src/domain/*`; those files are now compatibility re-exports over `shared/domain/*`.
- Backend runtime callers should keep using `backend/src/app/services/runtime/runtimeCheckoutOperations.mjs`, `runtimeBoxesMutations.mjs`, and `runtimeDeps.mjs`.
- Backend repository callers may keep using the existing top-level repository files, but grouped barrels now exist under `backend/src/app/repositories/*/index.mjs`.
- Supabase callers should keep using `supabase/functions/_shared/api-handler.ts` and the existing route handler files.

## Import Rules

- Backend and Supabase modules must never import from `frontend/`.
- Cross-runtime pure logic belongs in `shared/`.
- Frontend route files should prefer local page-model hooks and feature hook barrels over reaching into unrelated page folders.
- Backend runtime modules should import primitives and repositories through `runtimeDeps.mjs` or its grouped `runtime/deps/*` barrels.
- Supabase Edge helpers should stay transport-focused; business logic should remain in shared helpers, repositories, or RPC/database layers.

## Change Impact Map

- Boxes
  - `shared/domain/boxTransferPlanner.mjs`
  - `frontend/src/features/inventory/pages/box-details/*`
  - `frontend/src/features/inventory/cache/boxes*`
  - `backend/src/app/services/runtime/boxes/*`
  - `backend/src/app/repositories/boxes/*`
  - `supabase/functions/_shared/repositories/*`
- Allocations
  - `shared/domain/allocationCoverageContract.mjs`
  - `frontend/src/features/inventory/cache/allocations*`
  - `frontend/src/features/inventory/pages/allocation-job/*`
  - `backend/src/app/services/runtime/checkout/*`
  - `backend/src/app/services/allocations.mjs`
  - `supabase/functions/_shared/routes/*`
- Jobs
  - `frontend/src/features/inventory/hooks/queries/jobQueries.ts`
  - `frontend/src/features/inventory/pages/allocation-job/*`
  - `frontend/src/features/inventory/pages/allocations-page/*`
  - `backend/src/app/repositories/jobs/*`
  - `backend/src/app/services/jobs.mjs`
  - `supabase/functions/_shared/services/*`
- Film Orders
  - `frontend/src/features/inventory/cache/filmOrders*`
  - `frontend/src/features/inventory/pages/allocation-job/*`
  - `backend/src/app/services/allocations.mjs`
  - `backend/src/app/repositories/inventory-records/*`
  - `supabase/functions/_shared/repositories/*`
- Caulk
  - `frontend/src/features/inventory/pages/allocation-job/*`
  - `backend/src/app/services/caulk.mjs`
  - `backend/src/app/repositories/jobs/*`
  - `supabase/functions/_shared/services/*`
- Access
  - `frontend/src/features/access/`
  - `backend/src/app/services/access.mjs`
  - `supabase/functions/_shared/acl.ts`
  - `supabase/functions/_shared/auth.ts`
- Reports
  - `frontend/src/features/inventory/pages/reports/*`
  - `backend/src/app/services/jobs.mjs`
  - `supabase/functions/_shared/routes/readHandlers.ts`

## Verification Expectations

- Frontend: `npm --prefix frontend run build` and `npm --prefix frontend run test`
- Backend: `npm --prefix backend run test:unit` and `npm --prefix backend run verify:internal-exports`
- Smoke or live parity checks when configured:
  - `npm --prefix backend run smoke:routes`
  - `npm --prefix backend run verify:edge:live`

The goal of this map is traceability: when one domain changes, the connected files above should be the first places inspected.
