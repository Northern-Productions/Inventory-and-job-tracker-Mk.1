# Codex Automation Operating Manual

This manual is the shared safety contract for Rob, Sage, and Codex. Its goal is
to let Codex run as much verification as possible while keeping secrets,
production data, and deployment targets safe.

## Project Targets

- DEV Supabase project ref: `uxiltcpbhthhinonttrc`
- PROD Supabase project ref: `tiwpulgvxtwlmqdnyuzd`
- `backend/.env` should stay DEV by default.
- PROD credentials must stay separate, ignored, and out of normal local startup
  paths. Prefer `.secrets/prod.env` or another ignored file.
- The checked-in Supabase project link may point at PROD. Treat mutating
  `supabase --linked` commands as PROD mutations unless the target is explicitly
  confirmed.

## Secret Handling

Codex must never print secrets or full env files. Rob should never paste DB
URLs, service-role keys, auth tokens, smoke user passwords, Supabase DB
passwords, or full `.env` contents into chat.

Safe outputs include variable names, file paths, project refs, and redacted
target summaries. Unsafe outputs include connection strings, bearer tokens,
service-role keys, API keys, passwords, and copied env files.

## Commands Codex May Run Automatically

For normal feature work, Codex may run local-only verification:

- `git status --short`
- `git diff --check`
- frontend targeted tests
- `npm --prefix frontend test`
- `npm --prefix frontend run build`
- `npm --prefix backend run test:unit`
- `npm --prefix backend run contract:parity`
- targeted `node --test ...`
- Deno Edge unit tests

After the target is stated or confirmed, Codex may run read-only platform
checks:

- Supabase project and migration status reads
- Vercel production status reads
- unauthenticated `/health` GET checks
- guarded env target checks

## Commands Requiring Explicit DEV Instruction

Codex may run these only when Rob clearly asks for a DEV operation and the DEV
project ref is confirmed:

- DEV migration dry-run or apply
- DEV Edge deploy
- DEV smoke user provisioning
- DEV mutating smoke checks on clearly marked smoke data

## Commands Requiring Explicit PROD Release Instruction

Codex may run these only during an explicit PROD release request:

- PROD migration dry-run or apply
- PROD Supabase Edge `api` deploy
- PROD health verification
- PROD smoke verification on clearly labeled smoke/test records

## Never Automatic

Codex must not run these without explicit release or mutation instructions:

- DB migration apply
- Edge deploy
- Vercel deploy
- scripts ending in or containing `:apply`
- cleanup apply scripts
- import, backfill, or reconcile apply scripts
- mutating Supabase `--linked` commands
- PROD smoke mutations

## Feature Workflow

1. Start on a feature branch, not `main`.
2. Inspect existing patterns before editing.
3. Make minimal, targeted changes.
4. Run targeted tests first.
5. Run broader local checks when the touched surface warrants it.
6. Report files changed, checks run, skipped checks, and final git status.

## Merge-Readiness Workflow

1. Confirm branch and clean status.
2. Inspect the diff against `main`.
3. Run targeted tests, full relevant suites, build, and `git diff --check`.
4. Use read-only platform checks only if target is clear.
5. Report ready or not ready. Do not merge unless asked.

## DEV Migration And Smoke Workflow

1. Confirm DEV ref `uxiltcpbhthhinonttrc`.
2. Confirm the env file points only at DEV.
3. Check migration status before applying anything.
4. Prefer dry-run and read-only smoke first.
5. Run DEV mutating smoke only on smoke data and only after explicit
   instruction.

## PROD Release Workflow

1. Confirm branch, commit, and clean status.
2. Confirm PROD ref `tiwpulgvxtwlmqdnyuzd`.
3. Confirm Vercel production status read-only.
4. Check migration status and apply only intended migrations.
5. Deploy only the intended Edge function, usually `api`.
6. Verify `/health` build metadata.
7. Run read-only live checks.
8. Run mutating smoke only on clearly labeled smoke/test records.
9. Report every action and confirm no unrelated deployment or data mutation.

## Smoke Data Rules

DEV should have a dedicated smoke user and durable smoke records. PROD smoke
must use a clearly labeled smoke/test ordered box or order created through the
normal app workflow. If safe smoke data does not exist, Codex should stop at
read-only verification and report that persistence smoke was skipped.

Cleanup should be dry-run first and scoped to known smoke artifacts. Broad
cleanup is never automatic.

## Final Report Expectations

Every Codex final report should include:

- branch name
- summary of changes or actions
- files changed, if any
- commands run and results
- skipped checks and exact reasons
- final `git status --short`
- confirmation that no secrets were printed
- confirmation that no unintended migrations, deploys, DB mutations, or smoke
  mutations were performed
