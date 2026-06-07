// Purpose: Centralized request-level access checks for the Edge API.
import {
  inferAccessModeForRoute,
  inferFeatureForRoute,
  isOwnerOnlyRoute as isOwnerOnlyRouteContract,
} from "../../../shared/domain/runtimeContract.mjs";
import { HttpError } from "./http.ts";
import type { AuthIdentity } from "./types.ts";

function isAdminConsoleRoute(logicalPath: string): boolean {
  return String(logicalPath || "").startsWith("/admin/");
}

export function ensureEffectiveRouteAccess(identity: AuthIdentity, method: string, logicalPath: string): void {
  if (logicalPath === "/health" || logicalPath === "/auth/context" || logicalPath === "/profile/username") {
    return;
  }

  if (identity.accessStatus !== "approved") {
    throw new HttpError(
      403,
      identity.accessStatus === "denied"
        ? "Your access request was denied. Contact an owner for help."
        : "Your account is awaiting approval from an admin or owner.",
    );
  }

  if (logicalPath === "/profile/default-warehouse") {
    return;
  }

  if (isOwnerOnlyRouteContract(logicalPath) && identity.role !== "owner") {
    throw new HttpError(403, "Owner access is required.");
  }

  if (isAdminConsoleRoute(logicalPath) && identity.role !== "owner" && identity.role !== "admin") {
    throw new HttpError(403, "Admin or owner access is required.");
  }

  if (identity.role === "owner") {
    return;
  }

  const feature = inferFeatureForRoute(logicalPath);
  if (!feature) {
    return;
  }

  const mode = inferAccessModeForRoute(method, logicalPath);
  const featurePermissions = identity.permissions?.[feature];
  const allowed = mode === "read" ? featurePermissions?.read : featurePermissions?.write;

  if (!allowed) {
    throw new HttpError(403, "Feature access denied.");
  }
}
