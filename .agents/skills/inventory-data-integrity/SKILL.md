---
name: inventory-data-integrity
description: Enforce inventory correctness. Use when creating or changing item/stock schemas, CRUD endpoints, or UI forms that can affect counts, units, locations, or identifiers.
---

# Inventory Data Integrity Skill

## Goal
Make inventory data consistent and safe across UI, local cache, and backend.

## Always enforce these invariants
- Stock counts must never be NaN; use integers for “units” stock and decimals only where explicitly required (e.g. weight).
- No operation can produce negative stock unless the product explicitly supports backorders.
- Every stock mutation must include:
  - item_id
  - location_id (or explicit null if truly global)
  - delta (+/-)
  - reason (sale, intake, adjustment, transfer, return, etc.)
  - timestamp (client + server)
  - actor (user id / device id)

## IDs and uniqueness
- Stable IDs: use UUIDs for items, locations, and mutations.
- Prevent duplicate items by enforcing at least one unique constraint:
  - UPC/EAN/GTIN barcode OR SKU OR (normalized name + brand + variant) depending on the product model.
- Normalize comparison fields (trim, lowercase, collapse whitespace).

## Validation checklist (UI + server)
- Required fields exist and are typed correctly.
- Units are consistent (unit, pack, case, weight).
- Location must be valid for operation type.
- Transfers must be represented as two mutations (decrement from source, increment to destination) tied by a shared transfer_id.

## What to output when invoked
1. Proposed schema or schema diffs (tables/types) and constraints.
2. Validation rules for UI forms.
3. Backend validation steps + error codes/messages.
4. Migration notes if data already exists.
