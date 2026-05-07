import test from "node:test";
import assert from "node:assert/strict";
import {
  isRouteTimingEnabled,
  isRouteTimingTarget,
  maybeLogRouteTiming,
} from "../../src/app/routeTiming.mjs";

const EXPECTED_TIMING_TARGETS = [
  ["POST", "/film-orders/delete"],
  ["POST", "/film-orders/cancel"],
  ["GET", "/film-orders/list"],
  ["POST", "/jobs/create"],
  ["POST", "/jobs/update"],
  ["GET", "/jobs/get"],
  ["POST", "/jobs/complete"],
  ["POST", "/jobs/delete"],
  ["POST", "/jobs/checkout-all"],
  ["POST", "/jobs/set-staged-pickup"],
  ["POST", "/audit/undo"],
  ["POST", "/boxes/receive"],
  ["POST", "/boxes/add"],
  ["POST", "/boxes/delete"],
  ["POST", "/boxes/update"],
  ["POST", "/boxes/set-status"],
  ["POST", "/allocations/apply"],
  ["POST", "/allocations/remove-box"],
  ["GET", "/reports/summary"],
];

test("local route timing target list matches high-risk Supabase coverage", () => {
  for (const [method, route] of EXPECTED_TIMING_TARGETS) {
    assert.equal(isRouteTimingTarget(method, route), true, `${method} ${route}`);
  }

  assert.equal(isRouteTimingTarget("GET", "/jobs/list"), false);
  assert.equal(isRouteTimingTarget("GET", "/boxes/list"), false);
});

test("local route timing DEV gate behavior is unchanged", () => {
  assert.equal(isRouteTimingEnabled({}), false);
  assert.equal(isRouteTimingEnabled({ DEV_ROUTE_TIMING_LOGS: "true" }), true);
  assert.equal(isRouteTimingEnabled({ NODE_ENV: "development" }), true);
});

test("local film order delete timing records high-risk total route duration only", () => {
  const logs = [];

  maybeLogRouteTiming(
    {
      runtime: "node-local",
      method: "POST",
      route: "/film-orders/delete?filmOrderId=FO-SECRET&authToken=SECRET&jobNumber=12345",
      statusCode: 504,
      ok: false,
      durationMs: 20001,
      cache: "none",
      requestId: "req-film-delete",
      errorCategory: "PostWritePlannerTimeout: filmOrderId=FO-SECRET bodyToken=BODY-SECRET",
    },
    {
      env: { DEV_ROUTE_TIMING_LOGS: "true" },
      logger: (message) => logs.push(message),
    },
  );

  assert.equal(logs.length, 1);
  const serialized = logs[0];
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.route, "/film-orders/delete");
  assert.equal(parsed.durationBucket, "timeout-risk");
  assert.equal(serialized.includes("FO-SECRET"), false);
  assert.equal(serialized.includes("12345"), false);
  assert.equal(serialized.includes("SECRET"), false);
  assert.equal(serialized.includes("BODY-SECRET"), false);
});
