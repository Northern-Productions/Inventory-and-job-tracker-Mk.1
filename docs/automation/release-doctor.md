# Release Doctor

`release:doctor` is a read-only checklist helper for release preflight and post-release verification. It does not merge, push, deploy, apply migrations, mutate data, read secret values, or replace Codex judgment.

## Preflight

Run this before an approved release merge/push/deploy sequence:

```powershell
npm --prefix backend run release:doctor -- --mode preflight --base origin/main --head HEAD --expected-prod-ref tiwpulgvxtwlmqdnyuzd
```

The preflight prints:

- current branch and HEAD
- working tree status
- changed-file task tier
- required checks
- likely release actions
- stop conditions
- PROD env file presence by path only
- forbidden actions

Use the output to decide which checks must pass before release.

## Post-Release

Run this after an approved release has been pushed/deployed:

```powershell
npm --prefix backend run release:doctor -- --mode post --expected-commit <sha> --expected-prod-ref tiwpulgvxtwlmqdnyuzd
```

The post mode prints:

- current branch and HEAD
- origin/main HEAD
- whether local/origin HEAD match the expected release commit
- PROD env file presence by path only
- post-release verification checklist
- forbidden actions

## What It Does Not Do

The script intentionally does not:

- apply migrations
- run Supabase `db push`
- deploy Edge/API functions
- deploy Vercel
- call authenticated mutation endpoints
- query or print secret values
- clean up branches

## Pair With Repo Checks

Use the release doctor alongside the actual release checks required by the task tier.

Frontend-only example:

```powershell
npm --prefix frontend run test
npm --prefix frontend run build
git diff --check
npm --prefix backend run release:doctor -- --mode preflight --base origin/main --head HEAD --expected-prod-ref tiwpulgvxtwlmqdnyuzd
```

Edge/API example:

```powershell
npm --prefix backend run test:unit
npm --prefix backend run edge:test
npm --prefix backend run contract:parity
npm --prefix backend run release:doctor -- --mode preflight --base origin/main --head HEAD --expected-prod-ref tiwpulgvxtwlmqdnyuzd
```

Migration/schema example:

```powershell
npm --prefix backend run test:unit
npm --prefix backend run check:schema:latest
npm --prefix backend run release:doctor -- --mode preflight --base origin/main --head HEAD --expected-prod-ref tiwpulgvxtwlmqdnyuzd
```

## PROD Target Guard

Before any approved PROD operation, guard the target separately:

```powershell
npm --prefix backend run env:check:prod
```

If `.secrets/prod.env` is missing, restore it or use the repo-approved fallback only after a guard confirms the PROD ref. Do not print env contents.

## Safe Post-Release Read-Only Checks

Depending on the release surface, verify:

- origin/main contains the expected commit
- PROD migration history is aligned
- Edge `/health` reports the expected `apiBuildSha`
- Vercel production deployment is READY at the expected commit
- production app shell loads
- production bundle/config points to PROD, not DEV/local
- touched routes return auth/validation responses, not route-not-found or raw schema errors

Authenticated PROD mutation checks are skipped unless Rob/Sage explicitly approve a safe fixture-owned PROD path.
