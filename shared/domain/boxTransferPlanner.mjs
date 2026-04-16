import { WAREHOUSE_CODE_PATTERN } from './runtimeContract.mjs';

function normalizeTransferPlannerString(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeWarehousePrefix(prefix) {
  return normalizeTransferPlannerString(prefix).replace(/-+$/g, '');
}

function normalizePlannerBoxId(boxId) {
  return normalizeTransferPlannerString(boxId);
}

function buildWarehousePrefixSet(warehousePrefixes, sourcePrefix, destinationPrefix) {
  const normalizedPrefixes = new Set();
  const values = Array.isArray(warehousePrefixes) ? warehousePrefixes : [];

  for (let index = 0; index < values.length; index += 1) {
    const normalized = normalizeWarehousePrefix(values[index]);
    if (normalized && WAREHOUSE_CODE_PATTERN.test(normalized)) {
      normalizedPrefixes.add(normalized);
    }
  }

  const normalizedSourcePrefix = normalizeWarehousePrefix(sourcePrefix);
  if (normalizedSourcePrefix) {
    normalizedPrefixes.add(normalizedSourcePrefix);
  }

  const normalizedDestinationPrefix = normalizeWarehousePrefix(destinationPrefix);
  if (normalizedDestinationPrefix) {
    normalizedPrefixes.add(normalizedDestinationPrefix);
  }

  return normalizedPrefixes;
}

function splitBoxIdRemainder(boxId, currentPrefix) {
  const normalizedBoxId = normalizePlannerBoxId(boxId);
  const normalizedCurrentPrefix = normalizeWarehousePrefix(currentPrefix);
  const prefixedToken = normalizedCurrentPrefix ? `${normalizedCurrentPrefix}-` : '';

  if (prefixedToken && normalizedBoxId.startsWith(prefixedToken)) {
    return normalizedBoxId.slice(prefixedToken.length);
  }

  const dashIndex = normalizedBoxId.indexOf('-');
  if (dashIndex >= 0 && dashIndex < normalizedBoxId.length - 1) {
    return normalizedBoxId.slice(dashIndex + 1);
  }

  return normalizedBoxId;
}

export function describeTransferredBoxId(boxId, currentPrefix, warehousePrefixes = []) {
  const normalizedCurrentPrefix = normalizeWarehousePrefix(currentPrefix);
  const remainder = splitBoxIdRemainder(boxId, normalizedCurrentPrefix);
  const remainderSegments = remainder
    .split('-')
    .map((segment) => normalizeTransferPlannerString(segment))
    .filter(Boolean);
  const knownPrefixes = buildWarehousePrefixSet(warehousePrefixes, normalizedCurrentPrefix, '');
  let originIndex = -1;

  for (let index = 1; index < remainderSegments.length; index += 1) {
    const candidatePrefix = normalizeWarehousePrefix(remainderSegments[index]);
    if (!candidatePrefix || candidatePrefix === normalizedCurrentPrefix) {
      continue;
    }

    if (knownPrefixes.has(candidatePrefix)) {
      originIndex = index;
      break;
    }
  }

  const localSegments =
    originIndex >= 1
      ? remainderSegments.slice(0, originIndex)
      : remainderSegments.length > 0
        ? remainderSegments
        : [normalizePlannerBoxId(boxId)];
  const originAndExtraSegments = originIndex >= 1 ? remainderSegments.slice(originIndex) : [];
  const originPrefix = originAndExtraSegments.length > 0 ? normalizeWarehousePrefix(originAndExtraSegments[0]) : '';
  const extraSegments = originAndExtraSegments.slice(1);

  return {
    currentPrefix: normalizedCurrentPrefix,
    localSegments,
    originPrefix,
    extraSegments,
    isTransferred: Boolean(originPrefix)
  };
}

function joinBoxIdSegments(prefix, segments) {
  const normalizedPrefix = normalizeWarehousePrefix(prefix);
  const normalizedSegments = (Array.isArray(segments) ? segments : [])
    .map((segment) => normalizeTransferPlannerString(segment))
    .filter(Boolean);

  return [normalizedPrefix, ...normalizedSegments].filter(Boolean).join('-');
}

export function buildTransferredBoxId(boxId, sourcePrefix, destinationPrefix, warehousePrefixes = []) {
  const normalizedSourcePrefix = normalizeWarehousePrefix(sourcePrefix);
  const normalizedDestinationPrefix = normalizeWarehousePrefix(destinationPrefix);

  if (!normalizedSourcePrefix || !normalizedDestinationPrefix) {
    return joinBoxIdSegments(normalizedDestinationPrefix || normalizedSourcePrefix, [boxId]);
  }

  const descriptor = describeTransferredBoxId(boxId, normalizedSourcePrefix, warehousePrefixes);

  if (descriptor.originPrefix && descriptor.originPrefix === normalizedDestinationPrefix) {
    return joinBoxIdSegments(normalizedDestinationPrefix, [
      ...descriptor.localSegments,
      ...descriptor.extraSegments
    ]);
  }

  if (descriptor.originPrefix) {
    return joinBoxIdSegments(normalizedDestinationPrefix, [
      ...descriptor.localSegments,
      descriptor.originPrefix,
      ...descriptor.extraSegments
    ]);
  }

  return joinBoxIdSegments(normalizedDestinationPrefix, [
    ...descriptor.localSegments,
    normalizedSourcePrefix
  ]);
}

export function planTransferredBoxId(
  boxId,
  sourcePrefix,
  destinationPrefix,
  warehousePrefixes = [],
  destinationBoxIdOverride = ''
) {
  const normalizedDestinationPrefix = normalizeWarehousePrefix(destinationPrefix);
  const normalizedOverride = normalizePlannerBoxId(destinationBoxIdOverride);

  if (!normalizedOverride) {
    return buildTransferredBoxId(boxId, sourcePrefix, destinationPrefix, warehousePrefixes);
  }

  const expectedPrefixToken = normalizedDestinationPrefix ? `${normalizedDestinationPrefix}-` : '';
  if (!expectedPrefixToken || !normalizedOverride.startsWith(expectedPrefixToken)) {
    throw new Error(`Arrival Box ID must start with ${expectedPrefixToken || normalizedDestinationPrefix}.`);
  }

  if (!normalizedOverride.slice(expectedPrefixToken.length).trim()) {
    throw new Error('Arrival Box ID must include characters after the warehouse prefix.');
  }

  return normalizedOverride;
}
