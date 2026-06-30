# Codex Operating Rules

## Start Every Task

1. Read this file and `docs/automation/codex-operating-manual.md`.
2. Run `npm --prefix backend run codex:refresh`.
3. Classify the task tier before choosing checks.
4. Read `docs/material-flow-rules.md` before touching inventory, material flow, allocations, film orders, boxes, check-in, check-out, caulk, ownership, or reconciliation.
5. Use guarded DEV fixtures and authenticated browser verification for workflow or mutation changes.

## Default Workflow

- Work DEV-first on a feature branch.
- Inspect existing patterns before editing.
- Keep changes small, targeted, and maintainable.
- Commit finished feature-branch work after verification.
- Do not open a PR by default.
- Do not merge, push `main`, release, deploy, or clean up branches unless Rob/Sage explicitly approve that action.

## Safe Routine Commands

Codex may run local-safe commands such as `git status`, `git diff`, `git log`, `git fetch`, branch checkouts/creation for the task, tests, builds, lint/format checks, local browser checks, and guarded DEV fixture checks after the DEV target is verified.

## Forbidden Without Explicit Approval

- PROD migrations
- PROD data mutation
- Supabase Edge/API deploy
- Vercel manual deploy
- `git push main`
- branch deletion or cleanup
- raw SQL writes
- env/secrets changes
- `npm audit fix`

## Secrets

Never print secrets, tokens, auth headers, DB URLs, service-role keys, anon keys, passwords, smoke credentials, or full env files. Report only variable names, file paths, project refs, and redacted target summaries.

## Releases

For any release prompt, run or follow `npm --prefix backend run release:doctor -- --mode preflight` before merge/push/deploy, then follow `docs/automation/release-doctor.md`. Production mutation verification is skipped unless a clearly approved safe PROD fixture path exists.

## Reports

Final reports must include files changed, tests/checks run, verification results, skipped checks with reasons, safety confirmations, commit hash when committed, push status when relevant, and final `git status --short --branch`.
