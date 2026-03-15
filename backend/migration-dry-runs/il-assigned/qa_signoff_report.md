# IL Merge QA Sign-Off

- Generated (UTC): 2026-03-14T23:59:06.687Z
- Org: `ecf4f1c5-f153-4072-b814-18a41c52fcdc`
- CSV: `backend/migration-dry-runs/il-assigned/boxes_raw_final_with_zeroed.csv`

## Totals
- CSV rows: 2045
- CSV unique BoxIDs: 2045
- DB boxes for org: 2065
- CSV BoxIDs present in DB: 2045
- CSV BoxIDs missing in DB: 0

## Integrity Gates
- Duplicate box_id rows: 0
- Invalid required/numeric rows: 0
- Warehouse routing mismatches: 0

## Status Counts
- ZEROED: 1391
- IN_STOCK: 662
- CHECKED_OUT: 12

## Warehouse Counts
- IL: 2052
- MS: 13

## Sign-Off
- Passed: YES
- Blockers:
- (none)
- Warnings:
- CSV vs DB field differences on matched BoxIDs: 20 (expected when keep_existing skipped conflicts)

