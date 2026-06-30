# Codex Automation Operating Manual

This manual is the shared operating contract for Rob, Sage, and Codex. It keeps routine work fast while protecting secrets, DEV/PROD targets, schema state, and business data.

## Project Targets

- DEV Supabase project ref: `uxiltcpbhthhinonttrc`
- PROD Supabase project ref: `tiwpulgvxtwlmqdnyuzd`
- `backend/.env` should stay DEV by default.
- PROD credentials must stay separate, ignored, and out of normal local startup paths. Prefer `.secrets/prod.env` when available.
- The checked-in Supabase project link may point at PROD. Treat mutating `supabase --linked` commands as PROD mutations unless the target is explicitly confirmed.

## Start Every Task

1. Read `AGENTS.md`.
2. Read this manual.
3. Run:

```powershell
npm --prefix backend run codex:refresh
```

4. Classify the changed files or requested work:

```powershell
npm --prefix backend run codex:classify -- --base origin/main --head HEAD
```

5. Use `docs/automation/task-tiers.md` to pick checks and verification.
6. Read `docs/material-flow-rules.md` before touching inventory, boxes, allocations, material flow, caulk, film orders, check-in, check-out, ownership, or reconciliation.
7. Confirm the prompt has explicit release approval before merge, main push, PROD migration, Edge deploy, Vercel deploy, or PROD mutation.

## Secret Handling

Codex must never print secrets or full env files. Rob should never paste DB URLs, service-role keys, auth tokens, smoke user passwords, Supabase DB passwords, or full `.env` contents into chat.

Safe outputs include variable names, file paths, project refs, and redacted target summaries. Unsafe outputs include connection strings, bearer tokens, service-role keys, API keys, passwords, and copied env files.

## Safe Routine Commands

For normal feature work, Codex may run local-only verification:

- `git status --short --branch`
- `git fetch origin --prune`
- `git diff`
- `git diff --check`
- targeted frontend/backend tests
- `npm --prefix frontend run test`
- `npm --prefix frontend run build`
- `npm --prefix backend run test:unit`
- `npm --prefix backend run contract:parity`
- `npm --prefix backend run edge:test`
- targeted `node --test ...`
- local browser checks

After the target is stated or confirmed, Codex may run read-only platform checks:

- Supabase project and migration status reads
- Vercel production status reads
- unauthenticated `/health` GET checks
- guarded env target checks

## Commands Requiring Explicit DEV Instruction

Codex may run these only when Rob clearly asks for a DEV operation and the DEV project ref is confirmed:

- DEV migration dry-run or apply
- DEV Edge deploy
- DEV smoke user provisioning
- DEV mutating smoke checks on clearly marked fixture data

## Commands Requiring Explicit PROD Release Instruction

Codex may run these only during an explicit PROD release request:

- PROD migration dry-run or apply
- PROD Supabase Edge/API deploy
- PROD health verification
- PROD smoke verification on clearly labeled smoke/test records
- `git push main`

## Never Automatic

Codex must not run these without explicit approval:

- DB migration apply
- Edge deploy
- Vercel deploy
- scripts ending in or containing `:apply`
- cleanup apply scripts
- import, backfill, or reconcile apply scripts
- mutating Supabase `--linked` commands
- PROD smoke mutations
- branch deletion or cleanup
- env/secrets changes
- raw SQL writes
- `npm audit fix`

## Task Tiers And Checks

Use `docs/automation/task-tiers.md` and the classifier output. If a task spans multiple tiers, use the highest tier.

Fast map:

- Tier 0: docs/tooling only.
- Tier 1: frontend visual/text/layout only.
- Tier 2: frontend workflow/cache/route behavior.
- Tier 3: backend/local runtime.
- Tier 4: Edge/shared/API.
- Tier 5: schema/migration/RPC.
- Tier 6: material-flow, inventory mutation, allocation, check-in, checkout, caulk reconciliation.

## Browser Harness

Authenticated DEV browser checks use Playwright. See `docs/automation/browser-verification.md`.

Common commands:

```powershell
npm --prefix backend run browser-auth:dev
npm --prefix frontend run test:e2e:dev
```

Generated storage state under `.secrets/playwright/` is secret material and must not be printed or committed.

## DEV Fixtures

Use guarded DEV fixture tooling for mutation/workflow verification. See `docs/automation/dev-fixtures.md`.

Common commands:

```powershell
npm --prefix backend run fixtures:dev:create -- --scenario checked-out-box-job
npm --prefix backend run fixtures:dev:verify -- --tag CODEX_DEV_FIXTURE_SCENARIO_12345678901
npm --prefix backend run fixtures:dev:cleanup -- --tag CODEX_DEV_FIXTURE_SCENARIO_12345678901
```

Create and mutate only clearly tagged fixture records after DEV target verification. Clean up exact fixture-owned records when the prompt requires cleanup.

## Release Modes

### Frontend-Only Release

- Merge approved frontend branch into `main`.
- Run frontend tests/build and relevant browser visual checks.
- Push `main` only after approval and checks.
- Verify Vercel production commit and app shell.
- No migrations or Edge deploy expected.

### Migration-Only Release

- Confirm approved migration files and mirrors.
- Guard PROD target.
- Check migration status before apply.
- Apply only approved migrations.
- Re-check migration status and schema/latest.
- No Edge/Vercel deploy unless code also changed.

### Edge/API Release

- Run backend unit tests, Edge tests, and contract parity.
- Guard PROD project ref.
- Deploy only intended Edge function(s).
- Verify Edge `/health` build SHA.
- Run safe unauthenticated route smokes.

### Mixed Release

- Use release order: migrations first, then Edge/API, then frontend.
- Verify each surface before moving to the next.
- Perform read-only PROD smoke unless an approved fixture mutation exists.

## Release Doctor

Before release work:

```powershell
npm --prefix backend run release:doctor -- --mode preflight --base origin/main --head HEAD --expected-prod-ref tiwpulgvxtwlmqdnyuzd
```

After release work:

```powershell
npm --prefix backend run release:doctor -- --mode post --expected-commit <sha> --expected-prod-ref tiwpulgvxtwlmqdnyuzd
```

The release doctor is read-only. It standardizes the checklist but does not replace Codex judgment or Rob/Sage approval.

## Git Workflow

- Use feature branches for implementation.
- Commit verified feature-branch work.
- Do not open PRs by default.
- Do not merge into `main`, push `main`, or clean up branches unless explicitly approved.
- If the worktree is dirty, preserve user changes and avoid reverting unrelated work.

## Sage Alignment Report

Every final report should include:

- mode used
- starting branch/HEAD/status
- final branch/HEAD/status
- files changed
- implementation summary
- tests/checks run and results
- browser/fixture/runtime verification result when relevant
- skipped checks with reasons
- app behavior changed or not
- migrations/deploys/data mutation status
- secrets printed or not
- commit hash when committed
- push status
- final `git status --short --branch`
- recommended next step

## Future Prompt Snippet

Sage can shorten future prompts by starting with:

```text
Before starting, read AGENTS.md and run the Codex refresh checklist. Classify the task tier and report required checks. Follow docs/automation/codex-operating-manual.md. Do not perform forbidden actions without explicit approval.
```
