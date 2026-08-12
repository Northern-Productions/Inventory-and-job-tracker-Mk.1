# Read-Only Diagnostics

`diagnostics:readonly` is the preferred engine for repeatable Tier-6 database investigations that fit its conservative query model. It provides reviewed inventory identity, target guards, typed parameters, bounded in-memory evidence, mismatch continuation, and positive rollback proof.

The tool never grants DEV or PROD authorization. `AGENTS.md`, the operating manual, quiet-window requirements, and task-specific approval remain controlling.

## Commands

```powershell
npm --prefix backend run diagnostics:readonly -- --inventory <reviewed.json> --target local --connection-env LOCAL_DATABASE_URL
npm --prefix backend run diagnostics:readonly -- --inventory <reviewed.json> --target local --dry-validate --json
```

For an explicitly authorized shared target, add the matching `--allow-dev` or `--allow-prod` switch and provide `--expected-target-env <VARIABLE>`. Connection and expected-target values are read from process environment variables; the command does not load env files. Never put a connection string or private parameter in argv.

Optional bound parameters come from a JSON object in the process variable named by `--params-env`. Parameter values are never emitted.

## Inventory Contract

Version-1 inventories declare:

- a safe name and integer version;
- exactly one target category: `local`, `dev`, or `prod`;
- statement, timeout, row, and payload bounds;
- ordered statements with exact SQL;
- ordered typed parameter schemas;
- expected `scalar` or `rows` shape;
- assertions and explicit prior-statement dependencies;
- categorical output metrics only;
- `maximumExecutions: 1`;
- exact SQL, statement, and inventory SHA-256 identities.

Use `sealDiagnosticInventory` while authoring or in tracked modules. Serialized CLI inventories must retain the sealed identities. Any altered SQL, parameter schema, assertion, ordering, bounds, or target changes an identity and causes fail-closed validation.

Supported parameter types are `text`, `integer`, `bigint`, `boolean`, `uuid`, `date`, `timestamp`, and bounded arrays of those types. Values are bound through the PostgreSQL client; SQL interpolation is not supported.

## SQL Safety Model

The engine tokenizes SQL before constructing a client. It understands strings, quoted identifiers, nested comments, positional parameters, operators, and statement boundaries. It permits one semicolon-free `SELECT` or `WITH` query per inventory statement and rejects unsafe or unrecognized syntax.

The validator rejects data-modifying CTEs, DML, DDL, `SELECT INTO`, row locks, transaction control, role/session control, grants, revokes, copy, maintenance, advisory locks, dollar-quoted bodies, unsafe functions, and unknown functions. Only a small engine-owned list of PostgreSQL read-only built-ins and aggregates is accepted. Application functions and business RPCs are rejected even though the transaction would later roll back.

Inside the transaction, the engine sets `search_path` locally to `pg_catalog`, so unqualified built-ins cannot resolve through an application schema. Inventory table references should therefore be schema-qualified. PostgreSQL `READ ONLY` enforcement is defense in depth, not the parser substitute.

If a required investigation cannot be expressed in this conservative subset, stop and review an engine extension or use a narrowly reviewed external harness. Do not weaken validation inside an inventory.

## Target Model

- `local` requires a loopback hostname.
- `dev` and `prod` require an explicit matching CLI confirmation and a nonblank expected identity that equals the identity derived privately from the connection target.
- missing, cross-category, ambiguous, or mismatched targets fail before client construction.

No target identity, hostname, URL, credential, or environment value is included in normal output.

## Transaction And Rollback

The engine executes one explicit:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
```

It positively verifies `transaction_read_only=on`, establishes the `pg_catalog` search path, and executes every reviewed statement at most once. A logical assertion mismatch is retained as evidence and later independent statements continue. A statement can depend on an earlier passing statement; only that dependent branch is blocked by a mismatch.

SQL/client errors stop statement execution. Every attempted `BEGIN` is followed by an explicit `ROLLBACK`, including a failure before the server acknowledges the begin outcome. The engine then requires both the rollback command acknowledgement and a post-rollback transaction-inactive probe. Unknown rollback outcome is classified as rollback failure, never success.

## Privacy And Bounds

Raw rows stay in memory and are not returned in reports. Output contains only inventory/statement identities, categorical results, assertion outcomes, and explicitly approved counts. Database errors are reduced to categorical codes.

Core ceilings apply to statement count, per-statement timeout, total elapsed time, retained rows, and canonical payload bytes. Inventories can choose tighter limits but cannot exceed engine ceilings.

## Canonicalization And Comparisons

`readonly-diagnostic-c14n-v1` deterministically handles nulls, booleans, finite numbers, bigints, timestamps, arrays, duplicate rows, and lexically sorted object keys. Digests are lowercase `sha256:<64 hex>` values.

Reusable comparators cover:

- scalar/count/null-safe equality and expected zero;
- ordered projection and digest equality;
- set and multiset/incidence equality;
- subset and disjointness;
- duplicate-key detection;
- categorical distributions;
- composite keys declared per comparison.

`readonly-diagnostics-characterizations.mjs` contains safe synthetic local inventories for migration-ledger shape, fixture-style budgets, composite stable sets, and ordered projection digests.

## Classifications

- `READONLY_DIAGNOSTIC_PASSED`
- `READONLY_DIAGNOSTIC_LOGICAL_MISMATCH`
- `READONLY_DIAGNOSTIC_REJECTED_UNSAFE`
- `READONLY_DIAGNOSTIC_EXECUTION_FAILED`
- `READONLY_DIAGNOSTIC_ROLLBACK_FAILED`
- `READONLY_DIAGNOSTIC_TARGET_MISMATCH`

## Testing And Non-Goals

Most behavior is covered with fake clients. A tooling-only PGlite dependency exercises the complete transaction path against disposable local PostgreSQL without network access or persistent data. This tool does not mutate, repair, migrate, deploy, create fixtures, orchestrate releases, or authorize shared-environment access.
