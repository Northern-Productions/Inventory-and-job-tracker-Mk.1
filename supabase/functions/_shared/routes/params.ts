// Purpose: Parse route parameters from GET query strings and POST payloads.
export function routeParams(method: string, requestUrl: URL, bodyJson: Record<string, unknown> | null) {
  if (method === "GET") {
    const params: Record<string, unknown> = {};
    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (key === "path") {
        continue;
      }
      params[key] = value;
    }
    return params;
  }

  const next = bodyJson && typeof bodyJson === "object" ? { ...bodyJson } : {};
  delete next.path;
  delete next.authToken;
  delete next.authUser;
  return next;
}
