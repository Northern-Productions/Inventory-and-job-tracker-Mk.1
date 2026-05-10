// Purpose: Shared HTTP envelope and typed error for Edge API.
export class HttpError extends Error {
  statusCode: number;
  warnings: string[];
  details: Record<string, unknown> | null;

  constructor(
    statusCode: number,
    message: string,
    warnings: string[] = [],
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.warnings = warnings;
    this.details = details && typeof details === "object" ? details : null;
  }
}

export function ok(data: unknown, warnings: string[] = []) {
  return {
    ok: true,
    data,
    warnings
  };
}
