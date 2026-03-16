// Purpose: Access-management and permission API surface.
export {
  approveAccessRequest,
  approveUsernameChangeRequest,
  denyAccessRequest,
  denyUsernameChangeRequest,
  demoteAdminToMember,
  getAdminFeaturePermissions,
  getMemberFeaturePermissions,
  getOwnerNotificationPreferences,
  getUserFeaturePermissions,
  listAccessRequests,
  listUsernameChangeRequests,
  promoteAdminToOwner,
  promoteMemberToAdmin,
  updateAdminFeaturePermissions,
  updateMemberFeaturePermissions,
  updateOwnerNotificationPreferences,
  updateUserFeaturePermissions
} from '../client';
