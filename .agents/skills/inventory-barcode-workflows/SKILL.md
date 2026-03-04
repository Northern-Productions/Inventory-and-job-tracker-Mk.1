---
name: inventory-barcode-workflows
description: Design and implement barcode/QR scan workflows for inventory add/remove/lookup, including fast UI flows and duplicate detection.
---

# Barcode Workflow Skill

## Workflows to support
1) Scan → Item lookup
- If found: show item card + quick actions (+1, -1, adjust, transfer)
- If not found: guided “Create item” flow with barcode prefilled

2) Scan → Receive stock (intake)
- Choose location (remember last)
- Enter quantity (default 1)
- Optional batch/lot/expiry

3) Scan → Consume stock (use/sell)
- Choose location (remember last)
- Quantity default 1
- Prevent negative unless backorder enabled

## UX requirements
- One-hand operation: big buttons, minimal typing
- Fast repeat scans: auto-close dialogs, keep camera open
- Audible/vibration feedback on success/failure
- Clear handling of “unknown barcode”

## Data rules
- Barcode is unique per item unless you explicitly support aliases.
- When multiple matches exist (legacy data), show disambiguation and offer merge.

## What to output when invoked
- Component/API plan (camera scanning lib integration, permissions)
- Screen flows + states
- Data constraints related to barcode uniqueness
