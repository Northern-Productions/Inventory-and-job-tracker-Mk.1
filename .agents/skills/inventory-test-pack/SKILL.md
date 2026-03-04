---
name: inventory-test-pack
description: Generate tests for inventory logic, offline queue, and sync edge cases. Use when adding features that change stock math, syncing, or barcode flows.
---

# Inventory Test Pack Skill

## Must-test scenarios
- Stock never goes negative (unless allowed)
- Transfers net to zero across locations
- Queue replays are idempotent (no double-apply)
- Offline: create item + receive stock + reconnect
- Conflict: two devices adjust same item/location

## What to output when invoked
- Unit tests for pure stock math
- Integration tests for sync queue
- Suggested CI steps
