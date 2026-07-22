# Warehouse Asset Audit Report

The Warehouse Asset Audit is a read-only `reports.read` report for current operational film-box assets. It has no schema or migration dependency and does not write to inventory, jobs, allocations, transfers, ownership, or warehouse data.

## Included boxes

The report includes boxes in `IN_STOCK`, `CHECKED_OUT`, and `TRANSFER` state. It returns all matching rows without a server row cap. Screen pagination affects display only; printing uses every row from one forced live response.

Ownerless boxes are included as `Unassigned`. A non-null owner reference must resolve inside the current organization. Missing, dangling, and cross-organization references are not treated as Unassigned; the report fails closed.

## Canonical custody

Each box must resolve to exactly one custody warehouse:

- `IN_STOCK`: current box warehouse and current physical LF.
- `CHECKED_OUT`: checkout-source warehouse retained on the box and checkout LF.
- `TRANSFER`: pending-transfer source warehouse until receipt and current physical LF.

Multiple pending transfers, a missing transfer for a transfer-state box, pending transfer state on another box status, invalid source or destination warehouses, missing checkout LF, duplicate box identities, and dangling active allocation or transfer references fail the report. The report does not guess custody.

## Cost basis

Each row reports one explicit category:

- `DIRECT_PRICE_PER_LF`: uses stored price per LF, including a valid stored zero.
- `DERIVED_FROM_PURCHASE_COST`: divides purchase cost by initial LF.
- `MISSING`: neither basis exists; cost remains missing and is not converted to zero.

Known asset costs use on-hand LF. Exact decimal values are summed before the final total is rounded for display.

## Freshness and printing

The endpoint is tenant-scoped and returns `Cache-Control: no-store`. Its query key includes the organization and filters, and it has no offline or IndexedDB fallback. Printing is disabled while offline, loading, refreshing, or errored.

`Print Audit` performs a forced live read, freezes that response in memory, renders a dedicated US Letter landscape worksheet, verifies every response row appears exactly once, waits for the worksheet and fonts, and then opens the print dialog. Printed metadata, filters, rows, timestamp, and totals all come from that same response.

The worksheet uses a dedicated print root and named page. Label-print dimensions and styles remain scoped to label printing.

The guarded read-only scale check is available as:

```powershell
npm --prefix backend run verify:warehouse-asset-audit:scale -- --env .env.dev --expect dev
```

It selects representative filters internally but emits only aggregate counts, payload size, and timings. PROD use requires both `--expect prod` and `--allow-prod` after an explicit read-only PROD verification approval.

## Consistency limit

The response is authoritative at read time, but the Edge implementation reads paged table projections rather than holding one database transaction across every table. Concurrent business activity during report construction can therefore produce a fail-closed integrity error or a response assembled across nearby committed states. Run high-stakes audits during a quiet window and refresh immediately before printing.
