const JOB_NUMBER_MATCH_KIND_PRIORITY = Object.freeze({
  exact: 0,
  prefix: 1,
  contains: 2
});

function asJobNumberString(value) {
  return String(value ?? '');
}

export function normalizeJobNumberSearchDigits(value) {
  return asJobNumberString(value).replace(/[^0-9]/g, '');
}

export function canonicalizeJobNumberSearchDigits(value) {
  const digits = normalizeJobNumberSearchDigits(value);
  if (!digits) {
    return '';
  }

  const withoutLeadingZeros = digits.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

function readCandidateJobNumber(candidate, getValue) {
  if (typeof getValue === 'function') {
    return getValue(candidate);
  }

  if (candidate && typeof candidate === 'object' && 'jobNumber' in candidate) {
    return candidate.jobNumber;
  }

  return candidate;
}

export function getJobNumberSearchMatch(candidateJobNumber, query) {
  const candidateCanonical = canonicalizeJobNumberSearchDigits(candidateJobNumber);
  const queryCanonical = canonicalizeJobNumberSearchDigits(query);
  if (!candidateCanonical || !queryCanonical) {
    return null;
  }

  const canonicalLengthDelta = Math.abs(candidateCanonical.length - queryCanonical.length);
  if (candidateCanonical === queryCanonical) {
    return {
      kind: 'exact',
      position: 0,
      canonicalLengthDelta
    };
  }

  if (candidateCanonical.startsWith(queryCanonical)) {
    return {
      kind: 'prefix',
      position: 0,
      canonicalLengthDelta
    };
  }

  const containsIndex = candidateCanonical.indexOf(queryCanonical);
  if (containsIndex !== -1) {
    return {
      kind: 'contains',
      position: containsIndex,
      canonicalLengthDelta
    };
  }

  return null;
}

export function compareJobNumberSearchMatches(left, right) {
  if (left.kind !== right.kind) {
    return JOB_NUMBER_MATCH_KIND_PRIORITY[left.kind] - JOB_NUMBER_MATCH_KIND_PRIORITY[right.kind];
  }

  if (left.position !== right.position) {
    return left.position - right.position;
  }

  if (left.canonicalLengthDelta !== right.canonicalLengthDelta) {
    return left.canonicalLengthDelta - right.canonicalLengthDelta;
  }

  return 0;
}

export function matchesJobNumberSearch(candidateJobNumber, query) {
  return getJobNumberSearchMatch(candidateJobNumber, query) !== null;
}

export function rankJobNumberSearchCandidates(candidates, query, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const queryCanonical = canonicalizeJobNumberSearchDigits(query);
  if (!queryCanonical) {
    return [];
  }

  const compareWithinMatch =
    typeof options.compareWithinMatch === 'function' ? options.compareWithinMatch : null;
  const limit =
    Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : null;
  const ranked = [];

  for (let index = 0; index < list.length; index += 1) {
    const candidate = list[index];
    const match = getJobNumberSearchMatch(readCandidateJobNumber(candidate, options.getValue), queryCanonical);
    if (!match) {
      continue;
    }

    ranked.push({
      candidate,
      match
    });
  }

  ranked.sort((left, right) => {
    const matchOrder = compareJobNumberSearchMatches(left.match, right.match);
    if (matchOrder !== 0) {
      return matchOrder;
    }

    if (compareWithinMatch) {
      return compareWithinMatch(left.candidate, right.candidate);
    }

    return 0;
  });

  const result = ranked.map((entry) => entry.candidate);
  return limit === null ? result : result.slice(0, limit);
}
