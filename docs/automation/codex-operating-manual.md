# Codex Automation Operating Manual

This manual is the shared operating contract for Rob, Sage, and Codex. It keeps routine work fast while protecting secrets, DEV/PROD targets, schema state, and business data. Pair it with `docs/automation/sage-codex-workflow.md` for the collaboration model and report expectations.

## Project Targets

- DEV Supabase project ref: `uxiltcpbhthhinonttrc`
- PROD Supabase project ref: `tiwpulgvxtwlmqdnyuzd`
- `backend/.env` should stay DEV by default.
- PROD credentials must stay separate, ignored, and out of normal local startup paths. Prefer `.secrets/prod.env` when available.
- The checked-in Supabase project link may point at PROD. Treat mutating `supabase --linked` commands as PROD mutations unless the target is explicitly confirmed.

## Start Every Task

1. Read `AGENTS.md`.
2. Read this manual.
3. Read `docs/automation/task-tiers.md`, `docs/automation/release-doctor.md`, and `docs/automation/sage-codex-workflow.md`.
4. Run the read-only repository foundation gate:

```powershell
npm --prefix backend run repo:doctor
```

Stop ordinary implementation when it reports `REPOSITORY_UNSAFE_FOR_CODEX`. The doctor diagnoses but never repairs, and warnings never authorize cleanup. Protected Git metadata repair requires explicit Rob/Sage authorization.

5. Run:

```powershell
npm --prefix backend run codex:refresh
```

6. Classify the changed files or requested work:

```powershell
npm --prefix backend run codex:classify -- --base origin/main --head HEAD
```

7. Use `docs/automation/task-tiers.md` to pick checks and verification.
8. Read `docs/material-flow-rules.md` before touching inventory, boxes, allocations, material flow, caulk, film orders, check-in, check-out, ownership, or reconciliation.
9. Confirm the prompt has explicit release approval before merge, main push, PROD migration, Edge deploy, Vercel deploy, or PROD mutation.

## Codex End-to-End Task Ownership

### Ownership And Decision Boundary

Codex owns the technical method and task-scoped DEV execution of assigned work end to end. Rob and Sage retain ownership of product intent, acceptance criteria, material scope decisions, destructive or irreversible exceptions, and the final PROD approval gate.

For each assigned task, Codex independently:

1. Understands the actual goal and current implementation.
2. Inspects relevant source, tests, documentation, schema, tooling, and DEV evidence.
3. Chooses the safest best-practice method and prefers canonical repository mechanisms and shared helpers.
4. Implements all coherent changes reasonably required to complete the approved outcome.
5. Creates or improves tooling when it materially improves correctness, safety, repeatability, maintainability, or efficiency.
6. Runs targeted checks after meaningful changes and the complete tier-required certification before completion.
7. Diagnoses and corrects failures without returning for repeated approval when the correction remains within the product outcome and safety boundaries.
8. Completes required browser, API, database, cleanup, and after-state verification.
9. Removes temporary artifacts, leaves repository and fixture state clean and explainable, and returns a complete report.

A prompt's suggested implementation method is not binding when repository evidence supports a safer, more accurate, maintainable, efficient, or canonical method. Codex may deviate while preserving the requested product outcome and must explain the technical decision in the final report. Explicit prohibitions, acceptance criteria, safety boundaries, and material scope decisions are not method suggestions and remain binding.

### Best-Method Priorities

Choose the simplest robust solution that fits the existing architecture. Optimize in this order:

1. Correctness and data integrity.
2. Security and authorization safety.
3. Preservation of explicit product behavior.
4. Canonical repository architecture and conventions.
5. Testability and independently verifiable evidence.
6. Maintainability and clarity.
7. Minimal coherent scope.
8. Efficiency.

Best does not mean the largest redesign or most elaborate verification harness.

### Standing Task-Scoped DEV Authority

An assigned DEV task authorizes Codex to continue through ordinary, directly required, guarded DEV work without stage-by-stage approval. Subject to target verification, task-tier rules, and all safety controls, Codex may:

- inspect repository and DEV state;
- run safe local and read-only checks;
- edit application code, tests, documentation, and tracked tooling directly required by the task;
- create local feature branches and verified commits under repository policy;
- create temporary external diagnostics;
- improve or replace brittle temporary verification methods;
- promote reusable diagnostics into tested and documented tracked tooling;
- run guarded DEV fixture workflows, browser verification, and API verification;
- perform exact manifest-authorized cleanup of task-owned DEV fixtures;
- correct implementation and test failures within the approved outcome; and
- continue through implementation, certification, cleanup, and final reporting.

Shared-DEV quiet-window confirmation remains required whenever unrelated activity could invalidate a baseline, fixture, mutation test, cleanup proof, or strict after-state comparison. Target guards, tenant isolation, fixture ownership, manifest authority, one-shot cleanup rules, and after-state verification remain mandatory.

DEV migrations, DEV deploys, account provisioning, auth or secret changes, broad or recovery cleanup, and shared business-data mutations outside a guarded fixture require the explicit task-level authorization described below. Once authorized, routine execution does not require repeated approval unless the target, product outcome, material scope, or risk changes.

### Product-Intent Boundary

Codex owns the method, not the product decision. Stop for clarification when multiple materially different user-facing behaviors are valid, acceptance criteria are contradictory or genuinely ambiguous, completing the task would redefine the feature, or a broader business decision is required.

Do not silently change public API contracts, user-visible workflows, authorization semantics, roles or ownership behavior, data-retention behavior, or product requirements unless directly required by the approved task and clearly reported. If the safest method requires material scope expansion or a prohibited action, stop and request that decision.

### Integrity And Anti-Gaming

Codex must never:

- weaken or delete a valid test merely to obtain a pass;
- weaken ACLs, RLS, integrity checks, safety guards, or cleanup controls;
- alter application behavior merely to satisfy a faulty verifier;
- treat a temporary-harness assumption as a product requirement;
- hide or suppress an unexpected failure;
- repair, delete, or reclassify unexplained DEV business data merely to restore an expected baseline;
- silently broaden cleanup targets or material task scope; or
- claim verification passed while material evidence is incomplete.

When a verifier or diagnostic is defective, correct or replace it and independently certify the correction.

### Temporary And Tracked Tooling

Temporary diagnostics may be created outside tracked source when appropriate. They must fail closed, preserve privacy, avoid PROD, leave no residual artifact, and be removed after safe evidence is retained.

Convert a diagnostic or helper into tracked tooling when it is likely to be reused, prevents recurring failures, or materially improves project safety. Tracked tooling requires focused tests, clear documentation, deterministic behavior, privacy and target guards, and production-runtime isolation where applicable.

Use `npm --prefix backend run migrations:registry -- --check` as the canonical migration metadata/coherence check. Migration files remain authoritative; unrelated tests must not hand-maintain the global latest migration. See `docs/automation/migration-registry.md`.

Use `npm --prefix backend run diagnostics:readonly` for reusable Tier-6 read-only database evidence when its conservative inventory model can express the investigation. Raw bespoke harnesses remain permissible when the canonical engine cannot safely represent required evidence, but repeated patterns should be promoted into reviewed tracked inventories/tooling. Diagnostics never authorize a target, mutate or repair data, bypass quiet-window rules, or replace DEV/PROD approval. See `docs/automation/read-only-diagnostics.md`.

### Genuine Blockers

Stop only when safe continuation is impossible because of a genuine blocker, such as:

- missing required access, credentials, or external availability;
- inability to prove the target or mutation safety;
- unresolved destructive or irreversible risk;
- unexplained live-data drift or integrity ambiguity;
- contradictory evidence that cannot be resolved read-only;
- a required product decision;
- an action outside the approved task; or
- a required PROD action.

Before stopping, exhaust safe canonical diagnostic options. Do not stop merely because the first proposed method failed. A blocker report must identify the precise blocker, supporting evidence, attempted diagnostics, why continuation is unsafe, what remains unchanged, and the safest next action.

### PROD Checkpoint

PROD is an absolute checkpoint. Before any PROD action, stop and return a complete DEV completion and release-readiness report for Rob's personal testing. Only Rob's explicit post-testing instruction, such as "bring this to PROD," authorizes PROD planning or execution.

Without that approval, do not access or query PROD, authenticate against PROD, mutate or repair PROD data, apply PROD migrations, deploy PROD Edge or frontend, change PROD secrets or Auth policy, merge or push in a way that triggers production, or perform another production release action. A successful DEV result never carries implicit authority into PROD.

### Completion Standard

A task is complete only when the intended behavior is implemented; relevant targeted and full checks pass; browser and API verification is complete where applicable; data invariants and authorization behavior are proven; fixture and temporary state are cleaned; strict after-state equality is proven where required; documentation is current; temporary artifacts are removed; Git state is clean; and risks, limitations, skipped checks, and remaining work are reported honestly.

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

After the DEV target is stated or confirmed, Codex may run read-only platform checks against DEV:

- Supabase project and migration status reads
- DEV platform and deployment status reads
- unauthenticated `/health` GET checks
- guarded env target checks

The PROD checkpoint applies even to read-only platform access. PROD status, health, schema, migration, or data reads require Rob's explicit post-testing PROD instruction.

## Commands Requiring Explicit DEV Instruction

Standing task-scoped DEV authority covers routine local work, read-only inspection, guarded fixture workflows, exact manifest-authorized fixture cleanup, and required browser/API verification. The following persistent, target-changing, broadly mutating, or identity-affecting actions still require explicit task-level DEV instruction and a confirmed DEV project ref:

- DEV migration dry-run or apply
- DEV Edge deploy
- DEV smoke user provisioning
- DEV auth, account, role, membership, permission, environment, or secret changes
- shared DEV business-data mutation outside an approved guarded fixture workflow
- broad, discovery-based, recovery-specific, or non-manifest cleanup

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
- broad, discovery-based, recovery-specific, or non-manifest cleanup apply scripts
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

Create and mutate only clearly tagged fixture records after DEV target verification. Complete the ordinary fixture lifecycle with exact manifest-authorized cleanup and required after-state verification unless the task explicitly retains the fixture for review or a genuine blocker makes cleanup unsafe. Never broaden cleanup beyond captured fixture authority.

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
- Create a pre-release integrity snapshot; use strict comparison for high-risk migrations.
- Check migration status before apply.
- Apply only approved migrations.
- Re-check migration status and schema/latest.
- Create the post-release integrity snapshot and compare it before sign-off.
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
- Bracket the approved release window with `release:integrity` snapshots.
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

Pair it with the read-only integrity gate documented in `docs/automation/release-integrity.md`. Strict comparison is recommended when a controlled release window is available, especially for high-risk migrations. Observe comparison reports changes as review-required when normal user activity cannot be paused.

## Git Workflow

- Use feature branches for implementation.
- Commit verified feature-branch work.
- Do not open PRs by default.
- Do not merge into `main`, push `main`, or clean up branches unless explicitly approved.
- Keep migration, security, release, verification, and feature branches until Rob/Sage approve cleanup.
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
Before starting, read AGENTS.md and run `npm --prefix backend run codex:refresh`; classify the task tier and required checks; follow docs/automation/codex-operating-manual.md.
```
