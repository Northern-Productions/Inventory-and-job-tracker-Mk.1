import { useState } from 'react';
import { useAuth } from './AuthContext';

type OrganizationSwitcherProps = {
  presentation?: 'inline' | 'account-menu';
  selectionRequired?: boolean;
};

export function OrganizationSwitcher({
  presentation = 'inline',
  selectionRequired = false
}: OrganizationSwitcherProps) {
  const auth = useAuth();
  const [pendingOrgId, setPendingOrgId] = useState('');
  const organizations = auth.accessContext?.organizations || [];

  if (organizations.length < 2 && !selectionRequired) {
    return null;
  }

  const selectedOrgId = auth.accessContext?.orgId || '';
  const value = pendingOrgId || selectedOrgId;
  const isAccountMenu = presentation === 'account-menu' && !selectionRequired;
  const pickerClassName = [
    'organization-picker',
    selectionRequired ? 'organization-picker-gate' : '',
    isAccountMenu ? 'organization-picker-menu' : ''
  ].filter(Boolean).join(' ');

  return (
    <label className={pickerClassName}>
      <span className={selectionRequired ? 'field-label' : isAccountMenu ? 'organization-picker-menu-label' : 'sr-only'}>
        Organization
      </span>
      <select
        aria-label="Organization"
        className={selectionRequired ? 'field-input' : `organization-picker-select${isAccountMenu ? ' organization-picker-menu-select' : ''}`}
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
