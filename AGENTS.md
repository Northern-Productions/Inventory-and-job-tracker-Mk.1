# Codex Operating Rules

## Start Every Task

1. Read this file, `docs/automation/codex-operating-manual.md`, `docs/automation/task-tiers.md`, `docs/automation/release-doctor.md`, and `docs/automation/sage-codex-workflow.md`.
2. Run `npm --prefix backend run repo:doctor`. Stop ordinary implementation if it reports `REPOSITORY_UNSAFE_FOR_CODEX`; the doctor never repairs metadata.
3. Run `npm --prefix backend run codex:refresh`.
4. Classify the task tier before choosing checks.
5. Read `docs/material-flow-rules.md` before touching inventory, material flow, allocations, film orders, boxes, check-in, check-out, caulk, ownership, or reconciliation.
6. Use guarded DEV fixtures and authenticated browser verification for workflow or mutation changes.

## Default Workflow

- Work DEV-first on a feature branch.
- Rob is the client/product owner, Sage is the technical lead and safety gate, and Codex is the implementation worker. See `docs/automation/sage-codex-workflow.md`.
- Inspect existing patterns before editing.
- Keep changes small, targeted, and maintainable.
- Commit finished feature-branch work after verification.
- Do not open a PR by default.
- Do not merge, push `main`, release, deploy, or clean up branches unless Rob/Sage explicitly approve that action.

## Codex End-to-End Task Ownership

Codex owns the technical method and task-scoped DEV execution of assigned work end to end. Rob and Sage retain product intent, acceptance criteria, material scope decisions, destructive or irreversible exceptions, and the final PROD approval gate.

- Independently inspect the implementation and evidence, choose the safest canonical method, implement the coherent work required, diagnose failures, run required verification, clean up temporary and fixture state, and return a complete report.
- A suggested method may be replaced when repository evidence supports a safer, more accurate, maintainable, efficient, or canonical approach. Preserve the approved product outcome, respect explicit safety boundaries, and explain the decision.
- Stop only for a genuine blocker after exhausting safe canonical diagnostics. Never weaken tests, authorization, integrity checks, cleanup controls, or product behavior to manufacture a pass.
- Standing DEV authority does not authorize PROD access, releases, destructive exceptions, broad cleanup, secrets or auth changes, or bypassing target guards and quiet-window requirements.

See `docs/automation/codex-operating-manual.md#codex-end-to-end-task-ownership` for the detailed ownership, blocker, tooling, completion, and PROD-gate policy. Stricter security, mutation, release, and cleanup rules remain controlling.

## Safe Routine Commands

Codex may run local-safe commands such as `git status`, `git diff`, `git log`, `git fetch`, branch checkouts/creation for the task, tests, builds, lint/format checks, local browser checks, and guarded DEV fixture checks after the DEV target is verified.

`repo:doctor` warnings do not authorize cleanup. Protected Git metadata repair still requires explicit Rob/Sage authorization.

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

For any release prompt, run or follow `npm --prefix backend run release:doctor -- --mode preflight` before merge/push/deploy, then follow `docs/automation/release-doctor.md`. Use the read-only `release:integrity` pre/post snapshots from `docs/automation/release-integrity.md`; strict mode is recommended for high-risk migrations. Production mutation verification is skipped unless a clearly approved safe PROD fixture path exists.

## Reports

Final reports must include files changed, tests/checks run, verification results, skipped checks with reasons, safety confirmations, commit hash when committed, push status when relevant, and final `git status --short --branch`.
