---
name: inventory-audit-trail
description: Add an audit trail for inventory changes (who/what/when/why) and build history views. Use when implementing stock updates or accountability features.
---

# Inventory Audit Trail Skill

## Model
- Immutable inventory_mutations table.
- Stock at any time = sum(mutations) per item/location (or materialized view for speed).

## Required fields
- mutation_id, org_id, item_id, location_id
- delta, reason, note
- actor_user_id, actor_device_id
- client_timestamp, server_timestamp

## UI
- Item history: filter by location, reason, date, actor
- “Explain current stock” view showing the last N mutations

## What to output when invoked
- DB schema + indexes
- Optional materialized view strategy
- UI components for history
