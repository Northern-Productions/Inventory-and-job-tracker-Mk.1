# Phase 2 Medium Pass

## Summary
- Phase 2 turns the light-pass findings into decision-complete refactor batches.
- Every batch is behavior-preserving, source-of-truth oriented, and tied to parity checks.
- The main objective is to replace oversized mixed-responsibility files with workflow-based modules that are easy to search, test, and reason about.

## Current Batch Status (`2026-04-09`)
- Batch 3: substantially complete for the current frontend cleanup pass. Cache helpers were split out and the planning mutation barrel was removed.
- Batch 4: substantially complete. `AllocationJobPage.tsx` is now a `515` line review-tier shell supported by `pages/allocation-job/` workflow hooks and sections.
- Batch 5: substantially complete. `BoxDetailsPage.tsx` decomposition landed, `BoxForm.tsx` is down to `200` lines, and `boxHelpers.ts` is now a `13` line compatibility barrel over focused `utils/box/` modules.
- Batch 6: actively in progress and materially reduced.
  - `AdminAccessPage.tsx` is now a `21` line shell driven by `admin-access/useAdminAccessPage.ts`
  - `AuthContext.tsx` is now `312` lines with extracted session, error, access, action, and lifecycle helpers
- Batch 7: in progress. `frontend/src/domain/inventory/` exists and the compatibility surface is still being cleaned up around it.
- Current highest-value non-runtime review targets are:
  - `supabase/functions/_shared/repositories/inventoryRepositories.ts`
  - `frontend/src/features/inventory/utils/jobCalendar.ts`
  - `frontend/src/features/inventory/pages/ReportsPage.tsx`
  - `frontend/src/features/inventory/cache/filmOrders.ts`
  - `frontend/src/features/inventory/pages/AllocationJobPage.tsx`
  - `frontend/src/features/inventory/cache/allocations.ts`
  - `frontend/src/features/inventory/components/AllocateDialog.tsx`
  - `frontend/src/features/inventory/components/JobsCalendarView.tsx`
  - `frontend/src/features/inventory/pages/allocation-job/useCaulkWorkflow.ts`

## Batch 1 - Backend Host Facade Decomposition

### Target
- `backend/src/app/handleSupabaseRequest.mjs` becomes an entrypoint and dispatcher only.

### Structure
- Create feature-family folders under `backend/src/app/`:
  - `shared/` for validators, coercion, formatting, ID helpers, and response helpers
  - `jobs/` for summary builders, status helpers, search, staging, and serializers
  - `allocations/` for preview/apply/remove flows and suggestion planning
  - `boxes/` for box CRUD, status, roll tracking, and transfer orchestration
  - `caulk/` for caulk requirements, allocations, and checkout/checkin flows
  - `reports/` for report assembly only
- Keep DB client wiring and top-level route branching in `handleSupabaseRequest.mjs`.

### Ownership Rules
- Runtime-neutral formulas and matchers stay in shared domain modules.
- Backend-only DB orchestration and row mapping move into feature modules.
- No feature module should parse unrelated request payloads.

### Required Verification
- `backend npm run contract:parity`
- `backend npm run check:schema:0006`
- route smoke checks for jobs, boxes, allocations, transfers, and caulk

## Batch 2 - Edge Handler Decomposition

### Target
- `supabase/functions/_shared/api-handler.ts` becomes a thin Deno entrypoint.

### Structure
- Expand the existing `_shared/routes`, `_shared/services`, and `_shared/repositories` layout:
  - move jobs list/detail/search builders into `_shared/services/jobs/`
  - move allocation preview/apply helpers into `_shared/services/allocations/`
  - move box/edit/transfer flows into `_shared/services/boxes/`
  - keep repositories responsible for DB row access and mapping only
- Entry handler keeps auth resolution, request dispatch, and cache plumbing.

### Ownership Rules
- Edge services own behavior, repositories own data access, routes own parameter handling.
- Match backend feature-family file names where the behavior is mirrored, so parity diffing is easier.

### Required Verification
- Deno checks for Edge entrypoints
- `backend npm run contract:parity`
- backend-vs-Edge parity checks on jobs, allocations, and transfer flows

## Batch 3 - Inventory Mutation And Cache Split

### Target
- `frontend/src/features/inventory/hooks/inventoryMutationUtils.ts`
- `frontend/src/features/inventory/hooks/useInventoryMutationHooks.ts`

### Structure
- Add a workflow-based cache layer under `frontend/src/features/inventory/`:
  - `cache/snapshots.ts`
  - `cache/jobs.ts`
  - `cache/boxes.ts`
  - `cache/allocations.ts`
  - `cache/filmOrders.ts`
  - `cache/caulk.ts`
  - `cache/offlineInventory.ts`
- Keep mutation hooks in `hooks/`, but make them compose cache helpers instead of embedding cache math directly.

### Ownership Rules
- Query keys and invalidation stay close to hooks.
- Business math and matching rules stay in domain modules.
- Cache helpers may transform cached shapes, but they may not become a second source of truth for business rules.

### Required Verification
- mutation hook tests
- list/detail cache sync regressions
- preview/apply parity regressions

## Batch 4 - Allocation Job Page Decomposition

### Target
- `frontend/src/features/inventory/pages/AllocationJobPage.tsx`
- `frontend/src/features/inventory/components/JobAllocateDialog.tsx`

### Structure
- Create `frontend/src/features/inventory/pages/allocation-job/`:
  - `AllocationJobPage.tsx` as the shell
  - `JobOverviewCard.tsx`
  - `FilmRequirementsSection.tsx`
  - `AllocatedBoxesSection.tsx`
  - `CaulkRequirementsSection.tsx`
  - `CaulkAllocationsSection.tsx`
  - `CaulkCheckoutCyclesSection.tsx`
  - `FilmTransferAlertsPanel.tsx`
  - `useAllocationJobActions.ts`
  - `formatting.ts`
- Move allocation-modal-specific planning and source-selection helpers next to the modal, not into the page shell.

### Ownership Rules
- Page shell owns route params, high-level queries, and dialog state.
- Sections own rendering only.
- Action hooks own orchestration for job mutations and staging/checkout flows.

### Required Verification
- `AllocationJobPage.test.tsx`
- `JobAllocateDialog.test.tsx`
- allocation preview/apply smoke flows

## Batch 5 - Box Detail And Edit Decomposition

### Target
- `frontend/src/features/inventory/pages/BoxDetailsPage.tsx`
- `frontend/src/features/inventory/components/BoxForm.tsx`
- `frontend/src/features/inventory/utils/boxHelpers.ts`

### Structure
- Create `frontend/src/features/inventory/pages/box-details/` with a shell plus detail sections.
- Split `BoxForm.tsx` into form sections:
  - identity and stock
  - dates and costing
  - roll tracking
  - notes and audit context
- Move non-UI transformation logic out of `boxHelpers.ts` into narrower modules such as `boxParsing.ts`, `boxRollTracking.ts`, `boxStatusRules.ts`, and `boxWarnings.ts`.

### Ownership Rules
- Form components render and collect input.
- Parsing, derived roll math, and warning decisions live outside the component tree.

### Required Verification
- `BoxDetailsPage.test.tsx`
- `BoxForm.test.tsx`
- parser and warning tests

## Batch 6 - Auth And Access Decomposition

### Target
- `frontend/src/features/auth/AuthContext.tsx`
- `frontend/src/features/access/pages/AdminAccessPage.tsx`

### Structure
- Split auth provider responsibilities into:
  - session lifecycle
  - access-context refresh
  - password recovery
  - query-cache reset on auth scope changes
- `AdminAccessPage.tsx` becomes a page shell with smaller review/request sections.

### Ownership Rules
- Auth provider coordinates state and exports a stable context.
- Side-effectful session observers and cache resets should live in dedicated helper modules.

### Required Verification
- auth cache-boundary tests
- access review page tests

## Batch 7 - Domain Inventory Breakup

### Target
- `frontend/src/domain/inventory.ts`

### Structure
- Convert `frontend/src/domain/inventory.ts` into `frontend/src/domain/inventory/` with stable re-exports:
  - `warehouses.ts`
  - `boxes.ts`
  - `jobs.ts`
  - `allocations.ts`
  - `filmOrders.ts`
  - `transfers.ts`
  - `audit.ts`
  - `caulk.ts`
  - `index.ts`

### Ownership Rules
- Keep public import surface stable through `frontend/src/domain/index.ts`.
- Type ownership follows workflow boundaries, not one giant domain file.

### Required Verification
- TypeScript build
- client tests
- domain matcher and payload tests

## Large Test Decomposition Rule
- Whenever a production file is split, split its giant test file in the same batch.
- Favor one test file per behavior seam rather than one giant catch-all spec.
- `inventoryMutationUtils.test.ts` and `AllocationJobPage.test.tsx` are mandatory early splits.
