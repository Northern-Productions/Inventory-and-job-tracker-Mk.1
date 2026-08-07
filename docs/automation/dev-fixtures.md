# DEV Fixture Workflow Scripts

This repo has guarded DEV-only fixture scripts for repeatable browser workflow
checks. Fixtures are durable until cleanup, tagged, and safe to identify from a
browser route.

## Safety Rules

- DEV only: `uxiltcpbhthhinonttrc`.
- Never run these scripts against PROD.
- Never paste DB URLs, auth tokens, service keys, or env file contents into
  chat or reports.
- Cleanup only by exact fixture tag and known generated IDs.
- Fixture manifests are local-only and ignored under `.secrets/dev-fixtures/`.

## Create A Fixture

PowerShell examples:

```powershell
npm --prefix backend run fixtures:dev:create -- --scenario checked-out-box-job
npm --prefix backend run fixtures:dev:create -- --scenario allocation-eligibility
```

Each create command prints:

- fixture tag
- safe generated IDs
- Job Details route
- Box Details routes
- QR payloads useful for scanner tests

## Verify A Fixture

```powershell
npm --prefix backend run fixtures:dev:verify -- --tag CODEX_DEV_FIXTURE_SCENARIO_12345678901
```

Verification reads the ignored manifest when present and also queries DEV by
the exact fixture tag.

After cleanup, verify the fixture is gone:

```powershell
npm --prefix backend run fixtures:dev:verify -- --tag CODEX_DEV_FIXTURE_SCENARIO_12345678901 --expect-clean
```

## Cleanup A Fixture

```powershell
npm --prefix backend run fixtures:dev:cleanup -- --tag CODEX_DEV_FIXTURE_SCENARIO_12345678901
```

Cleanup is idempotent and only deletes rows owned by the exact fixture tag or
manifest IDs. It writes cleanup results back to the ignored manifest.

## Scenarios

### `checked-out-box-job`

Creates:

- one tagged job
- one primary phase
- one film requirement
- one film box
- one allocation
- a checked-out box tied to the job

Use it for QR scan routing, Box Details checked-out state, Job Details
check-in setup, and related browser checks.

### `allocation-eligibility`

Creates:

- one target job with a film requirement needing LF
- one checked-out box with remaining allocatable LF
- one zeroed box for the same fixture film/width
- one checkout job used to put the checked-out box into the right state

Use it for allocation modal eligibility checks, checked-out box planning
eligibility, and ZEROED exclusion verification.

## Browser Use

Create the fixture, then use the printed routes with the Phase 1 browser auth
harness:

```powershell
npm --prefix backend run browser-auth:dev
npm --prefix frontend run test:e2e:dev
```

For manual local review, open the printed `/#/allocations/jobs/<jobId>` or
`/#/inventory/<boxId>` route in the local frontend.

Always run cleanup after the visual/workflow check.

## Pending-Transfer Checkout Denial Fixture

`pending-transfer-checkout-denial` is a manifest-v3 scenario for the guarded
caulk/film checkout verification. It is separate from the manifest-v2
scenarios above. The tooling performs privileged, non-HTTP setup only; it does
not call checkout, staged-pickup, or allocation routes. Those runtime actions
must be made later through the deployed API under the ordinary smoke identity.

Every v3 command requires an explicit nonblank `--env` argument. Help is the
only exception. Create also requires the certified DEV Edge metadata captured
by the pre-mutation checkpoint:

```powershell
npm --prefix backend run fixtures:dev:create -- --scenario pending-transfer-checkout-denial --env .env.dev --tag <exact-run-namespace> --edge-version 140 --edge-status ACTIVE --edge-verify-jwt false --edge-body-digest sha256:<certified-digest>
```

The caller must generate and privately retain one collision-protected namespace
before setup. It always starts with
`CODEX_DEV_FIXTURE_PENDING_TRANSFER_CHECKOUT_DENIAL_`. Normal output contains
only categories, counts, lifecycle states, and privacy-safe digests. Exact
fixture identifiers remain only in the ignored, owner-protected private
manifest.

### Runtime Stage Capture

After the pure caulk denial has passed, the ordinary application route creates
the one approved film allocation. The guarded harness then records it with:

```powershell
npm --prefix backend run fixtures:dev:create -- --scenario pending-transfer-checkout-denial --env .env.dev --tag <exact-run-namespace> --record-runtime-stage allocation-applied --allocation-id-stdin --edge-version 140 --edge-status ACTIVE --edge-verify-jwt false --edge-body-digest sha256:<certified-digest>
```

The harness must pipe the already-captured allocation identifier directly from
private process memory. Never place it in an argument, command literal,
environment variable, separate input file, log, trace, or report. After exact
database validation, the tooling may append it only to the protected private
manifest. The stdin reader refuses a TTY, times out after five seconds, reads
at most 64 raw bytes, uses fatal UTF-8, and accepts only the canonical
allocation-ID shape with optional terminal LF or CRLF.

After mixed checkout succeeds, record the fixture-owned audit row:

```powershell
npm --prefix backend run fixtures:dev:create -- --scenario pending-transfer-checkout-denial --env .env.dev --tag <exact-run-namespace> --record-runtime-stage mixed-checkout-complete --edge-version 140 --edge-status ACTIVE --edge-verify-jwt false --edge-body-digest sha256:<certified-digest>
```

The allocation transition validates exactly one 40-LF, `REQUIREMENT`,
`MANUAL`, `ACTIVE` allocation for the captured tenant, job, phase,
requirement, and same-warehouse box, with no box transfer, alias, or roll
history. The checkout transition accepts exactly one matching fixture-owned
`SET_STATUS` audit row and only after the complete final budget passes.

### Exact Budgets

Initial state contains one manufacturer, product, caulk requirement,
allocation, pending transfer, dealer, film catalog row, film box, job, phase,
and film requirement; two caulk stock rows; zero film allocations; two
`RECEIVE`, one `JOB_ALLOCATE`, one `TRANSFER_OUT`, and one `ADD_BOX` row. The
film box is `IN_STOCK`, 60 inches wide, 80 LF, in the job warehouse, with no
reservation or pending transfer.

Final recorded state contains one film allocation, one `ADD_BOX`, and one
`SET_STATUS`. Caulk checkouts, planner suppressions, roll history, aliases, box
transfers, film orders, film-order links, and film-order events must remain
exactly zero at every stage.

### Manifest And Baseline Safety

Manifest v3 has independent monotonic setup, runtime, and cleanup states. Only
these ordinary cleanup sources are allowed:

- `ready / initial / not_started`
- `ready / allocation_applied / not_started`
- `ready / mixed_checkout_complete / not_started`

Prepared, recovery, attempted, failed, succeeded, unknown, repeated, skipped,
or regressed states require reviewed recovery. A stale lifecycle lock,
publication temporary, cleanup marker, recovery marker, ambiguity marker, or
unusable manifest freezes the namespace and is never reset automatically.

The immutable baseline records the canonicalization and serialization policy,
SHA-256 algorithm, fixed ordered projection scope, safe counts, and lowercase
digests for affected nonfixture tables, expected-zero tables, schema,
migrations, warehouse and owner-company references, DEV target and Edge
identity, and the atomic-transfer quarantine set. Runtime and cleanup compare
this evidence but cannot replace it.

Initial publication uses a same-directory protected temporary, file fsync,
exact-byte SHA-256, and an exclusive same-filesystem hard link. The final
target is reverified before and after temporary-link removal. POSIX protection
is mode `0600`; Windows protection is an exact-file owner-only protected DACL.
Directory fsync is reported as `succeeded`, `failed`, or `unsupported`; Windows
does not claim parent-directory durability when the operation is unsupported.
A `failed` result on a platform that supports directory fsync freezes the
namespace for reviewed recovery rather than permitting ordinary continuation.

### One-Shot Cleanup

Cleanup requires the exact tenant, namespace, private manifest, and captured
IDs. Namespace discovery may verify completeness but cannot add a target. A
protected cleanup-attempt marker is durably created before database work and
permanently blocks a second ordinary invocation, including after a crash or
rollback. Cleanup uses one serializable transaction, the stage-specific exact
budget, and no wildcard, prefix, date-range, warehouse-wide, organization-wide,
or discovery-added target.

Run cleanup with the explicit scenario and environment so the v3 guard is
active before environment loading:

```powershell
npm --prefix backend run fixtures:dev:cleanup -- --scenario pending-transfer-checkout-denial --env .env.dev --tag <exact-run-namespace> --edge-version 140 --edge-status ACTIVE --edge-verify-jwt false --edge-body-digest sha256:<certified-digest>
```

Success is recorded only after fixture emptiness, exact expected-zero state,
strict nonfixture restoration, schema/migration equality, DEV target and Edge
identity, reference equality, dealer restoration, and quarantine equality all
pass. Commit ambiguity or any post-commit proof failure becomes
`recovery_required`. Ordinary cleanup cannot retry or broaden scope.

Manifest-v2 paths, normalization, serialized bytes, discovery-assisted cleanup,
cleanup order, categorical output, and idempotent behavior remain unchanged.
