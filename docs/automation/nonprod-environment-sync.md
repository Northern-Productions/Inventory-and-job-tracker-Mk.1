# Non-Production Environment Sync Controls

This policy defines the controls for a future refresh of DEV and a future SANDBOX from one immutable PROD baseline. It does not authorize a refresh, a SANDBOX project, a deployment, or any PROD mutation.

## Targets

Every mutating wrapper must declare `dev`, `sandbox`, or `prod`. The wrapper must compare every discovered credential/project reference with the exact expected reference and reject cross-target state. Mutating `--linked` usage is forbidden; wrappers use explicit target/project configuration. PROD additionally requires the existing explicit PROD approval flag. SANDBOX fails closed until `SANDBOX_SUPABASE_PROJECT_REF` exists in an ignored guarded environment file.

Use:

```text
npm --prefix backend run env:inventory -- --target dev|prod|sandbox --env <guarded-file> [--allow-prod]
npm --prefix backend run env:rehearse -- --env <guarded-prod-file> --allow-prod-readonly
```

`env:inventory` uses one `REPEATABLE READ READ ONLY` transaction and rolls it back. Output contains catalog/data fingerprints, counts, classifications, project metadata, and variable names only. It never emits credentials, emails, tokens, password hashes, connection strings, or secret values.

## Golden Baselines

`GOLDEN_PROD_BASELINE_X` is an encrypted, restore-tested, immutable capture authenticated by a private HMAC manifest. `NONPROD_BASELINE_X_NP` is X after the versioned Auth and side-effect quarantine. Components carry exact byte sizes and SHA-256 digests. Manifests bind source time, source commit, migration state, catalog/routine/trigger/constraint/policy/grant identities, protected table fingerprints, Edge identity, platform classifications, side effects, and an exact allowed-exception list. Missing declared exceptions and undeclared differences both fail parity.

X-NP preserves copied Auth UUID relationships while replacing routable identity fields with deterministic `.invalid` values, invalidating password verifiers, banning copied accounts, clearing token-bearing user columns, sanitizing email identities, and deleting copied sessions, refresh tokens, one-time tokens, flow state, MFA, OAuth, SAML/SSO, WebAuthn, and Auth audit ephemera. It accepts only the reviewed Auth table/column/provider shape and only a disposable loopback rehearsal database. Target-native smoke users are created later through the target Auth Admin API with unique target credentials; copied credentials are never reused.

## Side-Effect Quarantine

Before exposure, both DEV and SANDBOX must positively prove: Auth email is disabled or sink-only; SMS is disabled; outbound vendor/PROD secrets are absent; Edge secrets are target-local; cron, database webhooks, foreign wrappers/tables, and external calls are absent or explicitly disabled; Storage behavior is reviewed; URLs are nonproduction; and no production frontend alias is attached. Installed network extensions are not treated as disabled without a separate positive no-call policy and zero callers.

## Frontend Policy

The initial SANDBOX frontend is local and explicitly pointed at SANDBOX, using an isolated browser context. A later preview is optional and separately approved. SANDBOX must never use the production Vercel alias. Target-specific ignored files use the same names: `VITE_API_BASE_URL`, `VITE_PROXY_TARGET`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`. Backend guarded files use `SUPABASE_URL`, `EDGE_API_BASE_URL`, the target database URL name, and target-local smoke variable names. Values remain private.

Vercel configuration was not changed by this tooling. A future preflight must positively inventory environment/alias scope before any preview is connected.

## SANDBOX Specification

- Name: `Spreadsheet Inventory Tracker SANDBOX`
- Region: `us-west-2`, matching the currently verified PROD region; reverify at creation time
- Compute: Micro
- Expected incremental compute: approximately the provider's then-current Micro rate (currently about $10/month), verified before purchase
- PITR: none initially
- Project ref: future provider value in `SANDBOX_SUPABASE_PROJECT_REF`
- Guarded backend file: ignored `backend/.env.sandbox`
- Local frontend file: ignored `frontend/.env.sandbox.local`
- Database variables: `SANDBOX_DATABASE_URL` and existing guarded aliases only when byte-equal
- Smoke variables: repository-standard smoke variable names with SANDBOX-unique values
- Visible label: `SANDBOX` in target-local configuration and UI environment banner where supported

No project is created by this specification.

## DEV Preservation And Recovery Y

The private DEV preservation manifest records exact smoke Auth/user and membership mappings, role category, approved Auth/project settings, environment and secret variable names, and retained test configuration. Exact private IDs live only in protected ignored evidence. It excludes broad business history, sessions, refresh tokens, flow state, and disposable tagged fixtures.

Before a real refresh, create encrypted `DEV_PRE_REFRESH_RECOVERY_Y`, authenticate its component manifest, restore-test it, and bind it to the preservation-manifest digest. Retain X and Y through Rob/Sage acceptance.

## Machine-Actionable Runbook

1. **A - Stable PROD:** prove provider-restorable recovery, health, quiet read-only snapshot, source/runtime identity.
2. **B - Golden X:** capture one synchronized read-only X, encrypt, hash, restore-test, authenticate manifest.
3. **C - DEV recovery Y:** capture/encrypt/restore-test Y and the private preservation manifest.
4. **D - SANDBOX:** create only after approval, guard target, restore X, apply X-NP, apply SANDBOX settings, create a native smoke user, deploy canonical Edge, verify local frontend, run golden workflows, and prove parity.
5. **E - DEV:** only after D passes, reverify target, use the reviewed replacement method, restore the same X, apply the same X-NP, apply declared DEV preservation, deploy the same Edge identity, run workflows, and prove parity.
6. **F - Lineage:** prove `PROD X -> SANDBOX X-NP` and `PROD X -> DEV X-NP + declared DEV exceptions`; retain X/Y through acceptance.

Any failed target, component, quarantine, parity, cleanup, or protected-state gate stops the run without broad recovery actions.

## Golden Workflow Contract

Both targets execute the tracked 20-step contract returned by `buildGoldenWorkflowContract`: native sign-in; org context; permissions; warehouse; inventory search; job create; allocation/removal; Requirement+Extra same-box; auto-allocation; Film Order lifecycle; immutable receipts; box receipt; transfer lifecycle; checkout/check-in; caulk lifecycle; labels; staged pickup; team/multi-org; job deletion; and authorization isolation. It requires guarded fixtures, exact private-manifest cleanup, and strict nonfixture after-state equality.

## Canonical Edge And Grant Decisions

The future nonproduction Edge candidate is the repository graph rooted at current main after its three post-v279 runtime changes are certified against the already-applied 0199-0202 contracts. Record the exact commit/tree, module graph, dependencies, and lock digest again at execution; do not choose it merely because it is newer.

PROD's dormant direct `app` SELECT grants are migration-era legacy drift. X must record and preserve their exact presence rather than silently normalize security during cloning. They are not canonical nonproduction authorization. A separate, reviewed PROD migration should revoke them and retain strict ACL assertions; sync tooling must not perform that remediation.

## Architecture Alignment Handoff

After refresh acceptance, use `buildArchitectureAlignmentTemplate`. Review inventory domains, physical film capacity, reservations, requirements/EXTRA, Film Orders/receipts, transfers, checkout/check-in, staged pickup, caulk, organizations/Auth, dependency graphs, workflow coverage, debt, and missing ADRs/tests/docs. Only then begin pooled-film reservation and staged physical-box assignment work in SANDBOX.
