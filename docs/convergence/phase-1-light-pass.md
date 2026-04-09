# Phase 1 Light Pass

## Summary
- Scope audited: `frontend/src`, `backend/src`, and `supabase/functions`.
- Current repo weight is concentrated in inventory workflows, backend and Edge request facades, and optimistic cache orchestration.
- The audit focus is not only duplication. It also covers oversized files, weak module boundaries, and folder structure that makes bug tracing slower than it should be.

## Progress Since Initial Baseline
- `frontend/src/features/access/pages/AdminAccessPage.tsx`: `878` -> `21` lines
- `frontend/src/features/auth/AuthContext.tsx`: `791` -> `312` lines
- `frontend/src/features/inventory/components/JobEditorDialog.tsx`: `919` -> `226` lines
- `frontend/src/features/inventory/components/BoxForm.tsx`: `777` -> `200` lines
- `frontend/src/features/inventory/utils/boxHelpers.ts`: `676` -> `13` lines
- `frontend/src/features/inventory/hooks/useInventoryMutationHooks.ts`: `1684` -> `36` lines
- `frontend/src/features/inventory/pages/AllocationJobPage.tsx`: `2964` -> `536` lines
- The repo currently has no app files left in the `800+` default split bucket.

## Latest Hotspot Snapshot (`2026-04-09`)

### Priority App Files
- `backend/src/app/handleSupabaseRequest.mjs` (`12824`)
- `supabase/functions/_shared/api-handler.ts` (`5654`)

### Default Split Candidates
- none

### Review App Files
- `supabase/functions/_shared/repositories/inventoryRepositories.ts` (`600`)
- `frontend/src/features/inventory/utils/jobCalendar.ts` (`565`)
- `frontend/src/features/inventory/pages/ReportsPage.tsx` (`543`)
- `frontend/src/features/inventory/cache/filmOrders.ts` (`541`)
- `frontend/src/features/inventory/pages/AllocationJobPage.tsx` (`536`)
- `frontend/src/features/inventory/components/AllocateDialog.tsx` (`534`)
- `frontend/src/components/AppLayout.tsx` (`524`)
- `frontend/src/features/inventory/cache/allocations.ts` (`511`)
- `frontend/src/features/inventory/components/JobsCalendarView.tsx` (`507`)
- `frontend/src/features/inventory/pages/allocation-job/useCaulkWorkflow.ts` (`500`)

## Subsystem Map

| Subsystem | Main Paths | Current Source Of Truth | Notes |
| --- | --- | --- | --- |
| Auth and access | `frontend/src/features/auth`, `frontend/src/features/access`, `frontend/src/api/features/authClient.ts`, `supabase/functions/_shared/auth.ts` | Frontend auth session lives in `AuthContext.tsx`; effective access is fetched from API | Good boundary, but `AuthContext.tsx` is carrying session lifecycle, recovery flow, access refresh, and query reset in one file |
| Jobs and allocations | `frontend/src/features/inventory/pages/AllocationsPage.tsx`, `AllocationJobPage.tsx`, `JobAllocateDialog.tsx`, backend and Edge `buildJobsList` and `buildJobDetail` | Job status and summary are built in backend host and Edge mirrors; frontend should consume them | Highest business-risk surface because list/detail, preview/apply, and cache hydration all meet here |
| Boxes and transfers | `frontend/src/features/inventory/pages/BoxDetailsPage.tsx`, `components/BoxForm.tsx`, backend and Edge mutation flows | Runtime payload contracts in `frontend/src/domain/inventory.ts`; backend and Edge apply the rules | Box detail/edit/transfer history is functionally rich and currently page-heavy |
| Search and normalization | `frontend/src/domain/boxSearchMatcher.mjs`, `jobPlanningFilmMatcher.mjs`, `jobNumberSearchMatcher.mjs` | Shared domain matchers already act as the primary source of truth | This is a strong pattern that should expand, not regress |
| Coverage math | `frontend/src/domain/allocationCoverageContract.mjs` | Shared contract module | Already centralized and mirrored correctly across frontend, backend host, and Edge runtime |
| Offline and PWA | `frontend/src/lib/offlineInventory.ts`, `frontend/src/features/pwa`, `frontend/vite.config.ts` | Offline filtering uses shared matchers but still carries extra filtering and ordering logic locally | Needs parity attention with live search plus cleaner ownership boundaries |
| Backend host facade | `backend/src/app/handleSupabaseRequest.mjs` | Single oversized request handler file | Biggest navigability and ownership problem in the repo |
| Edge runtime facade | `supabase/functions/_shared/api-handler.ts` | Single oversized Deno handler file plus partial route extraction | Better subfolder shape than backend host, but too much business logic still lives in the handler |
| Shared route contract | `frontend/src/domain/runtimeContract.mjs` | Shared route map and feature or owner routing metadata | Good source of truth; should stay central |
| Migration-backed behavior | `backend/migrations`, `supabase/migrations` | Append-only DB behavior changes mirrored in both trees | Intentional duplication that should stay synchronized, not be deduplicated away |

## Source-Of-Truth Matrix

| Rule Family | Source Of Truth | Downstream Mirrors / Consumers | Audit Verdict |
| --- | --- | --- | --- |
| Route contracts and feature access | `frontend/src/domain/runtimeContract.mjs` | backend config, Edge ACL, client route helpers, parity scripts | Keep central |
| Allocation coverage math | `frontend/src/domain/allocationCoverageContract.mjs` | allocation dialogs, cache patchers, backend host, Edge runtime | Keep central |
| Box search matching | `frontend/src/domain/boxSearchMatcher.mjs` | offline inventory, search suggestions, backend host, Edge runtime | Keep central |
| Job film matching | `frontend/src/domain/jobPlanningFilmMatcher.mjs` | allocation matching, preview/apply, SQL parity verification | Keep central |
| Job-number matching | `frontend/src/domain/jobNumberSearchMatcher.mjs` | job list sort/search, backend host, Edge runtime | Keep central |
| Job status and summary building | mirrored `buildJobsList` and `buildJobDetail` in backend host and Edge handler | jobs list, job detail, calendar, mutations, staging | Consolidate structure, keep runtime-safe parity |
| Optimistic cache patching | `frontend/src/features/inventory/hooks/inventoryMutationUtils.ts` | mutation hooks, read-side cache sync, list/detail hydration | Split by workflow and cache target |
| Offline snapshot filtering | `frontend/src/lib/offlineInventory.ts` | inventory pages, reports, search suggestions | Split local storage concerns from filter and rank concerns |
| Auth session and cache boundary | `frontend/src/features/auth/AuthContext.tsx` | all feature screens | Split lifecycle, access refresh, and cache reset responsibilities |

## Initial Baseline Oversized-File Ledger

### Priority Decomposition Targets (`>= 1500` lines)
- `backend/src/app/handleSupabaseRequest.mjs` (`12751`)
- `supabase/functions/_shared/api-handler.ts` (`5577`)
- `frontend/src/features/inventory/pages/AllocationJobPage.tsx` (`2964`)
- `frontend/src/features/inventory/hooks/inventoryMutationUtils.ts` (`2330`)
- `frontend/src/features/inventory/hooks/useInventoryMutationHooks.ts` (`1684`)
- `frontend/src/features/inventory/pages/BoxDetailsPage.tsx` (`1660`)

### Default Split Candidates (`>= 800` lines)
- `frontend/src/features/inventory/components/JobEditorDialog.tsx` (`919`)
- `frontend/src/domain/inventory.ts` (`882`)
- `frontend/src/features/access/pages/AdminAccessPage.tsx` (`878`)
- `frontend/src/features/inventory/pages/AllocationsPage.tsx` (`828`)

### Near-Threshold Structural Candidates
- `frontend/src/features/auth/AuthContext.tsx` (`791`)
- `frontend/src/features/inventory/components/JobAllocateDialog.tsx` (`748`)
- `supabase/functions/_shared/repositories/inventoryRepositories.ts` (`600`)
- `frontend/src/features/inventory/utils/jobCalendar.ts` (`565`)
- `frontend/src/features/inventory/pages/ReportsPage.tsx` (`543`)
- `frontend/src/features/inventory/components/AllocateDialog.tsx` (`534`)
- `frontend/src/components/AppLayout.tsx` (`524`)
- `frontend/src/features/inventory/components/JobsCalendarView.tsx` (`507`)

### Large Test Files
- `frontend/src/features/inventory/hooks/inventoryMutationUtils.test.ts` (`3685`)
- `frontend/src/features/inventory/pages/AllocationJobPage.test.tsx` (`996`)
- `frontend/src/features/inventory/components/JobAllocateDialog.test.tsx` (`878`)
- `frontend/src/features/inventory/pages/BoxDetailsPage.test.tsx` (`623`)
- `frontend/src/features/inventory/pages/AddBoxPage.test.tsx` (`528`)
- `frontend/src/features/inventory/utils/jobAllocationMatching.test.ts` (`525`)

## Navigability And Folder Issues
- `frontend/src/features/inventory` holds the bulk of the app: pages, hooks, components, and utils all grew in parallel without workflow-based subfolders.
- `frontend/src/features/inventory/utils` has `42` files and `5824` total lines, which is a sign that `utils` is being used as a holding area instead of an ownership boundary.
- `backend/src/app` is effectively one file with all request parsing, validation, business rules, DB orchestration, and serialization mixed together.
- `supabase/functions/_shared` already has `routes`, `services`, and `repositories`, but `api-handler.ts` still owns too much of the real behavior.
- Several test files are so large that they hide the behavior seam they are supposed to protect.

## Duplication Ledger

| Hotspot | Type | Verdict | Rationale |
| --- | --- | --- | --- |
| backend host vs Edge runtime request logic | Runtime mirror | Keep mirrored, restructure | Separate runtimes justify duplication, but file shape and parity protection need improvement |
| backend migrations vs Supabase migrations | Deployment mirror | Keep as-is | Intentional sync boundary, not a DRY target |
| inventory mutation cache helpers | Dangerous business duplication | Consolidate | Too much business outcome logic is spread across cache patch paths |
| offline filtering vs live search behavior | Drift-prone duplication | Consolidate around shared matchers | Current shared matchers are good, but local filter and order ownership is still mixed |
| page-local formatting and panel logic in large inventory pages | Structural duplication | Extract by workflow | The issue is navigation and ownership more than literal repeated lines |
| feature API clients | Light adapter duplication | Leave for now | Repetition is shallow and local, not yet a major risk |

## First Low-Risk PR Batches

### Batch A - Audit Tooling And Baseline
- Keep `docs/convergence` as the audit home.
- Use `backend/scripts/audit-repo-hotspots.mjs` for repeatable file-size scans.
- Keep `DRY_AUDIT.md` as a pointer, not a competing audit document.

### Batch B - Inventory Cache Helper Split
- Create a workflow-based cache helper area under `frontend/src/features/inventory`.
- Split `inventoryMutationUtils.ts` into narrow modules such as jobs cache sync, box cache updates, allocation cache updates, film-order cache updates, and snapshot helpers.
- Keep `useInventoryMutationHooks.ts` as a composition layer only.

### Batch C - Inventory Page Shell Extraction
- Move section rendering and section-local formatting out of `AllocationJobPage.tsx` and `BoxDetailsPage.tsx`.
- Pages become orchestration-only and import narrow section components or hooks.

### Batch D - Handler Skeleton Decomposition
- Break `handleSupabaseRequest.mjs` and `api-handler.ts` into feature-family modules without changing route behavior.
- First extract pure helpers and feature builders, leaving the public entrypoint files intact.

## Keep-As-Is List
- Shared domain matcher modules under `frontend/src/domain/*.mjs` are already the right pattern.
- Runtime contract ownership in `runtimeContract.mjs` is already correct.
- Mirrored backend and Edge route behavior is acceptable when parity scripts remain mandatory.
- Append-only migration mirrors should stay duplicated by design.
