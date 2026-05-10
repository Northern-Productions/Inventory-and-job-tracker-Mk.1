export const BLANK_WORK_SCOPE_KEY = 'blank:';

function asWorkScopeString(value) {
  return String(value ?? '');
}

export function normalizeJobWorkScopeDisplay(value) {
  const trimmed = asWorkScopeString(value).trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\s+/g, ' ');
}

function normalizeWorkScopeKeyText(value) {
  const display = normalizeJobWorkScopeDisplay(value);
  if (!display) {
    return null;
  }

  return display
    .toLocaleLowerCase('en-US')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSectionNumber(value) {
  const withoutLeadingZeros = value.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

function compareSectionNumbers(left, right) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue < rightValue) {
    return -1;
  }

  if (leftValue > rightValue) {
    return 1;
  }

  return 0;
}

function buildSectionListKey(normalizedText) {
  const sectionCandidate = normalizedText.replace(/^(?:sections?|secs?)\.?\s+/, '');
  const tokenSource = sectionCandidate
    .replace(/\band\b/g, ',')
    .replace(/[;&]/g, ',');

  if (!/^[0-9,\s]+$/.test(tokenSource)) {
    return null;
  }

  const tokens = tokenSource.split(/[,\s]+/).filter(Boolean);
  if (!tokens.length) {
    return null;
  }

  const sectionNumbers = Array.from(new Set(tokens.map(normalizeSectionNumber)));
  sectionNumbers.sort(compareSectionNumbers);

  return `section:${sectionNumbers.join(',')}`;
}

export function normalizeJobWorkScopeKey(value) {
  const normalizedText = normalizeWorkScopeKeyText(value);
  if (!normalizedText) {
    return BLANK_WORK_SCOPE_KEY;
  }

  return buildSectionListKey(normalizedText) || `text:${normalizedText}`;
}

export function normalizeJobSectionsDisplay(value) {
  return normalizeJobWorkScopeDisplay(value);
}

export function normalizeJobSectionsKey(value) {
  return normalizeJobWorkScopeKey(value);
}
