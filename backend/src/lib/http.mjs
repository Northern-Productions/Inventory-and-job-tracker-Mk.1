// Purpose: Shared HTTP helpers and error type for backend handlers.
export class HttpError extends Error {
  constructor(statusCode, message, warnings = []) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.warnings = warnings;
  }
}

export function ok(data, warnings = []) {
  return {
    ok: true,
    data,
    warnings
  };
}
