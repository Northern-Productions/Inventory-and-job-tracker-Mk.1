import type { Session, User } from '@supabase/supabase-js';
import type { AuthSession, AuthUser, EffectiveAccessContext } from '../../domain';

export function deriveNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] || '';
  const sanitized = localPart.replace(/[._-]+/g, ' ').trim();
  return sanitized || 'Inventory User';
}

export function buildAuthScopeSignature(
  nextSession: AuthSession | null | undefined,
  nextContext: EffectiveAccessContext | null | undefined
) {
  const userId = String(nextSession?.user?.sub || '').trim();
  const orgId = String(nextContext?.orgId || '').trim();
  if (!userId || !orgId) {
    return '';
  }

  const defaultWarehouse = String(nextContext?.defaultWarehouse || '').trim().toUpperCase();
  return `${userId}:${orgId}:${defaultWarehouse}`;
}

export function mapSupabaseSession(session: Session | null): AuthSession | null {
  if (!session || !session.access_token || !session.user || !session.user.email) {
    return null;
  }

  const email = session.user.email.trim();
  if (!email) {
    return null;
  }

  const profileName =
    readUserMetadataField(session.user, 'full_name') ||
    readUserMetadataField(session.user, 'name') ||
    deriveNameFromEmail(email);
  const avatarUrl = readUserMetadataField(session.user, 'avatar_url');

  const authUser: AuthUser = {
    email,
    hasProfileName: true,
    name: profileName,
    picture: avatarUrl,
    sub: session.user.id
  };

  const issuedAt = Date.now();
  const expiresAt =
    Number.isFinite(session.expires_at) && session.expires_at
      ? session.expires_at * 1000
      : issuedAt + 60 * 60 * 1000;

  return {
    token: session.access_token,
    user: authUser,
    issuedAt,
    expiresAt
  };
}

function readUserMetadataField(user: User, key: string): string {
  const value = user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata[key] : '';
  return typeof value === 'string' ? value.trim() : '';
}
