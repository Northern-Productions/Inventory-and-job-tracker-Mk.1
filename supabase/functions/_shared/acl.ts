// Purpose: Centralized request-level access checks for the Edge API.
import { isOwnerOnlyRoute as isOwnerOnlyRouteContract } from "../../../shared/domain/runtimeContract.mjs";
import { HttpError } from "./http.ts";
import type { AuthIdentity } from "./types.ts";

export function ensureEffectiveRouteAccess(identity: AuthIdentity, logicalPath: string): void {
  if (identity.accessStatus !== "approved" && logicalPath !== "/profile/username") {
    throw new HttpError(
      403,
      identity.accessStatus === "denied"
        ? "Your access request was denied. Contact an owner for help."
        : "Your account is awaiting approval from an admin or owner.",
    );
  }

  if (isOwnerOnlyRouteContract(logicalPath) && identity.role !== "owner") {
    throw new HttpError(403, "Owner access is required.");
  }
}
