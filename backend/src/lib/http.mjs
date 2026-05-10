// Purpose: Shared HTTP helpers and error type for backend handlers.
export class HttpError extends Error {
  constructor(statusCode, message, warnings = [], details = null) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.warnings = warnings;
    this.details = details && typeof details === 'object' ? details : null;
  }
}

export function ok(data, warnings = []) {
  return {
    ok: true,
    data,
    warnings
  };
}
