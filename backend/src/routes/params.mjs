// Purpose: Parse route parameters from query/body consistently for read and mutation routes.
export function routeParams(method, requestUrl, bodyJson) {
  const normalizedMethod = String(method || '').toUpperCase();
  if (normalizedMethod === 'GET') {
    const params = {};
    const searchParams =
      requestUrl && typeof requestUrl === 'object' ? requestUrl.searchParams : null;

    if (!searchParams || typeof searchParams.entries !== 'function') {
      return params;
    }

    for (const [key, value] of searchParams.entries()) {
      if (key === 'path' || key === 'authToken' || key === 'authUser') {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(params, key)) {
        const current = params[key];
        params[key] = Array.isArray(current) ? [...current, value] : [current, value];
        continue;
      }

      params[key] = value;
    }

    return params;
  }

  const isPlainObject = Boolean(bodyJson) && typeof bodyJson === 'object' && !Array.isArray(bodyJson);
  const next = isPlainObject ? { ...bodyJson } : {};
  delete next.path;
  delete next.authToken;
  delete next.authUser;
  return next;
}
