export function mapAccessContextErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : '';
  const normalized = message.toLowerCase();
  if (
    normalized.includes('relation "app.general_feature_permissions" does not exist') ||
    normalized.includes('relation "app.admin_feature_permissions" does not exist') ||
    normalized.includes('relation "app.access_requests" does not exist') ||
    normalized.includes('relation "app.username_change_requests" does not exist') ||
    normalized.includes('column "requested_by_name" does not exist') ||
    (normalized.includes('function public.api_get_auth_context') && normalized.includes('does not exist'))
  ) {
    return 'Database migrations 0006_access_control_and_approvals.sql, 0007_access_request_display_name.sql, 0008_username_change_requests.sql, and 0009_user_feature_overrides.sql are required. Run all four in Supabase, then refresh.';
  }

  return message || 'Your access details could not be loaded.';
}

export function isSessionExpiredOrMissingError(error: unknown): boolean {
  const message = error instanceof Error && error.message ? error.message.toLowerCase() : '';
  return (
    message.includes('authenticated session is required') ||
    (message.includes('jwt') && message.includes('invalid')) ||
    (message.includes('token') && message.includes('expired'))
  );
}
