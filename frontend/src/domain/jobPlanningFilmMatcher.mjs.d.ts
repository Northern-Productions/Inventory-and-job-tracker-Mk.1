export type JobPlanningFilmMatchKind = 'exact' | 'prefix';

export interface JobPlanningFilmDescriptor {
  manufacturer: string;
  manufacturerKey: string;
  filmName: string;
  familyFilmName: string;
  key: string;
  familyKey: string;
  compactFilmName: string;
  compactFamilyFilmName: string;
  compactBaseCode: string;
  isExterior: boolean;
}

export interface JobPlanningFilmMatch {
  kind: JobPlanningFilmMatchKind;
  compactLengthDelta: number;
  candidateFamilyLength: number;
  requirementFamilyLength: number;
}

export function inferNightVisionCode(value: unknown): string;
export function canonicalizeJobPlanningManufacturerAndFilm(
  manufacturer: unknown,
  filmName: unknown
): { manufacturer: string; filmName: string };
export function describeJobPlanningFilm(
  manufacturer: unknown,
  filmName: unknown
): JobPlanningFilmDescriptor;
export function buildJobPlanningFilmKey(manufacturer: unknown, filmName: unknown): string;
export function buildJobPlanningFilmFamilyKey(manufacturer: unknown, filmName: unknown): string;
export function getJobPlanningFilmMatch(
  candidateManufacturer: unknown,
  candidateFilmName: unknown,
  requirementManufacturer: unknown,
  requirementFilmName: unknown
): JobPlanningFilmMatch | null;
export function compareJobPlanningFilmMatches(
  left: JobPlanningFilmMatch,
  right: JobPlanningFilmMatch
): number;
export function canJobPlanningFilmSatisfyRequirement(
  candidateManufacturer: unknown,
  candidateFilmName: unknown,
  requirementManufacturer: unknown,
  requirementFilmName: unknown
): boolean;
