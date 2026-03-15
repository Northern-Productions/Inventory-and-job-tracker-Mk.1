# MS Workbook Dry-Run Migration Checklist

This checklist transforms `MS Inventory.xlsx` into `import.boxes_raw` CSV artifacts using the same gated flow as IL.

## 1) Run dry-run transform

From repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\transform-il-assigned-inventory.ps1 -Profile MS
```

Artifacts are written to:

- `backend/migration-dry-runs/ms-inventory/boxes_raw.csv`
- `backend/migration-dry-runs/ms-inventory/boxes_exceptions.csv`
- `backend/migration-dry-runs/ms-inventory/id_collisions.csv`
- `backend/migration-dry-runs/ms-inventory/summary.json`

## 2) Run zeroed-candidate prep

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\prepare-zeroed-candidates.ps1 -Profile MS
```

Primary zeroed artifacts:

- `backend/migration-dry-runs/ms-inventory/zeroed/zeroed_candidates_unique_last_occurrence.csv`
- `backend/migration-dry-runs/ms-inventory/zeroed/zeroed_candidates_unique_last_occurrence_widths_defaulted.csv`
- `backend/migration-dry-runs/ms-inventory/zeroed/zeroed_date_inference_summary.json`
- `backend/migration-dry-runs/ms-inventory/zeroed/zeroed_width_default_summary.json`

## 3) Mandatory review gate

Before loading anything:

1. Review `id_collisions.csv` and decide manual entries.
2. Review `boxes_exceptions.csv` and resolve malformed/missing rows.
3. Confirm `boxes_raw.csv` header names match `import.boxes_raw` exactly.

## 4) Apply scripted resolution stages

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\apply-width-resolutions.ps1 -Profile MS
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\apply-missing-quantity-as-zeroed.ps1 -Profile MS
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\append-zeroed-tab-to-boxes-raw.ps1 -Profile MS
```

Final merge input:

- `backend/migration-dry-runs/ms-inventory/boxes_raw_final_with_zeroed.csv`

## 5) Staging load gate (test/new org first)

`import.load_inventory_from_staging('<org_uuid>')` is destructive for that org's inventory/job/history data.

Always run:

```sql
select import.clear_staging();
```

Then import only the final CSV into `import.boxes_raw`, and run:

```sql
select import.load_inventory_from_staging('<test_or_new_org_uuid>');
```

If append/merge is preferred:

```sql
select import.merge_boxes_from_staging('<target_org_uuid>'::uuid, true, 'keep_existing');
```

## 6) Post-load verification SQL

Replace `<org_uuid>` with target org.

```sql
-- Count matches dry-run accepted rows
select count(*) as boxes_count
from app.boxes
where org_id = '<org_uuid>'::uuid;

-- Ensure no duplicate BoxID
select box_id, count(*)
from app.boxes
where org_id = '<org_uuid>'::uuid
group by box_id
having count(*) > 1;

-- Required field sanity checks
select count(*) as invalid_required_rows
from app.boxes
where org_id = '<org_uuid>'::uuid
  and (
    trim(box_id) = ''
    or trim(manufacturer) = ''
    or trim(film_name) = ''
    or width_in <= 0
    or initial_feet < 0
    or feet_available < 0
    or order_date is null
    or received_date is null
  );
```

## Notes

- Canonical MS flow emits `MS1-*` IDs by default.
- `FILM DATA` remains manual for this phase.
- Block live load until exceptions and collisions are approved.
