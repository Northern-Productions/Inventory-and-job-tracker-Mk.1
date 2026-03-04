# Seed Data

Use these sample rows after creating the required tabs.

## Boxes_IL

| BoxID | Manufacturer | FilmName | WidthIn | InitialFeet | FeetAvailable | LotRun | Status | OrderDate | ReceivedDate | LastRollWeightLbs | LastWeighedDate | FilmKey | CoreWeightLbs | LfWeightLbsPerFt | PurchaseCost | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IL-1001 | SunTek | Carbon 35 | 36 | 100 | 100 | LOT-A1 | IN_STOCK | 2026-02-26 | 2026-02-27 | 24.5 | 2026-02-27 | SUNTEK\|CARBON 35 | 2.2 | 0.21 | 189.99 | Initial Illinois sample |
| IL-1002 | XPEL | Black 20 | 48 | 150 | 120 | LOT-A2 | CHECKED_OUT | 2026-02-18 | 2026-02-20 | 30.1 | 2026-02-26 | XPEL\|BLACK 20 | 2.5 | 0.18 | 244.00 | Already checked out |

## Boxes_MS

| BoxID | Manufacturer | FilmName | WidthIn | InitialFeet | FeetAvailable | LotRun | Status | OrderDate | ReceivedDate | LastRollWeightLbs | LastWeighedDate | FilmKey | CoreWeightLbs | LfWeightLbsPerFt | PurchaseCost | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M-2001 | 3M | Ceramic IR 25 | 60 | 100 | 100 | LOT-M1 | IN_STOCK | 2026-02-23 | 2026-02-25 | 42.0 | 2026-02-27 | 3M\|CERAMIC IR 25 | 3.0 | 0.29 | 315.75 | Mississippi sample |
| M-2002 | Llumar | CTX 30 | 72 | 120 | 0 | LOT-M2 | RETIRED | 2026-02-15 | 2026-02-18 | 47.8 | 2026-02-24 | LLUMAR\|CTX 30 | 3.2 | 0.33 | 410.50 | Retired example |

## Zeroed_IL

Use the same headers as `Boxes_IL`. Leave the tab empty for now.

## Zeroed_MS

Use the same headers as `Boxes_MS`. Leave the tab empty for now.

## AuditLog

The app writes this automatically. Example row shape:

| LogID | Date | Action | BoxID | Before | After | User | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20260227103000000-123 | 2026-02-27T10:30:00.000Z | ADD_BOX | IL-1001 | null | {"BoxID":"IL-1001"} | Robert | Seed example |
