# Phase 3 Deep Pass

## Summary
- Phase 3 only starts after the medium-pass batches stabilize ownership.
- The goal is convergence, not churn: fewer places to make the same business decision, clearer workflow modules, and better runtime parity.

## Deep Targets

### Backend Host And Edge Convergence
- Keep the two runtimes, but reduce duplicated business decisions.
- Move runtime-neutral decision logic into shared modules only when it is safe for both Node and Deno.
- When direct sharing is not worth the runtime friction, keep mirrored feature modules with identical names and parity tests.

### Inventory Domain Breakup
- Finish moving the inventory feature away from giant generic folders.
- Prefer workflow subfolders such as `jobs`, `allocations`, `boxes`, `transfers`, `search`, and `caulk`.
- Shrink `utils/` into a small set of clearly named behavior modules rather than an everything bucket.

### Route-Family Decomposition
- Make route registration visible and shallow.
- Keep handlers thin and make service boundaries obvious enough that a bug can be isolated to one feature family without opening a 5k-line handler.

### Script Policy Extraction
- Audit large scripts in `backend/scripts/` for embedded durable business rules.
- If a script contains reusable policy or normalization logic, extract that logic into shared modules and leave the script as a thin runner.
- Keep one-off migration or reconciliation runners as scripts when they are truly single-use.

### Test Topology Cleanup
- Reorganize giant tests to mirror production workflow folders.
- Preserve parity and smoke scripts as first-class release checks, not afterthoughts.

## Completion Criteria
- Every in-scope subsystem has one verdict:
  - `consolidated`
  - `kept duplicated with reason`
  - `needs separate behavior plan`
- No production file over `1500` lines remains without an explicit justification.
- No feature-critical behavior is owned in more than one place without a parity check that proves it stays aligned.
- Jobs, allocations, inventory search, box detail/edit/transfer, auth/session transitions, and offline search each have an end-to-end trace and regression coverage.

## Deep-Pass Non-Goals
- Do not rewrite historical migrations for readability.
- Do not change public contracts just to make structure prettier.
- Do not force Node and Deno into a fake shared layer if it makes runtime behavior harder to reason about.
