import {
  classifyDurationBucket,
  isRouteTimingTarget,
  maybeLogRouteTiming,
} from "./route-timing.ts";

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

function buildEnv(value: string | undefined) {
  return {
    get(name: string) {
      return name === "DEV_ROUTE_TIMING_LOGS" ? value : undefined;
    },
  };
}

Deno.test("route timing logs affected routes when DEV_ROUTE_TIMING_LOGS is enabled", () => {
  const logs: string[] = [];

  const entry = maybeLogRouteTiming(
    {
      runtime: "supabase-edge",
      method: "POST",
      route: "/jobs/create",
      statusCode: 200,
      ok: true,
      durationMs: 999,
      cache: "none",
      requestId: "req-1",
    },
    {
      env: buildEnv("true"),
      logger: (message) => logs.push(message),
    },
  );

  assert(entry, "Expected route timing entry to be returned.");
  assertEquals(logs.length, 1, "Expected one structured timing log.");
  assertEquals(
    JSON.parse(logs[0]),
    {
      level: "info",
      msg: "route_timing",
      runtime: "supabase-edge",
      method: "POST",
      route: "/jobs/create",
      statusCode: 200,
      ok: true,
      durationMs: 999,
      durationBucket: "fast",
      cache: "none",
      requestId: "req-1",
    },
    "Expected sanitized route timing JSON.",
  );
});

Deno.test("route timing ignores unaffected routes", () => {
  const logs: string[] = [];

  const entry = maybeLogRouteTiming(
    {
      runtime: "supabase-edge",
      method: "GET",
      route: "/jobs/list",
      statusCode: 200,
      ok: true,
      durationMs: 1200,
      cache: "miss",
      requestId: "req-2",
    },
    {
      env: buildEnv("true"),
      logger: (message) => logs.push(message),
    },
  );

  assertEquals(entry, null, "Expected unaffected route to skip timing logs.");
  assertEquals(logs, [], "Expected no timing logs for unaffected route.");
});

Deno.test("route timing is disabled by default", () => {
  const logs: string[] = [];

  const entry = maybeLogRouteTiming(
    {
      runtime: "supabase-edge",
      method: "POST",
      route: "/boxes/update",
      statusCode: 200,
      ok: true,
      durationMs: 1200,
      cache: "none",
      requestId: "req-3",
    },
    {
      env: buildEnv(undefined),
      logger: (message) => logs.push(message),
    },
  );

  assertEquals(entry, null, "Expected default production-like env to skip timing logs.");
  assertEquals(logs, [], "Expected no timing logs when DEV_ROUTE_TIMING_LOGS is unset.");
});

Deno.test("route timing strips query and payload-like values from logs", () => {
  const logs: string[] = [];

  maybeLogRouteTiming(
    {
      runtime: "supabase-edge",
      method: "GET",
      route: "/jobs/get?jobNumber=12345&boxId=IL1-100&authToken=SECRET",
      statusCode: 404,
      ok: false,
      durationMs: 5100,
      cache: "miss",
      requestId: "req-4",
      errorCategory: "HttpError: jobNumber=12345 SECRET",
    },
    {
      env: buildEnv("true"),
      logger: (message) => logs.push(message),
    },
  );

  assertEquals(logs.length, 1, "Expected one timing log for normalized /jobs/get route.");
  const serialized = logs[0];
  const parsed = JSON.parse(serialized);
  assertEquals(parsed.route, "/jobs/get", "Expected route to omit query params.");
  assertEquals(parsed.durationBucket, "timeout-risk", "Expected timeout-risk bucket.");
  assert(!serialized.includes("12345"), "Expected job number to be omitted from timing log.");
  assert(!serialized.includes("IL1-100"), "Expected box id to be omitted from timing log.");
  assert(!serialized.includes("SECRET"), "Expected secret-like query value to be omitted from timing log.");
});

Deno.test("duration buckets match threshold rules", () => {
  assertEquals(classifyDurationBucket(999), "fast", "Expected under 1000ms to be fast.");
  assertEquals(classifyDurationBucket(1000), "slow", "Expected 1000ms to be slow.");
  assertEquals(classifyDurationBucket(5000), "slow", "Expected 5000ms to be slow.");
  assertEquals(classifyDurationBucket(5001), "timeout-risk", "Expected over 5000ms to be timeout-risk.");
});

Deno.test("route timing target list includes only requested affected endpoints", () => {
  const expectedTargets = [
    ["POST", "/jobs/create"],
    ["POST", "/jobs/update"],
    ["GET", "/jobs/get"],
    ["POST", "/jobs/checkout-all"],
    ["POST", "/jobs/set-staged-pickup"],
    ["POST", "/boxes/update"],
    ["POST", "/boxes/set-status"],
    ["POST", "/allocations/apply"],
    ["POST", "/allocations/remove-box"],
  ];

  for (const [method, route] of expectedTargets) {
    assert(isRouteTimingTarget(method, route), `Expected ${method} ${route} to be timed.`);
  }

  assert(!isRouteTimingTarget("GET", "/jobs/list"), "Expected /jobs/list to stay untimed.");
  assert(!isRouteTimingTarget("POST", "/boxes/add"), "Expected /boxes/add to stay untimed.");
});
