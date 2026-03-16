// Purpose: Parse route parameters from query/body consistently for read and mutation routes.
export function routeParams(method, requestUrl, bodyJson) {
  if (method === 'GET') {
    const params = {};
    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (key === 'path') {
        continue;
      }

      params[key] = value;
    }

    return params;
  }

  const next = bodyJson && typeof bodyJson === 'object' ? { ...bodyJson } : {};
  delete next.path;
  delete next.authToken;
  delete next.authUser;
  return next;
}
