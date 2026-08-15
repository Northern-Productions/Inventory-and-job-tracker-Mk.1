# Material Flow Rules

## Purpose

This document is the durable source of truth for film material movement, allocation capacity, job readiness, and film order synchronization. Future work that changes inventory, allocations, job readiness, check-in/check-out, box status, film orders, receives, width handling, or reports must check this document first.

If a requested change conflicts with these rules, warn Rob and Sage before implementing.

## Core Source-Of-Truth Rules

- A box's real physically usable LF is authoritative.
- Total active allocation claims against a box must never exceed that physical usable LF.
- Stored inventory capacity and job readiness must be recalculated from physical box reality. Finalized Film Order receipt totals are historical purchasing records and instead recalculate from their immutable receipt snapshots.
- Stored allocation rows are claims, not proof that material still physically exists.

## Box LF Availability Rules

- Physical usable LF is the material the warehouse actually has or expects for that box.
- For in-stock or transfer boxes, allocatable LF is physical usable LF minus active allocation claims, including EXTRA film that remains separate from requirement coverage.
- For ordered boxes, allocatable LF is expected physical LF minus active allocation claims.
- A checked-out box may report returned physical LF; that returned reality is accepted and then reconciled.
- If roll weight can derive LF, derived LF is treated as the current physical LF within the app's existing weighing rules.
- When roll-weight inputs are complete, the current physical LF is derived from the returned/current roll weight, empty core weight, LF-per-foot profile, and initial LF cap:

```text
derived LF = min(floor((last roll weight - core weight) / LF weight per foot), floor(initial LF))
```

- If the derived value is below zero, treat it as 0 LF. If any required input is missing or LF weight per foot is not positive, do not invent a derived LF.
- Derived roll-weight LF overrides stale stored `feet_available` or `physical_feet_available` values for read/display semantics. A stale 0 LF value must not hide remaining material when complete, valid weight data proves film remains.
- If current LF is explicitly entered during check-in and the app has enough weight/core/profile data, the app may derive the corresponding roll weight using the existing inverse formula. Do not backfill or mass-repair data outside an approved repair task.

## No Over-Allocation Rule

- The app must not leave a box with active allocation claims greater than its physical usable LF.
- If a mutation would create that condition, the app must either reject it with a business-level error or immediately reconcile lower-priority allocations before the operation completes.
- Placeholder allocations count against capacity.
- Film-order receipt allocations count against capacity.
- Auto-planned allocations count against capacity until they are removed or cancelled.

## Placeholder Vs Scheduled/Locked Allocation Rules

- Scheduled allocations are not the only capacity claims.
- Placeholder/no-install-date allocations are softer than scheduled allocations, but they still reserve material.
- A placeholder may lose material during reconciliation before a scheduled job does.
- A placeholder must not make a box appear more available than it is.

## Allocation Priority Rules

When physical LF is insufficient, preserve allocation coverage in this order:

1. Earliest scheduled install date.
2. Later scheduled install dates.
3. No install date / placeholder jobs.
4. Within the same group, older job/allocation creation wins.

Lower-priority claims are reduced or cancelled first.

## Checkout/Check-In Rules

- Normal warehouse operations should not be blocked because downstream jobs will become short.
- Check-in and check-out accept real-world material movement.
- A box in a pending warehouse transfer is the exception: its custody is in transit, so checkout/check-in, consumption, staging, and incompatible box edits remain blocked until receipt or cancellation.
- After check-in or a physical LF correction, lower-priority allocations are reconciled immediately.
- Affected film orders and job readiness must be recalculated before the mutation is considered complete.

## Atomic Cross-Warehouse Allocation And Transfer Rules

- Transfer-assisted allocation starts only from a reviewed `IN_STOCK` source box with no existing reserving allocation.
- One apply request may use a cross-warehouse box for exactly one requirement. Duplicate box selection fails the whole transaction.
- The requirement allocation and pending transfer are created atomically. The transfer links to the immutable `(org_id, allocation_id)` key; there is no backfill of historical transfers.
- A linked pending transfer has one transfer-created first allocation. The allocation reserves planning capacity, while the physical box remains unavailable at the destination until receipt.
- While pending, a second transfer, additional allocation, allocation strengthening/reactivation, fulfillment, checkout/check-in, staging, phase/requirement completion, and incompatible box mutation are blocked server-side.
- Releasing or cancelling the business allocation does not cancel physical custody. Receipt remains available and must not reactivate the allocation.
- Transfer cancellation status-cancels the linked active allocation when needed, keeps its history row, preserves physical LF and weight, and restores `IN_STOCK` only because transfer start proved that source state.
- Receipt moves the physical record and its historical references to the destination identity while preserving LF and weight.
- Historical pending transfers with a null allocation link use the explicit ordinary receive/cancel compatibility path. Workflow type is determined only by the nullable link, never timestamps or guessed relationships.
- Material-flow entry points acquire the shared advisory transaction lock before their existing row/table locks. Keep this order aligned across transfer, allocation, checkout/check-in, job cancellation, requirement/phase state, and staging paths.

## Job Readiness/Status Rules

- A job is Ready only when active requirements are covered by real in-stock material or valid ordered/on-the-way material.
- If a connected box/allocation/order edit means a requirement is no longer fulfilled, the job must leave Ready and show the current material need.
- Cancelled and completed lifecycle statuses still override material readiness according to existing app rules.
- Job readiness must not trust stale allocation rows when physical box LF can no longer back them.

## Film Order Fulfillment And Linked-Box Sync Rules

- Before receipt, a linked `ORDERED` box follows its live Initial LF and width so receiving corrections made before finalization remain accurate.
- Finalizing receipt captures one immutable physical-LF contribution and source-width snapshot on the Film Order link.
- After finalization, Film Order received/remaining/status calculations use the captured receipt contribution. Current physical LF, available LF, roll weight, allocations, checkout/check-in, transfer, return, zeroing, and ordinary Initial LF edits must not rewrite it.
- If a linked ordered box is corrected from 230 LF to 100 LF before receipt, the finalized receipt contribution and Film Order coverage use 100 LF.
- A finalized receipt may change only through the explicit Film Order `Correct Received LF` workflow. That workflow requires Film Order write access and a reason, preserves the old/new values, actor, and timestamp in Film Order history, and does not edit the box's Initial or current LF.
- Multiple finalized receipt links add their width-adjusted historical contributions, so split receipts such as 35 LF plus 25 LF can fulfill a 60 LF order.
- A received link with no deterministic receipt history fails closed and is reported as incomplete. Its per-link receipt contribution is unknown, never numeric zero, and current box data must never be substituted for missing historical evidence.
- While any legacy link remains incomplete, reads preserve the Film Order's stored aggregate and stored status rather than recomputing them from incomplete links. The UI labels that aggregate as legacy history and marks each unknown link as unavailable.
- An authorized `Correct Received LF` action may establish the first complete snapshot for an incomplete legacy link from a deliberately supplied historical LF. Ordinary Box Edit and other material-flow operations cannot populate or overwrite that snapshot.
- If captured or explicitly corrected receipt contributions no longer cover the Film Order, the order returns to Film Order / short status according to the existing status contract.
- Any originating job requirement must also recalculate readiness.

## Width Compatibility And Coverage Multiplier Rule

A box can fulfill a requirement when the box width is the same as or wider than the requirement width.

Coverage multiplier:

```text
floor(box width / required width)
```

Examples:

- 36 box to 36 requirement = 1x
- 48 box to 36 requirement = 1x
- 60 box to 36 requirement = 1x
- 72 box to 36 requirement = 2x
- 72 box to 48 requirement = 1x
- 72 box to 60 requirement = 1x

So 72 in x 50 LF can cover 36 in x 100 LF, while 60 in x 50 LF can cover 36 in x 50 LF only.

## Recalculation/Sync Triggers

Recalculate affected material state after:

- Box LF edit or correction.
- Ordered linked-box LF edit or correction.
- Check-in or check-out.
- Allocation create, remove, cancel, merge, or source change.
- Film order linked box create, edit, receive, remove, or cancel.
- Ordered box receive.
- Job requirement edits.
- Phase install date changes.
- Job cancellation/completion when it affects active material claims.
- Transfer/status changes that affect allocatable material.

## Codex Checklist Before Changing Material Logic

- Identify the physical LF source of truth for the path.
- Confirm active scheduled and placeholder allocations both count against capacity.
- Confirm the write path cannot leave active claims above physical LF.
- Confirm lower-priority reduction/cancellation uses the allocation priority rules.
- Confirm pending Film Orders use pre-receipt linked-box expectations while finalized Film Orders use immutable receipt contributions.
- Confirm ordinary box and material-flow mutations cannot rewrite finalized receipt history, and explicit corrections remain authorized and auditable.
- Confirm job readiness recalculates from backed material, not stale rows.
- Confirm width compatibility uses `floor(box width / required width)`.
- Check frontend, local backend, Supabase Edge/API, SQL/RPC, tests, and schema/latest parity.

## Required Warning Cases For Rob/Sage

Warn before implementing if a requested change would:

- Allow active claims to exceed physical usable LF.
- Treat placeholders as free/non-reserving material.
- Block real-world check-in/check-out instead of accepting and reconciling reality.
- Trust stale film-order linked-box LF.
- Use exact 72-to-36 special casing instead of the floor multiplier rule.
- Create hidden auto-orders outside explicit user workflows.
- Recalculate only one runtime surface while leaving backend/Edge/SQL/frontend behavior split.

## Open Questions

- None for the approved rules in this implementation pass.
