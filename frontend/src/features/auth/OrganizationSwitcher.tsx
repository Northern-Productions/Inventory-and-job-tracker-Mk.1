import { useState } from 'react';
import { useAuth } from './AuthContext';

export function OrganizationSwitcher({ selectionRequired = false }: { selectionRequired?: boolean }) {
  const auth = useAuth();
  const [pendingOrgId, setPendingOrgId] = useState('');
  const organizations = auth.accessContext?.organizations || [];

  if (organizations.length < 2 && !selectionRequired) {
    return null;
  }

  const selectedOrgId = auth.accessContext?.orgId || '';
  const value = pendingOrgId || selectedOrgId;

  return (
    <label className={selectionRequired ? 'organization-picker organization-picker-gate' : 'organization-picker'}>
      <span className={selectionRequired ? 'field-label' : 'sr-only'}>Organization</span>
      <select
        aria-label="Organization"
        className={selectionRequired ? 'field-input' : 'organization-picker-select'}
        value={value}
        disabled={Boolean(pendingOrgId)}
        onChange={(event) => {
          const orgId = event.target.value;
          if (!orgId || orgId === selectedOrgId) {
            return;
          }
          setPendingOrgId(orgId);
          void auth.switchOrganization(orgId).catch(() => setPendingOrgId(''));
        }}
      >
        {selectionRequired ? <option value="">Choose an organization</option> : null}
        {organizations.map((organization) => (
          <option key={organization.orgId} value={organization.orgId}>
            {organization.name} ({organization.role === 'member' ? 'Member' : organization.role === 'admin' ? 'Admin' : 'Owner'})
          </option>
        ))}
      </select>
    </label>
  );
}
