// Purpose: Resolve authenticated identity context for Edge API requests.
import { DEFAULT_ORG_ID, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.ts";
import { HttpError } from "./http.ts";
import type { AuthIdentity } from "./types.ts";
import {
  buildSafeAccessContext,
  resolvePilotOrgAccess,
} from "../../../shared/domain/authOrgResolution.mjs";

type PilotOrgResolutionDecision = {
  kind: string;
  orgId: string;
  reason?: string;
  candidateOrgIds?: string[];
};

type PilotOrgResolutionInput = {
  defaultOrgId?: string;
  rememberedOrgId?: string;
  memberships?: Array<{
    org_id: string;
    org_name?: string;
    role?: string;
    status?: string;
    selected?: boolean;
    created_at?: string;
  }>;
  accessRequests?: Array<{ org_id: string; status: string; requested_at?: string }>;
};

const resolvePilotOrgAccessTyped = resolvePilotOrgAccess as (
  input: PilotOrgResolutionInput,
) => PilotOrgResolutionDecision;
const buildSafeAccessContextTyped = buildSafeAccessContext as (input: {
  identity: {
    userId: string;
    email: string;
    name: string;
    token: string;
  };
  decision: PilotOrgResolutionDecision;
  actor: string;
  organizations?: Array<{
    orgId: string;
    name: string;
    role: "owner" | "admin" | "member";
    selected: boolean;
  }>;
}) => AuthIdentity;

type FetchAuthIdentityDeps = {
  asTrimmedString: (value: unknown) => string;
  deriveNameFromEmail: (email: string) => string;
};

type ResolveAuthContextDeps = FetchAuthIdentityDeps & {
  pruneAuthIdentityCache: () => void;
  authIdentityCache: Map<string, { expiresAt: number; identity: AuthIdentity }>;
  createUserScopedClient: (token: string) => any;
  listAccessRequestsForUser: (
    userId: string,
  ) => Promise<Array<{ org_id: string; status: string; requested_at?: string }>>;
  rpcOrThrow: <T>(client: any, fn: string, params?: Record<string, unknown>) => Promise<T>;
  parseFeaturePermissions: (value: unknown) => Record<string, { read: boolean; write: boolean }>;
  sendNewAccessRequestNotification: (
    params: { orgId: string; requestedEmail: string; requestedUserId: string },
  ) => Promise<void>;
};

export async function fetchAuthIdentity(
  token: string,
  deps: FetchAuthIdentityDeps,
): Promise<{ userId: string; email: string; name: string; token: string } | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null;
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });
  if (!response.ok) {
    return null;
  }
  const payload = await response.json();
  const email = deps.asTrimmedString(payload.email);
  const metadata = payload.user_metadata && typeof payload.user_metadata === "object" ? payload.user_metadata : {};
  const name =
    deps.asTrimmedString(metadata.full_name) ||
    deps.asTrimmedString(metadata.name) ||
    deps.deriveNameFromEmail(email);
  return {
    userId: deps.asTrimmedString(payload.id),
    email,
    name,
    token,
  };
}

export async function resolveAuthContext(
  request: Request,
  deps: ResolveAuthContextDeps,
  options: { forceRefresh?: boolean } = {},
): Promise<{ identity: AuthIdentity; client: any }> {
  const authorization = request.headers.get("authorization")?.trim() || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw new HttpError(401, "Authenticated session is required.");
  }
  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  deps.pruneAuthIdentityCache();
  const cached = options.forceRefresh ? null : deps.authIdentityCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      identity: cached.identity,
      client: deps.createUserScopedClient(token),
    };
  }

  const user = await fetchAuthIdentity(token, deps);
  if (!user || !user.userId || !user.email) {
    throw new HttpError(401, "Authenticated session is required.");
  }

  const client = deps.createUserScopedClient(token);

  const memberships = await deps.rpcOrThrow<Array<{
    org_id: string;
    org_name?: string;
    role?: string;
    status?: string;
    selected?: boolean;
    created_at?: string;
  }>>(
    client,
    "api_list_memberships",
  );
  const accessRequests = await deps.listAccessRequestsForUser(user.userId);
  const organizations = memberships.map((entry) => {
    const role = deps.asTrimmedString(entry.role).toLowerCase();
    return {
      orgId: deps.asTrimmedString(entry.org_id),
      name: deps.asTrimmedString(entry.org_name) || "Organization",
      role: role === "owner" || role === "admin" ? role : "member",
      selected: entry.selected === true,
    } as {
      orgId: string;
      name: string;
      role: "owner" | "admin" | "member";
      selected: boolean;
    };
  });
  const rememberedOrgId = deps.asTrimmedString(memberships.find((entry) => entry.selected === true)?.org_id);
  const decision = resolvePilotOrgAccessTyped({
    defaultOrgId: DEFAULT_ORG_ID,
    rememberedOrgId,
    memberships,
    accessRequests,
  });
  const actor = `${user.name} <${user.email}>`;

  if (decision.kind !== "approved") {
    const identity = buildSafeAccessContextTyped({
      identity: user,
      decision,
      actor,
      organizations,
    });
    deps.authIdentityCache.set(token, {
      identity,
      expiresAt: Date.now() + 60_000,
    });
    return { identity, client };
  }

  const orgId = decision.orgId;
  const selectedOrganizations = organizations.map((entry) => ({
    ...entry,
    selected: entry.orgId === orgId,
  }));
  const accessContext = await deps.rpcOrThrow<Record<string, unknown>>(client, "api_get_auth_context", {
    p_org_id: orgId,
  });

  const accessStatusRaw = deps.asTrimmedString(accessContext.accessStatus || "pending").toLowerCase();
  const roleRaw = deps.asTrimmedString(accessContext.role).toLowerCase();
  const permissions = deps.parseFeaturePermissions(accessContext.permissions);
  if (roleRaw === "owner") {
    permissions.team_management = { read: true, write: true };
  } else if (!permissions.team_management) {
    permissions.team_management = { read: false, write: false };
  }
  const identity: AuthIdentity = {
    ...user,
    orgId,
    actor,
    accessStatus:
      accessStatusRaw === "approved" || accessStatusRaw === "denied"
        ? (accessStatusRaw as "approved" | "denied")
        : "pending",
    role:
      roleRaw === "owner" || roleRaw === "admin" || roleRaw === "member"
        ? (roleRaw as "owner" | "admin" | "member")
        : "",
    permissions,
    isAdminConsoleAllowed:
      accessContext.isAdminConsoleAllowed === true ||
      String(accessContext.isAdminConsoleAllowed).toLowerCase() === "true",
    pendingCount: Number(accessContext.pendingCount || 0) || 0,
    receivesInAppNotifications:
      accessContext.receivesInAppNotifications === true ||
      String(accessContext.receivesInAppNotifications).toLowerCase() === "true",
    defaultWarehouse: deps.asTrimmedString(accessContext.defaultWarehouse).toUpperCase(),
    pendingRequestCreated:
      accessContext.pendingRequestCreated === true ||
      String(accessContext.pendingRequestCreated).toLowerCase() === "true",
    organizations: selectedOrganizations,
  };

  if (identity.accessStatus === "pending" && identity.pendingRequestCreated) {
    try {
      await deps.sendNewAccessRequestNotification({
        orgId,
        requestedEmail: user.email,
        requestedUserId: user.userId,
      });
    } catch {
      // Non-fatal: pending state is still persisted in DB.
    }
  }

  deps.authIdentityCache.set(token, {
    identity,
    expiresAt: Date.now() + 60_000,
  });

  return { identity, client };
}
