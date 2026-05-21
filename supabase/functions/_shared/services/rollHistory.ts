// Purpose: Roll-history service workflow for resolving usage entries tied to job allocations.
type RollHistoryDeps = {
  asTrimmedString: (value: unknown) => string;
  normalizeJobNumberKey: (jobNumber: unknown) => string;
  createServiceRoleClient: () => any;
  listBoxes: (client: any, orgId: string) => Promise<any[]>;
  listRollHistoryByBox: (client: any, orgId: string, boxId: string) => Promise<any[]>;
  mapDbRollHistoryRow: (row: any) => any;
};

function isUnknownJobNumber(value: unknown, normalizeJobNumberKey: (jobNumber: unknown) => string): boolean {
  const normalized = normalizeJobNumberKey(value);
  return !normalized || normalized === "UNKNOWN";
}

function toTimestampMs(value: unknown, asTrimmedString: (value: unknown) => string): number | null {
  const timestamp = asTrimmedString(value);
  if (!timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function getRollHistoryActivityTimestamp(entry: any, asTrimmedString: (value: unknown) => string): string {
  return asTrimmedString(entry.checkedInAt) || asTrimmedString(entry.checkedOutAt) || "";
}

function buildRollHistoryAllocationWindowsByBox(
  allocations: any[],
  asTrimmedString: (value: unknown) => string,
) {
  const grouped: Record<string, Array<{ startMs: number | null; endMs: number | null }>> = {};
  const entries = Array.isArray(allocations) ? allocations : [];
  for (const allocation of entries) {
    const boxId = asTrimmedString(allocation && allocation.boxId);
    if (!boxId) {
      continue;
    }
    if (!grouped[boxId]) {
      grouped[boxId] = [];
    }
    grouped[boxId].push({
      startMs: toTimestampMs(allocation && allocation.createdAt, asTrimmedString),
      endMs: toTimestampMs(allocation && allocation.resolvedAt, asTrimmedString),
    });
  }
  return grouped;
}

function isTimestampInAllocationWindow(
  timestampMs: number | null,
  window: { startMs: number | null; endMs: number | null },
): boolean {
  if (timestampMs === null) {
    return false;
  }
  if (window.startMs !== null && timestampMs < window.startMs) {
    return false;
  }
  if (window.endMs !== null && timestampMs > window.endMs) {
    return false;
  }
  return true;
}

function isRollHistoryEntryInAllocationWindow(
  entry: any,
  windows: Array<{ startMs: number | null; endMs: number | null }>,
  asTrimmedString: (value: unknown) => string,
) {
  if (!Array.isArray(windows) || !windows.length) {
    return false;
  }
  const activityTimestampMs = toTimestampMs(getRollHistoryActivityTimestamp(entry, asTrimmedString), asTrimmedString);
  const checkoutTimestampMs = toTimestampMs(entry && entry.checkedOutAt, asTrimmedString);
  return windows.some(
    (window) =>
      isTimestampInAllocationWindow(activityTimestampMs, window) ||
      isTimestampInAllocationWindow(checkoutTimestampMs, window),
  );
}

function buildRollHistoryEntryDedupeKey(entry: any, asTrimmedString: (value: unknown) => string): string {
  return `${asTrimmedString(entry && entry.logId)}|${asTrimmedString(entry && entry.boxId)}`;
}

function dedupeRollHistoryEntries(entries: any[], asTrimmedString: (value: unknown) => string) {
  const deduped: Record<string, any> = {};
  const source = Array.isArray(entries) ? entries : [];
  for (const entry of source) {
    if (!entry || !entry.boxId) {
      continue;
    }
    const key = buildRollHistoryEntryDedupeKey(entry, asTrimmedString);
    if (!deduped[key]) {
      deduped[key] = entry;
    }
  }
  return Object.values(deduped);
}

function shouldIncludeRollHistoryEntryForJob(
  entry: any,
  normalizedJobNumberKey: string,
  allocationWindowsByBox: Record<string, Array<{ startMs: number | null; endMs: number | null }>>,
  deps: Pick<RollHistoryDeps, "normalizeJobNumberKey" | "asTrimmedString">,
) {
  if (!entry || !entry.boxId) {
    return false;
  }
  if (deps.normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumberKey) {
    return true;
  }
  if (!isUnknownJobNumber(entry.jobNumber, deps.normalizeJobNumberKey)) {
    return false;
  }
  return isRollHistoryEntryInAllocationWindow(entry, allocationWindowsByBox[entry.boxId] || [], deps.asTrimmedString);
}

function finalizeRollHistoryEntriesForJob(
  entries: any[],
  normalizedJobNumberKey: string,
  allocationWindowsByBox: Record<string, Array<{ startMs: number | null; endMs: number | null }>>,
  deps: Pick<RollHistoryDeps, "normalizeJobNumberKey" | "asTrimmedString">,
) {
  const deduped = dedupeRollHistoryEntries(entries, deps.asTrimmedString);
  const filtered = deduped.filter((entry) =>
    shouldIncludeRollHistoryEntryForJob(entry, normalizedJobNumberKey, allocationWindowsByBox, deps)
  );
  filtered.sort((left, right) => {
    const leftDate = getRollHistoryActivityTimestamp(left, deps.asTrimmedString);
    const rightDate = getRollHistoryActivityTimestamp(right, deps.asTrimmedString);
    if (leftDate !== rightDate) {
      return leftDate > rightDate ? -1 : 1;
    }
    const leftLogId = deps.asTrimmedString(left.logId);
    const rightLogId = deps.asTrimmedString(right.logId);
    return leftLogId < rightLogId ? 1 : leftLogId > rightLogId ? -1 : 0;
  });
  return filtered;
}

function chunkStringValues(values: string[], size: number): string[][] {
  const source = Array.isArray(values) ? values : [];
  const chunkSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : 100;
  const chunks: string[][] = [];
  for (let index = 0; index < source.length; index += chunkSize) {
    chunks.push(source.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function listRollHistoryByJob(
  client: any,
  orgId: string,
  jobNumber: string,
  allocations: any[] = [],
  deps: RollHistoryDeps,
) {
  const normalizedJobNumber = deps.asTrimmedString(jobNumber);
  if (!normalizedJobNumber) {
    return [];
  }
  const normalizedJobNumberKey = deps.normalizeJobNumberKey(normalizedJobNumber);
  const allocationWindowsByBox = buildRollHistoryAllocationWindowsByBox(allocations, deps.asTrimmedString);
  const allocatedBoxIds = Object.keys(allocationWindowsByBox);

  const serviceClient = deps.createServiceRoleClient();
  if (serviceClient) {
    const directQuery = await serviceClient
      .schema("app")
      .from("roll_weight_log")
      .select("*")
      .eq("org_id", orgId)
      .eq("job_number", normalizedJobNumber)
      .order("checked_in_at", { ascending: false, nullsFirst: false })
      .order("checked_out_at", { ascending: false, nullsFirst: false })
      .order("log_id", { ascending: false });

    if (!directQuery.error) {
      const mergedEntries = (Array.isArray(directQuery.data) ? directQuery.data : []).map(deps.mapDbRollHistoryRow);
      let canUseServiceRoleResults = true;
      for (const boxIdChunk of chunkStringValues(allocatedBoxIds, 100)) {
        if (!boxIdChunk.length) {
          continue;
        }
        const allocatedQuery = await serviceClient
          .schema("app")
          .from("roll_weight_log")
          .select("*")
          .eq("org_id", orgId)
          .in("box_id", boxIdChunk)
          .order("checked_in_at", { ascending: false, nullsFirst: false })
          .order("checked_out_at", { ascending: false, nullsFirst: false })
          .order("log_id", { ascending: false });
        if (allocatedQuery.error) {
          canUseServiceRoleResults = false;
          break;
        }
        mergedEntries.push(...(Array.isArray(allocatedQuery.data) ? allocatedQuery.data : []).map(deps.mapDbRollHistoryRow));
      }
      if (canUseServiceRoleResults) {
        return finalizeRollHistoryEntriesForJob(mergedEntries, normalizedJobNumberKey, allocationWindowsByBox, deps);
      }
    }
  }

  const entries: any[] = [];
  const boxes = await deps.listBoxes(client, orgId);
  for (const box of boxes) {
    const boxEntries = await deps.listRollHistoryByBox(client, orgId, box.boxId);
    for (const entry of boxEntries) {
      entries.push(entry);
    }
  }
  return finalizeRollHistoryEntriesForJob(entries, normalizedJobNumberKey, allocationWindowsByBox, deps);
}
