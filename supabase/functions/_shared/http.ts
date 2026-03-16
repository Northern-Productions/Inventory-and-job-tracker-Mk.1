// Purpose: Shared HTTP envelope and typed error for Edge API.
export class HttpError extends Error {
  statusCode: number;
  warnings: string[];

  constructor(statusCode: number, message: string, warnings: string[] = []) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.warnings = warnings;
  }
}

export function ok(data: unknown, warnings: string[] = []) {
  return {
    ok: true,
    data,
    warnings
  };
}
