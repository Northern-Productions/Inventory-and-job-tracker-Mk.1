# Release Integrity Gate

`release:integrity` creates and compares read-only database snapshots around an approved release. It is a release safety signal, not a deploy command, migration runner, backup, or corruption detector.

## Protected Scope

Each snapshot covers:

- every base or partitioned table in the `app` schema, including future tables discovered at runtime
- the `auth.users` table
- applied versions in `supabase_migrations.schema_migrations`
- column metadata for every protected table

For each protected table, PostgreSQL hashes each complete row inside the database. Only sorted row hashes are streamed to the script and reduced to one SHA-256 fingerprint. Snapshot files contain table names, row counts, aggregate fingerprints, schema fingerprints, migration versions, the verified project ref, and non-secret Git metadata. They do not contain rows, column values, emails, tokens, passwords, database URLs, or env values.

The command starts a `REPEATABLE READ, READ ONLY` transaction, verifies `transaction_read_only=on`, and rolls the transaction back after capture. It contains no database mutation mode.

## Create Snapshots

Guard the release target and create a pre-release snapshot before any approved release action:

```powershell
npm --prefix backend run release:integrity -- --mode snapshot --target prod --env ../.secrets/prod.env --allow-prod --phase pre --out .codex-runlogs/release-integrity/prod-pre.json
```

After the approved release and before declaring it complete, create the post-release snapshot:

```powershell
npm --prefix backend run release:integrity -- --mode snapshot --target prod --env ../.secrets/prod.env --allow-prod --phase post --out .codex-runlogs/release-integrity/prod-post.json
```

Use `--target dev --env .env.dev` without `--allow-prod` for DEV. If `.secrets/prod.env` is unavailable, `--env .env.prod` is the existing backend fallback, but use it only after its PROD ref passes the target guard. If the approved credential uses a nonstandard variable, pass its name with `--database-url-var`; never pass a database URL on the command line. The URL itself must prove the exact expected Supabase project ref before the script connects.

Artifacts must remain under the ignored `.codex-runlogs/release-integrity/` directory. Existing snapshots are never overwritten.

## Strict Mode

Strict is the default and recommended policy for high-risk migrations. Use it for a controlled release window where no business or authentication activity is expected:

```powershell
npm --prefix backend run release:integrity -- --mode compare --before .codex-runlogs/release-integrity/prod-pre.json --after .codex-runlogs/release-integrity/prod-post.json --policy strict
```

Strict mode fails on:

- any protected-table row-count or fingerprint change
- any protected-table schema change
- any applied migration version added or removed
- any target or protected-scope mismatch

Intentional changes require exact, reviewable approvals. Repeat options or use comma-separated values:

```powershell
npm --prefix backend run release:integrity -- --mode compare --before .codex-runlogs/release-integrity/prod-pre.json --after .codex-runlogs/release-integrity/prod-post.json --policy strict --allow-table-change app.jobs --allow-schema-change app.jobs --allow-migration 20260712090000
```

There is no broad "allow all" switch. A target mismatch is never approvable.

## Observe Mode

Use observe mode when legitimate live activity may continue:

```powershell
npm --prefix backend run release:integrity -- --mode compare --before .codex-runlogs/release-integrity/prod-pre.json --after .codex-runlogs/release-integrity/prod-post.json --policy observe
```

Observe mode reports every protected-data, schema, and migration change. If anything changed, it returns `REVIEW_REQUIRED` with exit code `2`. This is intentionally not a passing result and does not claim that the data is corrupted.

Exit codes are:

- `0`: comparison passed with no unapproved strict changes
- `1`: hard failure, invalid snapshot, target mismatch, or unapproved strict change
- `2`: observe-mode changes require human review

## Limits

A before/after comparison cannot distinguish a release mutation from legitimate user activity during the same window. Strict mode therefore requires a controlled window; observe mode preserves the evidence and requires review.

The gate detects state differences, not their cause. It is not a backup and cannot restore data. Row fingerprints use PostgreSQL's built-in MD5 per row before a final SHA-256 reduction; this is suitable for accidental-change detection, not adversarial forensic proof. Schema fingerprints cover protected table columns, types, defaults, identity/generated flags, nullability, and collations. Functions, policies, grants, triggers, indexes, sequence values, views, storage objects, and Auth tables other than `auth.users` are outside that schema fingerprint and remain covered by migrations, schema checks, contract checks, and release review.

Snapshot quality also depends on the credential having `SELECT` access to every protected table. The command fails instead of silently accepting incomplete coverage.
