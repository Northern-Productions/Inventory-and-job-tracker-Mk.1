# Authenticated DEV Browser Verification

This repo uses Playwright for repeatable authenticated DEV browser smoke checks.
Generated browser storage-state files contain Supabase auth material and must be
treated as secrets.

## Safety Rules

- Use DEV only: `uxiltcpbhthhinonttrc`.
- Never create browser auth state from PROD credentials.
- Never print storage-state contents, tokens, auth headers, DB URLs, or env file
  contents.
- Never save browser profiles or auth storage under `.codex-runlogs`.
- Do not commit `.secrets/`, browser profiles, Playwright reports, screenshots,
  traces, or runlogs.

## One-Time Smoke User Setup

If the DEV smoke user is not configured yet, provision it with the existing
guarded smoke helper:

```powershell
npm --prefix backend run env:check:dev
npm --prefix backend run smoke:provision-user
```

The provisioner stores smoke credentials in ignored `backend/.env`. Do not paste
those values into chat or reports.

## Create Auth Storage State

Generate Playwright storage state for the local app origin:

```powershell
npm --prefix backend run browser-auth:dev
```

Default output:

```text
.secrets/playwright/dev-storage-state.json
```

That file is ignored by git and should be regenerated when the smoke session
expires.

If a different local app origin is needed:

```powershell
node backend/scripts/create-dev-browser-auth-state.mjs --app-url http://localhost:5173
```

Use the same origin when running Playwright through `PLAYWRIGHT_BASE_URL`.

## Run The Authenticated Smoke

The smoke test starts or reuses the local backend and frontend dev servers:

```powershell
npm --prefix frontend run test:e2e:dev
```

The Phase 1 smoke is read-only. It opens the protected Inventory route and
confirms the app loads past the sign-in gate.

## Artifact Locations

- Playwright output: `test-results/playwright-<timestamp>/`
- HTML reports, if enabled later: `playwright-report/`
- Auth storage state: `.secrets/playwright/dev-storage-state.json`

All of these paths are ignored. Browser profiles should stay in temporary
locations and should not be copied into runlogs.
