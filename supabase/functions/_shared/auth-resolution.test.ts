import {
  buildSafeAccessContext,
  resolvePilotOrgAccess,
} from "../../../shared/domain/authOrgResolution.mjs";
import { ensureEffectiveRouteAccess } from "./acl.ts";
import { HttpError } from "./http.ts";
import type { AuthIdentity } from "./types.ts";

const DEFAULT_ORG = "11111111-1111-4111-8111-111111111111";
const CLIENT_ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";

type ResolverDecision = {
  kind: string;
  orgId: string;
  reason?: string;
  candidateOrgIds?: string[];
};

type ResolverInput = {
  defaultOrgId?: string;
  memberships?: Array<{ org_id: string; role?: string; created_at?: string }>;
  accessRequests?: Array<{ org_id: string; status: string; requested_at?: string }>;
};

const resolveForTest = resolvePilotOrgAccess as (input: ResolverInput) => ResolverDecision;
const buildSafeContextForTest = buildSafeAccessContext as (input: {
  identity: {
    userId: string;
    email: string;
    name: string;
    token: string;
  };
  actor: string;
  decision: ResolverDecision;
}) => AuthIdentity;

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("auth org resolver keeps default org only for default-org members", () => {
  const decision = resolveForTest({
    defaultOrgId: DEFAULT_ORG,
    memberships: [
      { org_id: CLIENT_ORG, role: "member" },
      { org_id: DEFAULT_ORG, role: "owner" },
    ],
  });

  assertEquals(
    { kind: decision.kind, orgId: decision.orgId },
    { kind: "approved", orgId: DEFAULT_ORG },
    "Expected default org to win only because the user is a default-org member.",
  );
});

Deno.test("auth org resolver resolves one non-default approved org instead of failing default-org membership", () => {
  const decision = resolveForTest({
    defaultOrgId: DEFAULT_ORG,
    memberships: [{ org_id: CLIENT_ORG, role: "member" }],
  });

  assertEquals(
    { kind: decision.kind, orgId: decision.orgId, reason: decision.reason },
    { kind: "approved", orgId: CLIENT_ORG, reason: "single-approved-membership" },
    "Expected a single non-default membership to resolve to its own org.",
  );
});

Deno.test("auth org resolver fails closed for multiple approved orgs", () => {
  const decision = resolveForTest({
    defaultOrgId: DEFAULT_ORG,
    memberships: [
      { org_id: CLIENT_ORG, role: "member" },
      { org_id: OTHER_ORG, role: "member" },
    ],
  });

  assertEquals(
    { kind: decision.kind, orgId: decision.orgId, candidateOrgIds: decision.candidateOrgIds },
    { kind: "org_selection_required", orgId: "", candidateOrgIds: [CLIENT_ORG, OTHER_ORG] },
    "Expected multiple non-default orgs to require explicit selection.",
  );
});

Deno.test("auth org resolver preserves a known pending request without creating default-org access", () => {
  const decision = resolveForTest({
    defaultOrgId: DEFAULT_ORG,
    accessRequests: [{ org_id: CLIENT_ORG, status: "pending" }],
  });

  assertEquals(
    { kind: decision.kind, orgId: decision.orgId },
    { kind: "pending", orgId: CLIENT_ORG },
    "Expected known pending access to stay scoped to its own org.",
  );
});

Deno.test("Edge ACL blocks org-selection-required users before tenant routes dispatch", () => {
  const identity = buildSafeContextForTest({
    identity: {
      userId: "user-1",
      email: "user@example.com",
      name: "User Example",
      token: "token",
    },
    actor: "User Example <user@example.com>",
    decision: {
      kind: "org_selection_required",
      orgId: "",
      reason: "multiple-approved-memberships",
    },
  });

  try {
    ensureEffectiveRouteAccess(identity, "GET", "/boxes/get");
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw new Error("Expected HttpError for unresolved org access.");
    }
    assertEquals(error.statusCode, 403, "Expected unresolved org access to be forbidden.");
    assert(
      error.message.includes("Choose an organization"),
      "Expected a business-level organization selection message.",
    );
    return;
  }

  throw new Error("Expected org-selection-required access to be blocked.");
});

Deno.test("Edge auth module reads access requests before resolving the auth context", async () => {
  const source = await Deno.readTextFile(new URL("./auth.ts", import.meta.url));

  assert(source.includes("listAccessRequestsForUser"), "Expected Edge auth deps to include access-request reads.");
  assert(source.includes("resolvePilotOrgAccess"), "Expected Edge auth to use the shared resolver.");
  assert(
    source.indexOf("listAccessRequestsForUser") < source.indexOf("api_get_auth_context"),
    "Expected Edge auth to inspect access requests before calling api_get_auth_context.",
  );
});
