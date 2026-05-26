// Purpose: Resolve authenticated identity context for Edge API requests.
import { DEFAULT_ORG_ID, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.ts";
import { HttpError } from "./http.ts";
import type { AuthIdentity } from "./types.ts";

type FetchAuthIdentityDeps = {
  asTrimmedString: (value: unknown) => string;
  deriveNameFromEmail: (email: string) => string;
};

type ResolveAuthContextDeps = FetchAuthIdentityDeps & {
  pruneAuthIdentityCache: () => void;
  authIdentityCache: Map<string, { expiresAt: number; identity: AuthIdentity }>;
  createUserScopedClient: (token: string) => any;
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
): Promise<{ identity: AuthIdentity; client: any }> {
  const authorization = request.headers.get("authorization")?.trim() || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw new HttpError(401, "Authenticated session is required.");
  }
  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  deps.pruneAuthIdentityCache();
  const cached = deps.authIdentityCache.get(token);
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

  let orgId = DEFAULT_ORG_ID;
  if (!orgId) {
    const memberships = await deps.rpcOrThrow<Array<{ org_id: string }>>(client, "api_list_memberships");
    if (!memberships.length) {
      throw new HttpError(
        500,
        "DEFAULT_ORG_ID must be configured before handling pending approvals.",
      );
    }

    if (memberships.length === 1) {
      orgId = memberships[0].org_id;
    } else {
      throw new HttpError(
        500,
        "DEFAULT_ORG_ID is required because this user belongs to multiple organizations.",
      );
    }
  }

  const accessContext = await deps.rpcOrThrow<Record<string, unknown>>(client, "api_get_auth_context", {
    p_org_id: orgId,
  });

  const accessStatusRaw = deps.asTrimmedString(accessContext.accessStatus || "pending").toLowerCase();
  const roleRaw = deps.asTrimmedString(accessContext.role).toLowerCase();
  const identity: AuthIdentity = {
    ...user,
    orgId,
    actor: `${user.name} <${user.email}>`,
    accessStatus:
      accessStatusRaw === "approved" || accessStatusRaw === "denied"
        ? (accessStatusRaw as "approved" | "denied")
        : "pending",
    role:
      roleRaw === "owner" || roleRaw === "admin" || roleRaw === "member"
        ? (roleRaw as "owner" | "admin" | "member")
        : "",
    permissions: deps.parseFeaturePermissions(accessContext.permissions),
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
