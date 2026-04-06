import type { Box, Warehouse } from '../domain';

const TRAILING_LETTER_BOX_ID_PATTERN = /^([A-Z]{2}[1-9][0-9]*-[0-9]+)[A-Z]+$/;
const CANONICAL_PREFIXED_BOX_ID_PATTERN = /^[A-Z]{2}[1-9][0-9]*-.+/;
const LEGACY_PREFIXED_BOX_ID_PATTERN = /^[A-Z]+-(.+)$/;
const CANONICAL_WAREHOUSE_PREFIX_PATTERN = /^[A-Z]{2}[1-9][0-9]*/;

type BoxIdentity = Pick<Box, 'boxId' | 'warehouse'>;

function normalizeBoxIdValue(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function stripWarehousePrefixSuffixSeparators(value: string): string {
  return value.replace(/^-+/, '');
}

function stripCurrentWarehousePrefix(value: string, prefixToken: string): string {
  if (!prefixToken) {
    return value;
  }

  const barePrefix = prefixToken.slice(0, -1);
  let remainder = value;
  let didStripPrefix = false;

  while (remainder.startsWith(prefixToken)) {
    remainder = remainder.slice(prefixToken.length);
    didStripPrefix = true;
  }

  while (barePrefix && remainder.startsWith(barePrefix)) {
    remainder = remainder.slice(barePrefix.length);
    didStripPrefix = true;
  }

  return didStripPrefix ? stripWarehousePrefixSuffixSeparators(remainder) : value;
}

function stripLegacyWarehousePrefix(value: string): string {
  const canonicalMatch = value.match(CANONICAL_WAREHOUSE_PREFIX_PATTERN);
  if (canonicalMatch && value.charAt(canonicalMatch[0].length) === '-') {
    return stripWarehousePrefixSuffixSeparators(value.slice(canonicalMatch[0].length + 1));
  }

  const legacyMatch = value.match(LEGACY_PREFIXED_BOX_ID_PATTERN);
  if (legacyMatch) {
    return stripWarehousePrefixSuffixSeparators(legacyMatch[1]);
  }

  return stripWarehousePrefixSuffixSeparators(value);
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

export function getWarehouseBoxIdPrefixToken(warehousePrefix: string): string {
  const normalizedPrefix = normalizeBoxIdValue(warehousePrefix).replace(/-+$/, '');
  return normalizedPrefix ? `${normalizedPrefix}-` : '';
}

export function isWarehousePrefixOnlyBoxId(value: string, warehousePrefix: string): boolean {
  const normalizedValue = normalizeBoxIdValue(value);
  const prefixToken = getWarehouseBoxIdPrefixToken(warehousePrefix);
  if (!prefixToken) {
    return normalizedValue === '';
  }

  const barePrefix = prefixToken.slice(0, -1);
  return normalizedValue === barePrefix || normalizedValue === prefixToken;
}

export function normalizeCreateBoxIdForWarehouse(boxId: string, warehousePrefix: string): string {
  const prefixToken = getWarehouseBoxIdPrefixToken(warehousePrefix);
  const normalizedBoxId = normalizeBoxIdValue(boxId);
  if (!prefixToken) {
    return normalizedBoxId;
  }

  if (!normalizedBoxId) {
    return prefixToken;
  }

  const withoutCurrentPrefix = stripCurrentWarehousePrefix(normalizedBoxId, prefixToken);
  const suffix =
    withoutCurrentPrefix === normalizedBoxId
      ? stripLegacyWarehousePrefix(normalizedBoxId)
      : withoutCurrentPrefix;

  return `${prefixToken}${suffix}`;
}

export function remapCreateBoxIdForWarehouse(boxId: string, warehousePrefix: string): string {
  return normalizeCreateBoxIdForWarehouse(boxId, warehousePrefix);
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
