function normalizeWidthIn(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.round(parsed * 1000) / 1000;
}

function normalizeWholeFeet(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.floor(parsed);
}

export function isSplitCoveragePair(sourceWidthIn, requirementWidthIn) {
  return getAllocationCoverageMultiplier(sourceWidthIn, requirementWidthIn) > 1;
}

export function getAllocationCoverageMultiplier(sourceWidthIn, requirementWidthIn) {
  const sourceWidth = normalizeWidthIn(sourceWidthIn);
  const requirementWidth = normalizeWidthIn(requirementWidthIn);

  if (sourceWidth <= 0 || requirementWidth <= 0 || sourceWidth < requirementWidth) {
    return 0;
  }

  return Math.max(1, Math.floor(sourceWidth / requirementWidth));
}

export function computePhysicalFeetForCoverage(requestedCoveredFeet, sourceWidthIn, requirementWidthIn) {
  const requestedFeet = normalizeWholeFeet(requestedCoveredFeet);
  if (requestedFeet <= 0) {
    return 0;
  }

  const multiplier = getAllocationCoverageMultiplier(sourceWidthIn, requirementWidthIn);
  if (multiplier <= 0) {
    return 0;
  }

  return Math.ceil(requestedFeet / multiplier);
}

export function computeCoveredFeetForAllocation(
  allocatedFeet,
  sourceWidthIn,
  requirementWidthIn,
  maxCoveredFeet = Number.MAX_SAFE_INTEGER
) {
  const physicalFeet = normalizeWholeFeet(allocatedFeet);
  if (physicalFeet <= 0) {
    return 0;
  }

  const multiplier = getAllocationCoverageMultiplier(sourceWidthIn, requirementWidthIn);
  if (multiplier <= 0) {
    return 0;
  }

  const coveredFeet = physicalFeet * multiplier;
  const cappedCoveredFeet = Number.isFinite(Number(maxCoveredFeet))
    ? Math.max(0, Math.floor(Number(maxCoveredFeet)))
    : Number.MAX_SAFE_INTEGER;

  return Math.min(coveredFeet, cappedCoveredFeet);
}

export function planCoverageAllocation(
  requestedCoveredFeet,
  availablePhysicalFeet,
  sourceWidthIn,
  requirementWidthIn
) {
  const requestedFeet = normalizeWholeFeet(requestedCoveredFeet);
  const availableFeet = normalizeWholeFeet(availablePhysicalFeet);

  if (requestedFeet <= 0 || availableFeet <= 0) {
    return {
      allocatedFeet: 0,
      coveredFeet: 0,
      remainingCoveredFeet: requestedFeet,
      usesSplitCoverage: isSplitCoveragePair(sourceWidthIn, requirementWidthIn)
    };
  }

  const multiplier = getAllocationCoverageMultiplier(sourceWidthIn, requirementWidthIn);
  if (multiplier <= 0) {
    return {
      allocatedFeet: 0,
      coveredFeet: 0,
      remainingCoveredFeet: requestedFeet,
      usesSplitCoverage: false
    };
  }

  const allocatedFeet = Math.min(
    availableFeet,
    computePhysicalFeetForCoverage(requestedFeet, sourceWidthIn, requirementWidthIn)
  );
  const coveredFeet = computeCoveredFeetForAllocation(
    allocatedFeet,
    sourceWidthIn,
    requirementWidthIn,
    requestedFeet
  );

  return {
    allocatedFeet,
    coveredFeet,
    remainingCoveredFeet: Math.max(0, requestedFeet - coveredFeet),
    usesSplitCoverage: isSplitCoveragePair(sourceWidthIn, requirementWidthIn)
  };
}
