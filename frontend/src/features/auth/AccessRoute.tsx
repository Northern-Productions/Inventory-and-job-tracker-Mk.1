import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { FeatureAccessMode, FeatureArea } from '../../domain';
import { useAuth } from './AuthContext';

interface AccessRouteProps {
  children: ReactNode;
  feature?: FeatureArea;
  mode?: FeatureAccessMode;
  requireAdminConsole?: boolean;
  requireOwner?: boolean;
}

function AccessDenied({
  title,
  description
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <p className="muted-text">{description}</p>
      <Link className="nav-link" to="/">
        Return to Inventory
      </Link>
    </section>
  );
}

export function AccessRoute({
  children,
  feature,
  mode = 'read',
  requireAdminConsole = false,
  requireOwner = false
}: AccessRouteProps) {
  const auth = useAuth();

  if (!auth.isApproved) {
    return (
      <AccessDenied
        title="Access Pending"
        description="Your account does not currently have approved workspace access."
      />
    );
  }

  if (requireOwner && !auth.isOwner) {
    return (
      <AccessDenied
        title="Owner Access Required"
        description="Only owners can open this page."
      />
    );
  }

  if (requireAdminConsole && !auth.canAccessAdminConsole) {
    return (
      <AccessDenied
        title="Admin Access Required"
        description="You do not have access to workspace approval and permissions controls."
      />
    );
  }

  if (feature && !auth.hasFeatureAccess(feature, mode)) {
    return (
      <AccessDenied
        title="Feature Access Denied"
        description="Your role does not currently allow this feature."
      />
    );
  }

  return <>{children}</>;
}
