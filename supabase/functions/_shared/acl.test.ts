import { ensureEffectiveRouteAccess } from "./acl.ts";
import { HttpError } from "./http.ts";
import type { AuthIdentity } from "./types.ts";

const FEATURES = [
  "inventory",
  "allocations",
  "jobs",
  "film_orders",
  "activity_history",
  "reports",
  "access_management",
];

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

function permissions(overrides: Record<string, { read?: boolean; write?: boolean }> = {}) {
  const mapped: Record<string, { read: boolean; write: boolean }> = {};
  for (const feature of FEATURES) {
    const override = overrides[feature] || {};
    mapped[feature] = {
      read: override.read === true,
      write: override.write === true,
    };
  }
  return mapped;
}

function identity(overrides: Partial<AuthIdentity> = {}): AuthIdentity {
  return {
    userId: "user-1",
    email: "user@example.com",
    name: "Test User",
    token: "token",
    orgId: "org-1",
    actor: "Test User <user@example.com>",
    role: "member",
    accessStatus: "approved",
    permissions: permissions(),
    isAdminConsoleAllowed: false,
    pendingCount: 0,
    receivesInAppNotifications: false,
    defaultWarehouse: "",
    pendingRequestCreated: false,
    ...overrides,
  };
}

function assertAllows(method: string, logicalPath: string, authIdentity: AuthIdentity, message: string) {
  try {
    ensureEffectiveRouteAccess(authIdentity, method, logicalPath);
  } catch (error) {
    throw new Error(
      `${message}\nExpected access to be allowed, received ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
}

function assertDenied(
  method: string,
  logicalPath: string,
  authIdentity: AuthIdentity,
  expectedStatus: number,
  expectedMessage: string,
  message: string,
) {
  try {
    ensureEffectiveRouteAccess(authIdentity, method, logicalPath);
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw new Error(`${message}\nExpected HttpError, received ${error instanceof Error ? error.message : error}.`);
    }
    assertEquals(error.statusCode, expectedStatus, `${message}\nUnexpected status code.`);
    if (!error.message.includes(expectedMessage)) {
      throw new Error(`${message}\nExpected message containing: ${expectedMessage}\nActual: ${error.message}`);
    }
    return;
  }

  throw new Error(`${message}\nExpected access to be denied.`);
}

Deno.test("Edge ACL denies disabled feature read routes", () => {
  assertDenied(
    "GET",
    "/boxes/search",
    identity({ permissions: permissions({ inventory: { read: false, write: true } }) }),
    403,
    "Feature access denied.",
    "Inventory read routes must require inventory read permission.",
  );
});

Deno.test("Warehouse asset audit costs require reports.read permission", () => {
  assertDenied(
    "GET",
    "/reports/warehouse-asset-audit",
    identity({ permissions: permissions({ inventory: { read: true }, reports: { read: false } }) }),
    403,
    "Feature access denied.",
    "Box-level financial data must not be exposed through inventory read permission.",
  );
  assertAllows(
    "GET",
    "/reports/warehouse-asset-audit",
    identity({ permissions: permissions({ reports: { read: true } }) }),
    "reports.read should authorize the warehouse asset audit.",
  );
});

Deno.test("Edge ACL denies safe next BoxID suggestion without inventory read access", () => {
  assertDenied(
    "GET",
    "/boxes/suggest-next-id",
    identity({ permissions: permissions({ inventory: { read: false, write: true } }) }),
    403,
    "Feature access denied.",
    "Safe next BoxID suggestion must require inventory read permission.",
  );
});

Deno.test("Edge ACL denies disabled feature write routes", () => {
  assertDenied(
    "POST",
    "/boxes/add",
    identity({ permissions: permissions({ inventory: { read: true, write: false } }) }),
    403,
    "Feature access denied.",
    "Inventory write routes must require inventory write permission.",
  );
});

Deno.test("Edge ACL denies member read-only write attempts", () => {
  assertDenied(
    "POST",
    "/jobs/update",
    identity({ role: "member", permissions: permissions({ jobs: { read: true, write: false } }) }),
    403,
    "Feature access denied.",
    "Read-only members must not reach job write routes.",
  );
});

Deno.test("Edge ACL denies non-admin access to admin routes", () => {
  assertDenied(
    "GET",
    "/admin/access/requests",
    identity({
      role: "member",
      permissions: permissions({ access_management: { read: true, write: true } }),
    }),
    403,
    "Admin or owner access is required.",
    "Admin routes must require admin or owner role before feature permission checks.",
  );
});

Deno.test("Edge ACL denies admins missing required access management permission", () => {
  const cases = [
    { method: "GET", path: "/admin/access/requests", accessManagement: { read: false, write: true } },
    { method: "POST", path: "/admin/access/requests/approve", accessManagement: { read: true, write: false } },
  ];

  for (const testCase of cases) {
    assertDenied(
      testCase.method,
      testCase.path,
      identity({
        role: "admin",
        permissions: permissions({ access_management: testCase.accessManagement }),
      }),
      403,
      "Feature access denied.",
      `${testCase.method} ${testCase.path} must require matching access_management permission.`,
    );
  }
});

Deno.test("Edge ACL denies non-owner access to owner-only routes", () => {
  for (const role of ["member", "admin"] as const) {
    for (const route of [
      { method: "GET", path: "/owner/reports/asset-total-cost", feature: "reports" },
      { method: "GET", path: "/owner/team/users", feature: "access_management" },
      { method: "POST", path: "/owner/team/invite", feature: "access_management" },
      { method: "POST", path: "/owner/team/change-role", feature: "access_management" },
      { method: "POST", path: "/owner/team/disable", feature: "access_management" },
      { method: "POST", path: "/owner/team/reenable", feature: "access_management" },
    ] as const) {
      assertDenied(
        route.method,
        route.path,
        identity({
          role,
          permissions: permissions({ [route.feature]: { read: true, write: true } }),
        }),
        403,
        "Owner access is required.",
        `${role} users must not reach owner-only route ${route.path}.`,
      );
    }
  }
});

Deno.test("Edge ACL denies pending and denied users on protected routes", () => {
  assertDenied(
    "GET",
    "/boxes/search",
    identity({ accessStatus: "pending" }),
    403,
    "Your account is awaiting approval from an admin or owner.",
    "Pending users must not reach protected routes.",
  );
  assertDenied(
    "GET",
    "/boxes/search",
    identity({ accessStatus: "denied" }),
    403,
    "Your access request was denied. Contact an owner for help.",
    "Denied users must not reach protected routes.",
  );
});

Deno.test("Edge ACL preserves approval-gate exceptions for authenticated routes", () => {
  const pendingIdentity = identity({ accessStatus: "pending" });
  assertAllows("GET", "/health", pendingIdentity, "/health should remain an ACL approval-gate exception.");
  assertAllows("GET", "/auth/context", pendingIdentity, "/auth/context should bypass approval after authentication.");
  assertAllows(
    "POST",
    "/profile/username",
    pendingIdentity,
    "/profile/username should remain the authenticated pending-user exception.",
  );
});

Deno.test("Edge ACL keeps default warehouse approved-user-only but not feature-gated", () => {
  assertDenied(
    "POST",
    "/profile/default-warehouse",
    identity({ accessStatus: "pending" }),
    403,
    "Your account is awaiting approval from an admin or owner.",
    "Pending users must not update default warehouse.",
  );
  assertAllows(
    "POST",
    "/profile/default-warehouse",
    identity({ permissions: permissions() }),
    "Approved users should update default warehouse without feature permissions.",
  );
});

Deno.test("Edge ACL allows approved users with matching feature permissions", () => {
  assertAllows(
    "GET",
    "/boxes/search",
    identity({ permissions: permissions({ inventory: { read: true, write: false } }) }),
    "Inventory readers should reach inventory read routes.",
  );
  assertAllows(
    "POST",
    "/boxes/add",
    identity({ permissions: permissions({ inventory: { read: true, write: true } }) }),
    "Inventory writers should reach inventory write routes.",
  );
});

Deno.test("Edge ACL allows owners through owner-only and feature-mapped routes", () => {
  const owner = identity({ role: "owner", permissions: permissions() });
  assertAllows("GET", "/owner/reports/asset-total-cost", owner, "Owners should reach owner-only routes.");
  assertAllows("POST", "/boxes/add", owner, "Owners should bypass feature permission checks.");
});
