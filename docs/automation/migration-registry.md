# Migration Registry

The migration registry centralizes repository-wide migration metadata without replacing migration SQL as the source of truth. It derives its result from the staged Git index entries under `backend/migrations/` and `supabase/migrations/`.

## Commands

```powershell
npm --prefix backend run migrations:registry
npm --prefix backend run migrations:registry -- --check
npm --prefix backend run migrations:registry -- --json
```

`--check` exits nonzero when the required modern mirror chain is incoherent. Historical exceptions remain visible as categorical warnings. There is no checked-in generated registry artifact to regenerate.

## Exact-Byte Contract

The registry reads each migration's Git index blob with `git ls-files --stage` and `git cat-file --batch`. Hashes are lowercase SHA-256 identities over those exact bytes. This makes the result independent of checkout line-ending conversion on Windows and equivalent to committed bytes in CI.

An unstaged or untracked migration is rejected because its worktree bytes are not yet an authoritative candidate. Stage new migration files before running the registry. A newly staged migration participates before it is committed.

## Mapping Model

Backend files provide the four-digit logical identifier and mapping name. Supabase files provide the timestamp/version and the same mapping name. The registry reports:

- logical identifier and numeric order;
- backend and Supabase repository-relative paths;
- Supabase timestamp/version;
- exact mirror status and byte identity;
- missing, duplicate, malformed, and out-of-order mappings;
- one unambiguous latest migration.

The repository's early migration history contains documented structural exceptions. The exact-mirror contract is strict from logical migration `0085` and Supabase version `20260425113000` forward. Earlier duplicate logical identifiers, missing mirrors, and five known byte differences are warnings, not silently normalized data.

## Programmatic API

Tests and tooling import `backend/scripts/lib/migration-registry.mjs` and use:

- `buildMigrationRegistry()` for complete coherence evidence;
- `getLatestMigration(registry)` for the unambiguous tip;
- `findMigration(registry, logicalId, { name })` for exact historical lookup;
- `migrationExistsExactlyOnce(...)` for categorical existence checks;
- `serializeMigrationRegistry(...)` for deterministic JSON.

Migration-specific tests should assert their migration's own SQL and mirror contract. They must not duplicate the unrelated global latest number. The production schema guard intentionally retains one release-tip pin; the registry suite centrally proves that pin equals the derived latest migration.

## Adding A Migration

1. Add both repository-standard mirror files.
2. Add focused tests for the migration's behavior.
3. Stage both migration files so the Git index holds the candidate bytes.
4. Run `npm --prefix backend run migrations:registry -- --check`.
5. Run the task-tier migration and schema checks.

A normal migration should not require edits to unrelated historical migration tests.

## CI And Safety

The registry performs local Git reads only. It does not load environment files, connect to a database, apply migrations, repair history, or access DEV/PROD. `codex:refresh` runs the lightweight coherence check and reports the latest logical/timestamp pair after `repo:doctor` succeeds.
