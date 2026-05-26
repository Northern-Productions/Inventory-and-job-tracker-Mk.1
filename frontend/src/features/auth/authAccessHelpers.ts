import type { EffectiveAccessContext } from '../../domain';
import { createDefaultFeatureAccessMap } from '../../domain';
import { stripPasswordRecoveryUrlState } from './authRecovery';

export function normalizeAccessContext(
  nextContext: EffectiveAccessContext
): EffectiveAccessContext {
  return {
    ...nextContext,
    defaultWarehouse: String(nextContext.defaultWarehouse || '').trim().toUpperCase(),
    permissions: {
      ...createDefaultFeatureAccessMap(),
      ...nextContext.permissions
    }
  };
}

export function clearRecoveryUrlState() {
  if (
    typeof window === 'undefined' ||
    !window.history ||
    typeof window.history.replaceState !== 'function'
  ) {
    return;
  }

  const currentRelativeUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const nextRelativeUrl = stripPasswordRecoveryUrlState(window.location);

  if (nextRelativeUrl !== currentRelativeUrl) {
    window.history.replaceState({}, document.title, nextRelativeUrl);
  }
}
