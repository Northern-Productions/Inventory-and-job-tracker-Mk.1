import { AccessRequestsSection } from './admin-access/AccessRequestsSection';
import { ApprovalNoteDialog } from './admin-access/ApprovalNoteDialog';
import { UsernameChangeRequestsSection } from './admin-access/UsernameChangeRequestsSection';
import { UserPermissionsDialog } from './admin-access/UserPermissionsDialog';
import { useAdminAccessPage } from './admin-access/useAdminAccessPage';

export default function AdminAccessPage() {
  const {
    accessRequestsSectionProps,
    approvalNoteDialogProps,
    userPermissionsDialogProps,
    usernameChangeRequestsSectionProps
  } = useAdminAccessPage();

  return (
    <>
      <AccessRequestsSection {...accessRequestsSectionProps} />
      <UsernameChangeRequestsSection {...usernameChangeRequestsSectionProps} />
      <UserPermissionsDialog {...userPermissionsDialogProps} />
      <ApprovalNoteDialog {...approvalNoteDialogProps} />
    </>
  );
}
