---
name: inventory-offline-sync
description: Implement offline-first inventory behavior: IndexedDB cache, action queue, retries, idempotency, and conflict resolution. Use when adding offline features or syncing stock changes.
---

# Offline Sync Skill (Inventory PWA)

## Principles
- Offline actions append to a local queue; UI updates immediately (optimistic).
- Server sync must be idempotent: each mutation has a unique mutation_id and can be safely replayed.
- Conflicts are resolved at the mutation level, not by overwriting entire rows.

## Queue format (recommended)
Each queued record:
- mutation_id (uuid)
- entity_type (item, stock, transfer, etc.)
- payload
- created_at
- attempts
- last_error
- status: queued | sending | acknowledged | dead-letter

## Sync algorithm
1. Load queued mutations ordered by created_at.
2. Send in small batches.
3. On success, mark acknowledged and store server receipt (server_timestamp, version/etag).
4. On failure:
   - network failure → backoff and retry
   - validation/auth failure → dead-letter and show user action needed
   - conflict → run conflict routine (below)

## Conflict resolution (stock)
Preferred model: stock = sum(all mutations).
- Never “set stock = X” unless it creates an explicit adjustment mutation.
- If two devices both adjust, both mutations are valid; the total is deterministic.

If you must support “set stock”:
- Convert to delta against last-known computed stock and create an adjustment mutation.

## What to output when invoked
- IndexedDB schema (tables/stores)
- Queue + retry/backoff logic
- Sync endpoints/contracts and idempotency approach
- Conflict-handling UX (banner, review screen, retry button)
