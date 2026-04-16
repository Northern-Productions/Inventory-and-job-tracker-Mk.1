const BOX_SEARCH_FIELD_KEYS = Object.freeze([
  'boxId',
  'filmName',
  'filmKey',
  'lotRun',
  'manufacturer'
]);

const MATCH_KIND_PRIORITY = Object.freeze({
  exact: 0,
  prefix: 1,
  contains: 2,
  subsequence: 3
});

const VARIANT_PRIORITY = Object.freeze({
  readable: 0,
  compact: 1
});

function asSearchString(value) {
  return String(value ?? '').trim();
}

export function normalizeBoxSearchReadable(value) {
  return asSearchString(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizeBoxSearchCompact(value) {
  return normalizeBoxSearchReadable(value).replace(/[^a-z0-9]+/g, '');
}

function normalizeBoxSearchQuery(query) {
  return {
    readable: normalizeBoxSearchReadable(query),
    compact: normalizeBoxSearchCompact(query)
  };
}

function isWordBoundaryAt(value, index) {
  return index <= 0 || /[^a-z0-9]/.test(value[index - 1] || '');
}

function orderedSubsequenceIndex(needle, haystack) {
  if (!needle || needle.length < 3 || needle.length > haystack.length) {
    return -1;
  }

  let haystackIndex = 0;
  let firstIndex = -1;

  for (let index = 0; index < needle.length; index += 1) {
    const nextIndex = haystack.indexOf(needle[index], haystackIndex);
    if (nextIndex === -1) {
      return -1;
    }

    if (firstIndex === -1) {
      firstIndex = nextIndex;
    }

    haystackIndex = nextIndex + 1;
  }

  return firstIndex;
}

function compareBoxSearchMatchCandidates(left, right) {
  if (left.kind !== right.kind) {
    return MATCH_KIND_PRIORITY[left.kind] - MATCH_KIND_PRIORITY[right.kind];
  }

  const leftContainsPriority = left.kind === 'contains' ? (left.wordStart ? 0 : 1) : 0;
  const rightContainsPriority = right.kind === 'contains' ? (right.wordStart ? 0 : 1) : 0;
  if (leftContainsPriority !== rightContainsPriority) {
    return leftContainsPriority - rightContainsPriority;
  }

  if (left.fieldIndex !== right.fieldIndex) {
    return left.fieldIndex - right.fieldIndex;
  }

  if (left.position !== right.position) {
    return left.position - right.position;
  }

  if (left.compactLengthDelta !== right.compactLengthDelta) {
    return left.compactLengthDelta - right.compactLengthDelta;
  }

  if (left.variant !== right.variant) {
    return VARIANT_PRIORITY[left.variant] - VARIANT_PRIORITY[right.variant];
  }

  return 0;
}

export function compareBoxSearchMatches(left, right) {
  return compareBoxSearchMatchCandidates(left, right);
}

function chooseBetterBoxSearchMatch(currentBest, candidate) {
  if (!currentBest) {
    return candidate;
  }

  return compareBoxSearchMatchCandidates(candidate, currentBest) < 0 ? candidate : currentBest;
}

function evaluateBoxSearchField(fieldKey, fieldValue, normalizedQuery) {
  const readableValue = normalizeBoxSearchReadable(fieldValue);
  const compactValue = normalizeBoxSearchCompact(fieldValue);
  if (!readableValue && !compactValue) {
    return null;
  }

  let bestMatch = null;
  const fieldIndex = BOX_SEARCH_FIELD_KEYS.indexOf(fieldKey);

  if (normalizedQuery.readable && readableValue === normalizedQuery.readable) {
    bestMatch = chooseBetterBoxSearchMatch(bestMatch, {
      field: fieldKey,
      fieldIndex,
      kind: 'exact',
      position: 0,
      compactLengthDelta: Math.abs(compactValue.length - normalizedQuery.compact.length),
      variant: 'readable',
      wordStart: true
    });
  }

  if (normalizedQuery.compact && compactValue && compactValue === normalizedQuery.compact) {
    bestMatch = chooseBetterBoxSearchMatch(bestMatch, {
      field: fieldKey,
      fieldIndex,
      kind: 'exact',
      position: 0,
      compactLengthDelta: Math.abs(compactValue.length - normalizedQuery.compact.length),
      variant: 'compact',
      wordStart: true
    });
  }

  if (normalizedQuery.readable && readableValue.startsWith(normalizedQuery.readable)) {
    bestMatch = chooseBetterBoxSearchMatch(bestMatch, {
      field: fieldKey,
      fieldIndex,
      kind: 'prefix',
      position: 0,
      compactLengthDelta: Math.abs(compactValue.length - normalizedQuery.compact.length),
      variant: 'readable',
      wordStart: true
    });
  }

  if (normalizedQuery.compact && compactValue && compactValue.startsWith(normalizedQuery.compact)) {
    bestMatch = chooseBetterBoxSearchMatch(bestMatch, {
      field: fieldKey,
      fieldIndex,
      kind: 'prefix',
      position: 0,
      compactLengthDelta: Math.abs(compactValue.length - normalizedQuery.compact.length),
      variant: 'compact',
      wordStart: true
    });
  }

  if (normalizedQuery.readable) {
    const readableContainsIndex = readableValue.indexOf(normalizedQuery.readable);
    if (readableContainsIndex !== -1) {
      bestMatch = chooseBetterBoxSearchMatch(bestMatch, {
        field: fieldKey,
        fieldIndex,
        kind: 'contains',
        position: readableContainsIndex,
        compactLengthDelta: Math.abs(compactValue.length - normalizedQuery.compact.length),
        variant: 'readable',
        wordStart: isWordBoundaryAt(readableValue, readableContainsIndex)
      });
    }
  }

  if (normalizedQuery.compact && compactValue) {
    const compactContainsIndex = compactValue.indexOf(normalizedQuery.compact);
    if (compactContainsIndex !== -1) {
      bestMatch = chooseBetterBoxSearchMatch(bestMatch, {
        field: fieldKey,
        fieldIndex,
        kind: 'contains',
        position: compactContainsIndex,
        compactLengthDelta: Math.abs(compactValue.length - normalizedQuery.compact.length),
        variant: 'compact',
        wordStart: compactContainsIndex === 0
      });
    }

    const compactSubsequenceIndex = orderedSubsequenceIndex(normalizedQuery.compact, compactValue);
    if (compactSubsequenceIndex !== -1) {
      bestMatch = chooseBetterBoxSearchMatch(bestMatch, {
        field: fieldKey,
        fieldIndex,
        kind: 'subsequence',
        position: compactSubsequenceIndex,
        compactLengthDelta: Math.abs(compactValue.length - normalizedQuery.compact.length),
        variant: 'compact',
        wordStart: compactSubsequenceIndex === 0
      });
    }
  }

  return bestMatch;
}

export function getBoxSearchMatch(candidate, query) {
  const normalizedQuery =
    typeof query === 'string'
      ? normalizeBoxSearchQuery(query)
      : {
          readable: normalizeBoxSearchReadable(query?.readable),
          compact: normalizeBoxSearchCompact(query?.compact || query?.readable)
        };

  if (!normalizedQuery.readable && !normalizedQuery.compact) {
    return null;
  }

  let bestMatch = null;

  for (let index = 0; index < BOX_SEARCH_FIELD_KEYS.length; index += 1) {
    const fieldKey = BOX_SEARCH_FIELD_KEYS[index];
    const match = evaluateBoxSearchField(fieldKey, candidate?.[fieldKey], normalizedQuery);
    if (match) {
      bestMatch = chooseBetterBoxSearchMatch(bestMatch, match);
    }
  }

  return bestMatch;
}

export function matchesBoxSearchQuery(candidate, query) {
  return Boolean(getBoxSearchMatch(candidate, query));
}

export function rankBoxSearchCandidates(candidates, query) {
  const normalizedQuery = normalizeBoxSearchQuery(query);
  if (!normalizedQuery.readable && !normalizedQuery.compact) {
    return Array.isArray(candidates) ? candidates.slice() : [];
  }

  const ranked = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const match = getBoxSearchMatch(candidate, normalizedQuery);
    if (!match) {
      continue;
    }

    ranked.push({
      candidate,
      match,
      index
    });
  }

  ranked.sort((left, right) => compareBoxSearchMatchCandidates(left.match, right.match) || left.index - right.index);

  return ranked.map((entry) => entry.candidate);
}

