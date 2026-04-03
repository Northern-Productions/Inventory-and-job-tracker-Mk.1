const ACTIVE_STATUSES = new Set(["ORDERED", "IN_STOCK", "CHECKED_OUT"]);
const APPLY_ELIGIBLE_STATUSES = new Set(["ORDERED", "IN_STOCK"]);

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function asUpperTrimmedString(value) {
  return asTrimmedString(value).toUpperCase();
}

function asInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function asNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDateString(value) {
  if (!value) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const text = asTrimmedString(value);
  if (!text) {
    return "";
  }

  return text.slice(0, 10);
}

function sortByBoxId(left, right) {
  return left.boxId.localeCompare(right.boxId, "en-US", { numeric: true, sensitivity: "base" });
}

function countByManufacturer(rows) {
  const counts = {};
  for (const row of rows) {
    const manufacturer = asTrimmedString(row.manufacturer) || "(blank)";
    counts[manufacturer] = (counts[manufacturer] || 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0], "en-US", { sensitivity: "base" });
    })
  );
}

function parseRpcJson(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return JSON.parse(value);
  }

  return value;
}

export function canonicalizeShelfBoxId(suffix, warehouse = "IL1") {
  const canonicalSuffix = asTrimmedString(suffix).replace(/^0+(\d)/, "$1");
  if (!/^\d{4,}$/.test(canonicalSuffix)) {
    throw new Error(`Invalid shelf-audit suffix: ${suffix}`);
  }

  return `${asUpperTrimmedString(warehouse) || "IL1"}-${canonicalSuffix}`;
}

export function parseShelfAuditText(rawText, warehouse = "IL1") {
  const suffixCounts = new Map();
  const tokens = String(rawText ?? "").match(/\b\d{4,}\b/g) || [];

  for (const token of tokens) {
    const canonical = asTrimmedString(token);
    if (!canonical) {
      continue;
    }
    suffixCounts.set(canonical, (suffixCounts.get(canonical) || 0) + 1);
  }

  const uniqueSuffixes = Array.from(suffixCounts.keys()).sort((left, right) => Number(left) - Number(right));
  const duplicateSourceIds = uniqueSuffixes
    .filter((suffix) => (suffixCounts.get(suffix) || 0) > 1)
    .map((suffix) => ({
      suffix,
      boxId: canonicalizeShelfBoxId(suffix, warehouse),
      occurrenceCount: suffixCounts.get(suffix) || 0
    }));

  return {
    warehouse: asUpperTrimmedString(warehouse) || "IL1",
    sourceEntryCount: tokens.length,
    uniqueEntryCount: uniqueSuffixes.length,
    uniqueSuffixes,
    duplicateSourceIds,
    shelfBoxIds: uniqueSuffixes.map((suffix) => canonicalizeShelfBoxId(suffix, warehouse))
  };
}

export function normalizeWarehouseBoxRow(row) {
  return {
    boxId: asUpperTrimmedString(row?.boxId || row?.box_id),
    warehouse: asUpperTrimmedString(row?.warehouse),
    manufacturer: asTrimmedString(row?.manufacturer),
    filmName: asTrimmedString(row?.filmName || row?.film_name),
    widthIn: asInteger(row?.widthIn ?? row?.width_in, 0),
    initialFeet: asInteger(row?.initialFeet ?? row?.initial_feet, 0),
    feetAvailable: asInteger(row?.feetAvailable ?? row?.feet_available, 0),
    lotRun: asTrimmedString(row?.lotRun || row?.lot_run),
    status: asUpperTrimmedString(row?.status),
    orderDate: asDateString(row?.orderDate || row?.order_date),
    receivedDate: asDateString(row?.receivedDate || row?.received_date),
    initialWeightLbs: asNullableNumber(row?.initialWeightLbs ?? row?.initial_weight_lbs),
    lastRollWeightLbs: asNullableNumber(row?.lastRollWeightLbs ?? row?.last_roll_weight_lbs),
    lastWeighedDate: asDateString(row?.lastWeighedDate || row?.last_weighed_date),
    filmKey: asTrimmedString(row?.filmKey || row?.film_key),
    coreType: asTrimmedString(row?.coreType || row?.core_type),
    coreWeightLbs: asNullableNumber(row?.coreWeightLbs ?? row?.core_weight_lbs),
    lfWeightLbsPerFt: asNullableNumber(row?.lfWeightLbsPerFt ?? row?.lf_weight_lbs_per_ft),
    pricePerLf: asNullableNumber(row?.pricePerLf ?? row?.price_per_lf),
    purchaseCost: asNullableNumber(row?.purchaseCost ?? row?.purchase_cost),
    notes: asTrimmedString(row?.notes),
    zeroedDate: asDateString(row?.zeroedDate || row?.zeroed_date),
    zeroedReason: asTrimmedString(row?.zeroedReason || row?.zeroed_reason),
    zeroedBy: asTrimmedString(row?.zeroedBy || row?.zeroed_by),
    lastCheckoutJob: asTrimmedString(row?.lastCheckoutJob || row?.last_checkout_job),
    lastCheckoutDate: asDateString(row?.lastCheckoutDate || row?.last_checkout_date)
  };
}

export function buildShelfAuditDiff(rows, parsedInput) {
  const normalizedRows = rows
    .map((row) => normalizeWarehouseBoxRow(row))
    .filter((row) => row.boxId && row.warehouse === parsedInput.warehouse);
  const rowByBoxId = new Map(normalizedRows.map((row) => [row.boxId, row]));
  const shelfBoxIdSet = new Set(parsedInput.shelfBoxIds);

  const activeMatches = [];
  const zeroCandidates = [];
  const checkedOutExceptions = [];
  const alreadyZeroedHits = [];
  const missingIds = [];
  const unexpectedStatusHits = [];

  for (const row of normalizedRows) {
    if (!ACTIVE_STATUSES.has(row.status)) {
      continue;
    }

    if (shelfBoxIdSet.has(row.boxId)) {
      activeMatches.push(row);
      continue;
    }

    if (row.status === "CHECKED_OUT") {
      checkedOutExceptions.push(row);
      continue;
    }

    zeroCandidates.push(row);
  }

  for (const boxId of parsedInput.shelfBoxIds) {
    const matchingRow = rowByBoxId.get(boxId);
    if (!matchingRow) {
      missingIds.push({
        boxId,
        suffix: boxId.split("-")[1] || ""
      });
      continue;
    }

    if (ACTIVE_STATUSES.has(matchingRow.status)) {
      continue;
    }

    if (matchingRow.status === "ZEROED") {
      alreadyZeroedHits.push(matchingRow);
      continue;
    }

    unexpectedStatusHits.push(matchingRow);
  }

  activeMatches.sort(sortByBoxId);
  zeroCandidates.sort(sortByBoxId);
  checkedOutExceptions.sort(sortByBoxId);
  alreadyZeroedHits.sort(sortByBoxId);
  unexpectedStatusHits.sort(sortByBoxId);
  missingIds.sort((left, right) => left.boxId.localeCompare(right.boxId, "en-US", { numeric: true }));

  return {
    activeMatches,
    zeroCandidates,
    checkedOutExceptions,
    alreadyZeroedHits,
    missingIds,
    unexpectedStatusHits,
    summary: {
      warehouse: parsedInput.warehouse,
      sourceEntryCount: parsedInput.sourceEntryCount,
      uniqueShelfIdCount: parsedInput.uniqueEntryCount,
      duplicateShelfIdCount: parsedInput.duplicateSourceIds.length,
      inventoryRowCount: normalizedRows.length,
      activeInventoryCount: activeMatches.length + zeroCandidates.length + checkedOutExceptions.length,
      matchedActiveCount: activeMatches.length,
      zeroCandidateCount: zeroCandidates.length,
      checkedOutExceptionCount: checkedOutExceptions.length,
      alreadyZeroedHitCount: alreadyZeroedHits.length,
      missingIdCount: missingIds.length,
      unexpectedStatusHitCount: unexpectedStatusHits.length
    },
    breakdowns: {
      zeroCandidatesByManufacturer: countByManufacturer(zeroCandidates),
      checkedOutExceptionsByManufacturer: countByManufacturer(checkedOutExceptions),
      alreadyZeroedHitsByManufacturer: countByManufacturer(alreadyZeroedHits)
    }
  };
}

export function validateApplyCandidates(candidates) {
  const normalizedCandidates = candidates.map((candidate) => normalizeWarehouseBoxRow(candidate)).sort(sortByBoxId);

  for (const candidate of normalizedCandidates) {
    if (!APPLY_ELIGIBLE_STATUSES.has(candidate.status)) {
      throw new Error(`Cannot zero ${candidate.boxId} because it is ${candidate.status || "UNKNOWN"}.`);
    }

    if (!candidate.receivedDate) {
      throw new Error(`Cannot safely zero ${candidate.boxId} because it has not been received yet.`);
    }
  }

  return normalizedCandidates;
}

export function buildIl1ShelfAuditZeroOutPayload(candidate, auditNote) {
  const box = normalizeWarehouseBoxRow(candidate);

  return {
    boxId: box.boxId,
    warehouse: box.warehouse,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: box.widthIn,
    initialFeet: box.initialFeet,
    feetAvailable: 0,
    lotRun: box.lotRun,
    orderDate: box.orderDate,
    receivedDate: box.receivedDate,
    initialWeightLbs: box.initialWeightLbs,
    lastRollWeightLbs: box.lastRollWeightLbs,
    lastWeighedDate: box.lastWeighedDate,
    filmKey: box.filmKey,
    coreType: box.coreType,
    coreWeightLbs: box.coreWeightLbs,
    lfWeightLbsPerFt: box.lfWeightLbsPerFt,
    pricePerLf: box.pricePerLf,
    purchaseCost: box.purchaseCost,
    notes: box.notes,
    moveToZeroed: true,
    auditNote: asTrimmedString(auditNote)
  };
}

async function callBoxUpdateRpc(client, orgId, actor, payload) {
  const { rows } = await client.query(
    "select public.api_acl_boxes_update($1::uuid, $2::text, $3::jsonb) as result",
    [orgId, actor, JSON.stringify(payload)]
  );
  const result = parseRpcJson(rows[0]?.result);
  if (!result || typeof result !== "object") {
    throw new Error(`Box update RPC returned no payload for ${payload.boxId}.`);
  }

  return {
    logId: asTrimmedString(result.logId),
    warnings: Array.isArray(result.warnings) ? result.warnings.map((warning) => asTrimmedString(warning)) : []
  };
}

export async function applyZeroCandidates(client, orgId, actor, candidates, auditNote, updateBox = callBoxUpdateRpc) {
  const normalizedCandidates = validateApplyCandidates(candidates);
  const applied = [];

  for (const candidate of normalizedCandidates) {
    const payload = buildIl1ShelfAuditZeroOutPayload(candidate, auditNote);
    const result = await updateBox(client, orgId, actor, payload);
    applied.push({
      boxId: candidate.boxId,
      manufacturer: candidate.manufacturer,
      filmName: candidate.filmName,
      widthIn: candidate.widthIn,
      statusBefore: candidate.status,
      logId: asTrimmedString(result?.logId),
      warnings: Array.isArray(result?.warnings) ? result.warnings.filter(Boolean).join(" | ") : ""
    });
  }

  return applied.sort(sortByBoxId);
}
