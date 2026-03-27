import type { Box, Warehouse } from '../domain';

const TRAILING_LETTER_BOX_ID_PATTERN = /^([A-Z]{2}[1-9][0-9]*-[0-9]+)[A-Z]+$/;
const CANONICAL_PREFIXED_BOX_ID_PATTERN = /^[A-Z]{2}[1-9][0-9]*-.+/;
const LEGACY_PREFIXED_BOX_ID_PATTERN = /^[A-Z]+-(.+)$/;

type BoxIdentity = Pick<Box, 'boxId' | 'warehouse'>;

function normalizeBoxIdValue(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function getDisplayBoxId(box: BoxIdentity): string {
  return formatBoxIdWithWarehousePrefix(box.boxId, box.warehouse);
}

function getBoxIdentityPreference(box: BoxIdentity): number {
  const normalizedBoxId = normalizeBoxIdValue(box.boxId);
  if (!normalizedBoxId) {
    return 0;
  }

  if (normalizedBoxId === getDisplayBoxId(box)) {
    return 3;
  }

  if (LEGACY_PREFIXED_BOX_ID_PATTERN.test(normalizedBoxId)) {
    return 2;
  }

  return 1;
}

function compareBoxIdentityPreference(left: BoxIdentity, right: BoxIdentity): number {
  const preferenceDelta = getBoxIdentityPreference(left) - getBoxIdentityPreference(right);
  if (preferenceDelta !== 0) {
    return preferenceDelta;
  }

  const normalizedLeft = normalizeBoxIdValue(left.boxId);
  const normalizedRight = normalizeBoxIdValue(right.boxId);
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length - normalizedRight.length;
  }

  if (normalizedLeft === normalizedRight) {
    return 0;
  }

  return normalizedLeft > normalizedRight ? 1 : -1;
}

export function normalizeTrailingLetterBoxId(value: string): string {
  const normalized = normalizeBoxIdValue(value);
  const match = normalized.match(TRAILING_LETTER_BOX_ID_PATTERN);
  return match ? match[1] : normalized;
}

export function formatBoxIdWithWarehousePrefix(boxId: string, warehouse: Warehouse | string): string {
  const normalizedBoxId = normalizeBoxIdValue(boxId);
  if (!normalizedBoxId) {
    return '';
  }

  if (CANONICAL_PREFIXED_BOX_ID_PATTERN.test(normalizedBoxId)) {
    return normalizedBoxId;
  }

  const normalizedWarehouse = String(warehouse || '').trim().toUpperCase().replace(/-+$/, '');
  if (!normalizedWarehouse) {
    return normalizedBoxId;
  }

  const legacyMatch = normalizedBoxId.match(LEGACY_PREFIXED_BOX_ID_PATTERN);
  const suffix = legacyMatch ? legacyMatch[1] : normalizedBoxId;
  return `${normalizedWarehouse}-${suffix}`;
}

export function dedupeBoxesByDisplayBoxId<T extends BoxIdentity>(boxes: T[]): T[] {
  const dedupedByDisplayBoxId = new Map<string, T>();

  for (let index = 0; index < boxes.length; index += 1) {
    const candidate = boxes[index];
    const displayBoxId = getDisplayBoxId(candidate) || normalizeBoxIdValue(candidate.boxId);
    if (!displayBoxId) {
      continue;
    }

    const existing = dedupedByDisplayBoxId.get(displayBoxId);
    if (!existing || compareBoxIdentityPreference(candidate, existing) > 0) {
      dedupedByDisplayBoxId.set(displayBoxId, candidate);
    }
  }

  return Array.from(dedupedByDisplayBoxId.values());
}
