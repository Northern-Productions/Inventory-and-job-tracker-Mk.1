const DEFAULT_TUBES_PER_CASE = 16;

function normalizeCaseSize(tubesPerCase: number) {
  const normalized = Number.isFinite(tubesPerCase) ? Math.trunc(tubesPerCase) : 0;
  return normalized > 0 ? normalized : DEFAULT_TUBES_PER_CASE;
}

export function normalizeWholeNumberInput(value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return {
      value: 0,
      error: ''
    };
  }

  if (!/^\d+$/.test(trimmed)) {
    return {
      value: 0,
      error: 'Enter a whole number greater than or equal to zero.'
    };
  }

  return {
    value: Math.max(0, Math.trunc(Number(trimmed))),
    error: ''
  };
}

export function toFullCasesFromTubes(totalTubes: number, tubesPerCase = DEFAULT_TUBES_PER_CASE) {
  const normalized = Number.isFinite(totalTubes) ? Math.max(0, Math.trunc(totalTubes)) : 0;
  return Math.floor(normalized / normalizeCaseSize(tubesPerCase));
}

export function toLooseTubesFromTubes(totalTubes: number, tubesPerCase = DEFAULT_TUBES_PER_CASE) {
  const normalized = Number.isFinite(totalTubes) ? Math.max(0, Math.trunc(totalTubes)) : 0;
  return normalized % normalizeCaseSize(tubesPerCase);
}

export function toTubesFromCasesAndLoose(
  cases: number,
  looseTubes: number,
  tubesPerCase = DEFAULT_TUBES_PER_CASE
) {
  const normalizedCases = Number.isFinite(cases) ? Math.max(0, Math.trunc(cases)) : 0;
  const normalizedLooseTubes = Number.isFinite(looseTubes)
    ? Math.max(0, Math.trunc(looseTubes))
    : 0;
  return normalizedCases * normalizeCaseSize(tubesPerCase) + normalizedLooseTubes;
}
