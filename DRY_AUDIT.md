# DRY Audit

## Summary
- Scope: long-lived app code first across `frontend`, `backend/src`, and `supabase/functions`.
- Review stance: mirrored local-backend and shared-edge implementations are acceptable when contract behavior stays aligned.
- This pass implemented the lowest-risk, highest-repeat frontend consolidations and documented the remaining top hotspots.

## Prioritized Findings

| Rank | Hotspot | Classification | Recommended Action | Refactor Risk | Concrete Seam |
| --- | --- | --- | --- | --- | --- |
| 1 | Inventory page auth/config/permission guards | `extract now` | Extract shared action-access helper and reuse it in large pages | Low | `frontend/src/features/inventory/hooks/useActionAccess.ts` |
| 2 | Repeated React Query read option shapes | `extract now` | Centralize default query option builders for inventory read hooks | Low | `frontend/src/features/inventory/hooks/useInventoryReadQueries.ts` |
| 3 | Repeated job cache sync and caulk invalidation logic | `extract now` | Move common cache update/invalidation behavior into hook utilities | Low | `frontend/src/features/inventory/hooks/inventoryMutationUtils.ts`, `inventoryInvalidation.ts` |
| 4 | Local backend host vs shared edge job-status logic | `intentional mirror` | Keep mirrored implementations, protect with contract/parity checks, avoid premature extraction | Medium | `backend/src/app/handleSupabaseRequest.mjs`, `supabase/functions/_shared/api-handler.ts` |
| 5 | Feature API client wrappers and stylesheet repetition | `leave as-is` | Only extract further if readability improves or repetition starts drifting behavior | Medium | `frontend/src/api/features/*`, `frontend/src/styles.css` |

## Implemented In This Pass
- Shared page-level action access checks now flow through one helper instead of repeating auth/config/permission toast logic in each large inventory page.
- Inventory read hooks now use shared internal query builders for common `enabled`, `staleTime`, `gcTime`, and `refetchOnWindowFocus` patterns.
- Job-result cache syncing now uses a shared helper, and repeated caulk mutation invalidations now route through shared invalidation utilities.

## Deferred / Documented
- Backend mirrored business rules remain duplicated by design because the local host and shared edge handler run in different environments. Current recommendation is to keep the mirror and strengthen parity coverage rather than forcing a shared runtime layer.
- API feature clients still contain some repeated “request + normalize” wrappers, but the current repetition is shallow and type-local. Extract only if more routes start sharing the same mapper/shape.
- `styles.css` contains repeated badge/pill/calendar styling patterns, but broad consolidation would be higher-risk than value for this pass.
