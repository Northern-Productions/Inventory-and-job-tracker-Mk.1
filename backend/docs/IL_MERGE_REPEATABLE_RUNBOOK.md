# Inventory Boxes Merge Runbook (Repeatable Across Environments)

Use this runbook to replay the same box merge into a different org or database environment.

## Scope

- Loads profile output (`IL` or `MS`) into `import.boxes_raw`
- Runs non-destructive merge into `app.boxes` with `keep_existing`
- Does **not** overwrite existing matching `box_id` rows

## Prerequisites

1. Start with a test/safe org first.
2. Repo contains:
   - `backend/migrations/0019_import_boxes_merge_mode.sql`
   - `backend/scripts/run-il-boxes-merge-load.mjs`
   - `backend/scripts/run-il-qa-signoff.mjs`
3. `backend/.env` has:
   - `DATABASE_URL=<target_environment_database_url>`
   - `DEFAULT_ORG_ID=<target_org_uuid>`
4. Pick a profile and run directory:
   - `IL` -> `backend/migration-dry-runs/il-assigned`
   - `MS` -> `backend/migration-dry-runs/ms-inventory`

## Step 1: Ensure Merge SQL Exists In Target DB

`run-il-boxes-merge-load.mjs` applies `0019_import_boxes_merge_mode.sql` at runtime, so no separate migration command is required for this runbook path.

If you also want the migration formally recorded in an environment (recommended for long-term parity), run:

```powershell
npx supabase db push
```

## Step 2: Prepare Input CSV

For IL:

- `backend/migration-dry-runs/il-assigned/boxes_raw_final_with_zeroed.csv`

For MS:

- `backend/migration-dry-runs/ms-inventory/boxes_raw_final_with_zeroed.csv`

If you must rebuild from workbook:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\transform-il-assigned-inventory.ps1 -Profile <IL|MS>
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\prepare-zeroed-candidates.ps1 -Profile <IL|MS>
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\apply-width-resolutions.ps1 -Profile <IL|MS>
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\apply-missing-quantity-as-zeroed.ps1 -Profile <IL|MS>
powershell -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\append-zeroed-tab-to-boxes-raw.ps1 -Profile <IL|MS>
```

Then re-apply your approved manual resolution workflow before proceeding.

## Step 3: Run Merge Load

```powershell
node .\backend\scripts\run-il-boxes-merge-load.mjs --profile <IL|MS>
```

Expected behavior:

- runs `import.clear_staging()`
- stages CSV rows into `import.boxes_raw`
- normalizes existing non-prefixed IDs for the org
- merges with `conflict_mode='keep_existing'`

## Step 4: Run QA Sign-Off

```powershell
node .\backend\scripts\run-il-qa-signoff.mjs --profile <IL|MS>
```

Review:

- `<run_dir>/qa_signoff_report.md`
- `<run_dir>/qa_signoff_report.json`

## Success Gates

- `csv_box_ids_missing_in_db = 0`
- `duplicate_box_ids = 0`
- `invalid_required_or_numeric_rows = 0`
- `warehouse_routing_mismatches = 0`
- `Passed: YES`

## Notes

- A non-zero CSV-vs-DB difference count is expected when conflicts are skipped by `keep_existing`.
- Use `overwrite_existing` only by explicit decision; this runbook intentionally keeps existing DB rows unchanged.
