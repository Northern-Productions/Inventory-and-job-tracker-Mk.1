import { HttpError } from "../http.ts";

export function asTrimmedString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

export function chunkValues<T>(values: T[], size: number): T[][] {
  const normalizedSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : values.length || 1;
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += normalizedSize) {
    chunks.push(values.slice(index, index + normalizedSize));
  }
  return chunks;
}

export function requireString(value: unknown, fieldName: string): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    throw new HttpError(400, `${fieldName} is required.`);
  }
  return trimmed;
}

export function normalizeStringArrayParam(value: unknown): string[] {
  const rawValues = Array.isArray(value) ? value : [value];
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of rawValues) {
    const tokens = typeof rawValue === "string" ? rawValue.split(",") : [rawValue];
    for (const token of tokens) {
      const trimmed = asTrimmedString(token);
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }

      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  return normalized;
}

export function normalizeDateString(value: unknown, fieldName: string, allowBlank: boolean): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    if (allowBlank) {
      return "";
    }
    throw new HttpError(400, `${fieldName} is required.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new HttpError(400, `${fieldName} must use yyyy-mm-dd.`);
  }
  return trimmed;
}

export function coerceFeetValue(
  value: unknown,
  fieldName: string,
  warnings: string[],
  allowNegativeClamp: boolean,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${fieldName} must be numeric.`);
  }
  const floored = Math.floor(parsed);
  if (floored !== parsed) {
    warnings.push(`${fieldName} was rounded down to ${floored}.`);
  }
  if (floored < 0) {
    if (allowNegativeClamp) {
      warnings.push(`${fieldName} was clamped to 0.`);
      return 0;
    }
    throw new HttpError(400, `${fieldName} must be zero or greater.`);
  }
  return floored;
}

export function formatTimestamp(value: unknown): string {
  if (!value) {
    return "";
  }
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function formatDateValue(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const iso = value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  return iso.slice(0, 10);
}

export function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function integerOrZero(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function normalizeCaulkCaseMath(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return {};
  }

  const source = result as Record<string, unknown>;
  const tubesOnHand = Math.max(0, integerOrZero(source.tubesOnHand ?? source.tubes_on_hand));
  const casesOnHand = Math.floor(tubesOnHand / 16);
  const looseTubes = Math.max(0, tubesOnHand - (casesOnHand * 16));

  return {
    ...source,
    tubesOnHand,
    casesOnHand,
    looseTubes,
  };
}

export function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function createLogId(): string {
  const now = new Date();
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
    String(now.getUTCMilliseconds()).padStart(3, "0"),
  ].join("");
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  const suffix = String(((bytes[0] << 8) | bytes[1]) % 1000).padStart(3, "0");
  return `${timestamp}-${suffix}`;
}
