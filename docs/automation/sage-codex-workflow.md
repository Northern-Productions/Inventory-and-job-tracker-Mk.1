# Sage / Codex Operating Workflow

This document captures how Rob, Sage, and Codex work together on the Window Film Inventory and Job Tracker app. It is part of the task-start reading path, alongside `AGENTS.md`, `docs/automation/codex-operating-manual.md`, `docs/automation/task-tiers.md`, and `docs/automation/release-doctor.md`.

## Roles

- Rob is the client and product owner. Rob describes the business goal, local review result, and release approval when a release is intended.
- Sage is the senior developer, technical lead, safety gate, and Codex prompt architect. Sage turns Rob's intent into a scoped Codex prompt, reviews Codex reports, identifies remaining risk, and recommends next steps.
- Codex is the implementation worker. Codex investigates, implements, verifies, commits feature-branch work, and reports clearly enough for Sage to review without reading the full transcript.

## Environment Model

- DEV is the proving ground for implementation, fixture data, workflow mutation verification, and browser checks.
- PROD is controlled-release only. Do not continue from DEV/local verification into PROD migration, PROD data mutation, Edge deploy, Vercel deploy, `main` push, or release verification unless Rob/Sage explicitly approve that release step.
- Prompt-specific instructions beat these general docs. If a prompt conflicts with the docs, stop and report the conflict instead of guessing.

## Sage Prompt Pattern

For substantial work, Sage generally converts Rob's request into a Codex-ready prompt with:

- Task Readback
- Task Type
- Likely Affected Areas
- Risks / Edge Cases
- Use Plan Mode: Yes/No
- Why
- Copy-paste-ready Codex Prompt

Future prompts should continue to start with:

```text
Before starting, read AGENTS.md and run `npm --prefix backend run codex:refresh`; classify the task tier and required checks; follow docs/automation/codex-operating-manual.md.
```

## Default Workflow

- No PRs by default.
- Rob works locally and alone unless a prompt says otherwise.
- Use local feature, fix, security, or ops branches for implementation.
- Sage reviews Codex reports before release.
- Work DEV-first. Release is a separate approval mode.
- Branch cleanup is not automatic. Keep migration, security, release, verification, and feature branches until Rob/Sage approve cleanup.
- Do not open a PR, merge `main`, push `main`, deploy, apply PROD migrations, mutate PROD data, repair PROD data, or delete branches unless the prompt explicitly approves that action.

## Implementation Structure

Codex should build like a senior developer:

- Keep code organized by existing feature/domain structure.
- Do not pile unrelated logic into one file.
- Frontend code belongs in the relevant feature pages, components, hooks, and utilities.
- Backend logic belongs in services, handlers, repositories, route modules, or scripts according to existing patterns.
- Shared behavior belongs in shared/domain modules or existing shared helpers.
- Migrations must be mirrored between `backend/migrations` and `supabase/migrations`.
- Tests should be focused and live near the relevant feature or tooling.
- Keep local backend and Supabase Edge/shared behavior aligned when both surfaces are affected.
- Do not duplicate business logic when a shared helper is appropriate.
- Do not introduce N+1 fetch patterns without calling out the risk and reason.

## Automation Expectations

Codex should do as much safe work as possible without making Rob coordinate routine mechanics:

- Run targeted tests first.
- Run full frontend/backend checks when the tier calls for them.
- Run `check:schema:latest` when schema or migrations are touched.
- Run `contract:parity` when API contracts or route behavior are touched.
- Run `edge:test` when Edge/shared code is touched.
- Use Playwright/Chrome browser verification for UI and workflow checks when available.
- Create guarded DEV fixtures when useful for approved DEV workflow verification.
- Clean up DEV fixtures when the prompt requires cleanup, and verify cleanup.
- Inspect git status before reporting.
- Return a Sage Alignment Report or release report with enough detail for Sage review.

## Stop Before These Actions

Codex must stop before:

- PROD migrations
- PROD data mutation
- PROD data repair
- Supabase Edge/API deploys
- Vercel manual deploys
- `main` merge or push unless release-approved
- branch cleanup or deletion
- auth, env, or secret changes
- broad cleanup commands
- raw SQL writes outside approved migrations
- `npm audit fix`
- anything that could print secrets

## Safety Principles

- If a task could affect material flow, tenant isolation, auth, migrations, or PROD data, classify conservatively.
- Do not guess around blockers.
- If blocked, explain the blocker and recommend the safe unblock path.
- Be explicit about what was intentionally not changed.
- Never print secrets, tokens, auth headers, DB URLs, service-role keys, anon keys, passwords, smoke credentials, or full env files.

## Report Shape

Codex reports should generally include:

- Mode used
- Branch, HEAD, and status before/after
- Files changed
- Implementation summary
- Tests/checks run
- DEV verification
- PROD verification when in release mode
- Skipped checks with reasons
- Safety confirmations
- Commit hash when committed
- Push status when relevant
- Final git status
- Recommended next step
