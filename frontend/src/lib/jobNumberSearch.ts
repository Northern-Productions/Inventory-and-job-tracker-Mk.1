import type { JobListEntry } from '../domain';

function extractDigits(value: string): string {
  return String(value || '').replace(/[^0-9]/g, '');
}

function canonicalizeNumericDigits(digits: string): string {
  const withoutLeadingZeros = digits.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function compareJobsByDateAndId(left: JobListEntry, right: JobListEntry): number {
  if (left.dueDate && right.dueDate && left.dueDate !== right.dueDate) {
    return left.dueDate > right.dueDate ? -1 : 1;
  }

  if (left.dueDate && !right.dueDate) {
    return -1;
  }

  if (!left.dueDate && right.dueDate) {
    return 1;
  }

  if (left.updatedAt && right.updatedAt && left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }

  if (left.updatedAt && !right.updatedAt) {
    return -1;
  }

  if (!left.updatedAt && right.updatedAt) {
    return 1;
  }

  return left.jobNumber > right.jobNumber ? -1 : left.jobNumber < right.jobNumber ? 1 : 0;
}

interface RankedEntry {
  entry: JobListEntry;
  isPrefixMatch: boolean;
  isExactMatch: boolean;
  distance: bigint;
  lengthDelta: number;
}

export function rankActiveJobsByNumericCloseness(
  entries: JobListEntry[],
  query: string,
  limit = 25
): JobListEntry[] {
  const queryDigits = extractDigits(query);
  if (!queryDigits) {
    return [];
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }

  const queryCanonical = canonicalizeNumericDigits(queryDigits);
  const queryValue = BigInt(queryCanonical);
  const ranked: RankedEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const lifecycle = String(entry.lifecycleStatus || 'ACTIVE').toUpperCase();
    if (lifecycle !== 'ACTIVE') {
      continue;
    }

    const jobDigits = extractDigits(entry.jobNumber);
    if (!jobDigits) {
      continue;
    }

    const jobCanonical = canonicalizeNumericDigits(jobDigits);
    const jobValue = BigInt(jobCanonical);
    const isPrefixMatch = jobCanonical.startsWith(queryCanonical);
    ranked.push({
      entry,
      isPrefixMatch,
      isExactMatch: jobCanonical === queryCanonical,
      distance: absoluteBigInt(jobValue - queryValue),
      lengthDelta: Math.abs(jobCanonical.length - queryCanonical.length)
    });
  }

  ranked.sort((left, right) => {
    if (left.isPrefixMatch !== right.isPrefixMatch) {
      return left.isPrefixMatch ? -1 : 1;
    }

    if (left.isPrefixMatch && right.isPrefixMatch) {
      if (left.isExactMatch !== right.isExactMatch) {
        return left.isExactMatch ? -1 : 1;
      }

      if (left.lengthDelta !== right.lengthDelta) {
        return left.lengthDelta - right.lengthDelta;
      }
    }

    const distanceOrder = compareBigInt(left.distance, right.distance);
    if (distanceOrder !== 0) {
      return distanceOrder;
    }

    return compareJobsByDateAndId(left.entry, right.entry);
  });

  return ranked.slice(0, Math.floor(limit)).map((entry) => entry.entry);
}

