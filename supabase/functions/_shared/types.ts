// Purpose: Shared backend types used across Edge API modules.
export type AuthIdentity = {
  userId: string;
  email: string;
  name: string;
  token: string;
  orgId: string;
  actor: string;
  role: "owner" | "admin" | "member" | "";
  accessStatus: "approved" | "pending" | "denied" | "org_selection_required" | "no_access";
  permissions: Record<string, { read: boolean; write: boolean }>;
  isAdminConsoleAllowed: boolean;
  pendingCount: number;
  receivesInAppNotifications: boolean;
  defaultWarehouse: string;
  pendingRequestCreated: boolean;
};
