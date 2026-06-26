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
