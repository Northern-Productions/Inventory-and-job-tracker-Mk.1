# IL Workbook Dry-Run Migration Checklist

This checklist is for transforming `IL Assigned Inventory.xlsx` into `import.boxes_raw` CSV for staged loading, then loading approved `Caulk` tab rows into the caulk subsystem.

## 1) Run dry-run transform

From repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\transform-il-assigned-inventory.ps1
```

Artifacts are written to:

- `backend/migration-dry-runs/il-assigned/boxes_raw.csv`
- `backend/migration-dry-runs/il-assigned/boxes_exceptions.csv`
- `backend/migration-dry-runs/il-assigned/id_collisions.csv`
- `backend/migration-dry-runs/il-assigned/summary.json`
- `backend/migration-dry-runs/il-assigned/caulk_raw_candidates.csv`
- `backend/migration-dry-runs/il-assigned/caulk_review_decisions.csv`
- `backend/migration-dry-runs/il-assigned/caulk_raw_final.csv`
- `backend/migration-dry-runs/il-assigned/caulk_summary.json`

## 2) Mandatory review gate

Before loading anything:

1. Review `id_collisions.csv` and decide manual entries.
2. Review `boxes_exceptions.csv` and resolve malformed/missing rows.
3. Confirm `boxes_raw.csv` header names match `import.boxes_raw` exactly.

## 3) Staging load gate (test/new org first)

`import.load_inventory_from_staging('<org_uuid>')` is destructive for that org's inventory/job/history data.

Always run:

```sql
select import.clear_staging();
```

Then import only `boxes_raw.csv` into `import.boxes_raw`, and run:

```sql
select import.load_inventory_from_staging('<test_or_new_org_uuid>');
```

If you need append/merge behavior instead of replace, use:

```sql
select import.merge_boxes_from_staging('<target_org_uuid>'::uuid, true, 'keep_existing');
```

Merge mode details:

1. Keeps existing `app.boxes` rows for the org.
2. Appends new rows from `import.boxes_raw`.
3. Optionally normalizes existing unprefixed `box_id` values to prefixed canonical form.
4. Supports `conflict_mode='overwrite_existing'` if you explicitly want staging to overwrite existing box rows.

## 4) Post-load verification SQL

Replace `<org_uuid>` with the test/new org target.

```sql
-- Count matches dry-run accepted_rows
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
    or initial_feet <= 0
    or feet_available < 0
    or order_date is null
    or received_date is null
  );

-- IL/MS routing spot check
select warehouse, count(*) as row_count
from app.boxes
where org_id = '<org_uuid>'::uuid
group by warehouse
order by warehouse;
```

## 5) Caulk review + apply (after box import)

1. Open `backend/migration-dry-runs/il-assigned/caulk_review_decisions.csv`.
2. Set `decision` to `approve`/`reject` for each candidate row and adjust canonical fields as needed.
3. Re-run the transform to regenerate approved-only `caulk_raw_final.csv`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\transform-il-assigned-inventory.ps1 -Profile IL
```

4. Validate caulk load with dry-run:

```bash
node backend/scripts/import-caulk-sheet-inventory.mjs --profile IL --mode dry-run --actor "<your_name>"
```

5. Apply approved caulk rows:

```bash
node backend/scripts/import-caulk-sheet-inventory.mjs --profile IL --mode apply --actor "<your_name>"
```

Operational notes:

1. Loader skips already mapped `(org_id, source_box_id)` rows, so reruns are idempotent.
2. Loader does not retire or mutate `app.boxes`; it only writes caulk manufacturers/products/stock/transactions and `app.caulk_backfill_map`.
3. `caulk_raw_final.csv` is the required handoff artifact for caulk loading and includes canonical source ID, warehouse code, manufacturer/product fields, tubes-per-case, and quantity in tubes.

## 6) UI spot check

In the app:

1. Confirm inventory list loads for IL and MS.
2. Spot-check random imported rows (manufacturer, film name, width, feet, lot).
3. Confirm search by `BoxID` resolves expected records.

## Notes

- `FILM DATA` is intentionally not auto-seeded in this phase.
- `import.load_inventory_from_staging(...)` remains the full replace-mode migration path.
- `import.merge_boxes_from_staging(...)` is a boxes-only non-destructive merge path.
