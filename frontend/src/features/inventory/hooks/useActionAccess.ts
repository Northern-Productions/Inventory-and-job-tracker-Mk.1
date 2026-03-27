import type { FeatureArea } from '../../../domain';
import { useToast } from '../../../components/Toast';
import { useAuth } from '../../auth/AuthContext';

interface EnsureActionAccessOptions {
  actionLabel: string;
  feature?: FeatureArea;
  requireWriteAccess?: boolean;
  notConfiguredDescription?: string;
  signInDescription?: string;
  permissionDeniedTitle?: string;
  permissionDeniedDescription?: string;
}

export function useActionAccess() {
  const toast = useToast();
  const auth = useAuth();

  return function ensureActionAccess(options: EnsureActionAccessOptions) {
    const {
      actionLabel,
      feature,
      requireWriteAccess = false,
      notConfiguredDescription = `Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before ${actionLabel}.`,
      signInDescription = `Sign in with email/password before ${actionLabel}.`,
      permissionDeniedTitle = 'Permission denied',
      permissionDeniedDescription = `Your account cannot ${actionLabel}.`
    } = options;

    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: notConfiguredDescription,
        variant: 'error'
      });
      return false;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: signInDescription,
        variant: 'error'
      });
      return false;
    }

    if (feature && requireWriteAccess && !auth.hasFeatureAccess(feature, 'write')) {
      toast.push({
        title: permissionDeniedTitle,
        description: permissionDeniedDescription,
        variant: 'error'
      });
      return false;
    }

    return true;
  };
}
