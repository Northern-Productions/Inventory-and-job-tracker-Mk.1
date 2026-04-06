export const PASSWORD_RESET_REQUEST_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';
export const PASSWORD_RESET_SUCCESS_MESSAGE =
  'Password updated. Sign in with your new password.';
export const PASSWORD_RESET_INVALID_LINK_MESSAGE =
  'This password reset link is invalid or has expired. Request a new one.';

type RecoveryLocation = Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>;

const AUTH_QUERY_PARAM_KEYS = [
  'access_token',
  'code',
  'error',
  'error_code',
  'error_description',
  'expires_at',
  'expires_in',
  'provider_refresh_token',
  'provider_token',
  'refresh_token',
  'token_type',
  'type'
] as const;

function getHashParams(hash: string) {
  if (!hash || hash.startsWith('#/')) {
    return new URLSearchParams();
  }

  return new URLSearchParams(hash.replace(/^#/, ''));
}

export function buildPasswordResetRedirectUrl(
  currentLocation: RecoveryLocation = window.location
) {
  return `${currentLocation.origin}${currentLocation.pathname}`;
}

export function isPasswordRecoveryUrl(
  currentLocation: Pick<RecoveryLocation, 'search' | 'hash'> = window.location
) {
  const searchParams = new URLSearchParams(currentLocation.search || '');
  const hashParams = getHashParams(currentLocation.hash || '');

  return (
    searchParams.get('type') === 'recovery' ||
    hashParams.get('type') === 'recovery'
  );
}

export function stripPasswordRecoveryUrlState(
  currentLocation: Pick<RecoveryLocation, 'pathname' | 'search' | 'hash'> = window.location
) {
  const nextSearchParams = new URLSearchParams(currentLocation.search || '');
  for (let index = 0; index < AUTH_QUERY_PARAM_KEYS.length; index += 1) {
    nextSearchParams.delete(AUTH_QUERY_PARAM_KEYS[index]);
  }

  const nextSearch = nextSearchParams.toString();
  const nextHash = currentLocation.hash && currentLocation.hash.startsWith('#/')
    ? currentLocation.hash
    : '';

  return `${currentLocation.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash}`;
}
