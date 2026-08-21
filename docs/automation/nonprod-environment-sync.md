# Non-Production Environment Sync Controls

This policy defines the controls for a future refresh of DEV and a future SANDBOX from one immutable PROD baseline. It does not authorize a refresh, a SANDBOX project, a deployment, or any PROD mutation.

## Targets

Every mutating wrapper must declare `dev`, `sandbox`, or `prod`. The wrapper must compare every discovered credential/project reference with the exact expected reference and reject cross-target state. Mutating `--linked` usage is forbidden; wrappers use explicit target/project configuration. PROD additionally requires the existing explicit PROD approval flag. SANDBOX fails closed until `SANDBOX_SUPABASE_PROJECT_REF` exists in an ignored guarded environment file.

Use:

```text
npm --prefix backend run env:inventory -- --target dev|prod|sandbox --env <guarded-file> [--allow-prod]
npm --prefix backend run env:postgres:preflight
npm --prefix backend run env:rehearse -- --env <guarded-prod-file> --allow-prod-readonly
```

`env:inventory` uses one `REPEATABLE READ READ ONLY` transaction and rolls it back. Output contains catalog/data fingerprints, counts, classifications, project metadata, and variable names only. It never emits credentials, emails, tokens, password hashes, connection strings, or secret values.

`env:postgres:preflight` is local-only. It requires a complete PostgreSQL 18 server payload, including `postgres`, `initdb`, `pg_ctl`, `pg_dump`, `pg_restore`, `psql`, runtime libraries, and `share/postgres.bki`. It initializes an owner-only temporary cluster with a random credential, binds only to loopback on a guarded random port, pins UTC for deterministic fingerprints, proves a query, stops the server, and removes the cluster before returning. PostgreSQL 18 `pg_dump` is used against PostgreSQL 17.6 because the supported logical-dump contract permits newer `pg_dump` clients to read older servers and restore into a newer major; physical-format compatibility is neither assumed nor used. Supply the verified vendor payload through process-local `POSTGRES_BIN`; do not install a service or modify global `PATH`.

## Golden Baselines

`GOLDEN_PROD_BASELINE_X` is an encrypted, restore-tested, immutable capture authenticated by a private HMAC manifest. `NONPROD_BASELINE_X_NP` is X after the versioned Auth and side-effect quarantine. Database bytes use AES-256-GCM; the data key is itself AES-256-GCM wrapped into a separately owner-protected, fsynced component while the wrapping key remains outside the artifact. Components carry exact byte sizes and SHA-256 digests. Manifests bind source time, source commit, migration state, catalog/routine/trigger/constraint/policy/grant identities, protected table fingerprints, Edge identity, platform classifications, side effects, and an exact allowed-exception list. Missing declared exceptions and undeclared differences both fail parity.

X-NP preserves copied Auth UUID relationships while replacing routable identity fields with deterministic `.invalid` values, invalidating password verifiers, banning copied accounts, clearing token-bearing user columns, sanitizing email identities, and deleting copied sessions, refresh tokens, one-time tokens, flow state, MFA, OAuth, SAML/SSO, WebAuthn, and Auth audit ephemera. It accepts only the reviewed Auth table/column/provider shape and only a disposable loopback rehearsal database. The Auth identities email column is generated from `identity_data`; quarantine updates the source JSON rather than assigning the generated column. Native rehearsal creates and verifies an independent unroutable smoke identity with a target-local credential after quarantine. Real target smoke users are still created through the target Auth Admin API with unique target credentials; copied credentials are never reused.

## Native Rehearsal Compatibility

Before X-NP, each native restore must equal the exported PROD snapshot for migrations, protected schema/data, application relations, columns, routines, triggers, semantic constraints and foreign keys, indexes, RLS policies, sequences, Auth topology, and direct application grants. Capture and comparison sessions use UTC so `timestamptz` fingerprints are deterministic. PostgreSQL 18's generated `contype = 'n'` catalog entries are excluded from the cross-major constraint signature only because exact column nullability is compared separately; PK, unique, FK, check, and exclusion semantics remain exact.

Generic PostgreSQL cannot reproduce Supabase Auth HTTP services, managed secrets/platform metadata, every managed extension, managed side-effect runtime, nonselected managed schemas, or server-role login attributes. Those are declared platform differences, not parity exceptions between derived targets. Database restoration, Auth relationship quarantine, credential replacement, session/token purge, side-effect no-call state, and domain contracts must pass locally; Auth HTTP, Edge, Storage, and browser behavior remain required on the real SANDBOX.

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

For B, run the complete PostgreSQL preflight first, pin source and restore fingerprint sessions to UTC, and require the native source-to-restore compatibility result before X-NP. The same encrypted component must feed both D and E. The rehearsal's shared structural smoke identity exists only to keep lineage fingerprints comparable; each real project must receive its own credential and Auth identity through its own Auth Admin API.

## Golden Workflow Contract

Both targets execute the tracked 20-step contract returned by `buildGoldenWorkflowContract`: native sign-in; org context; permissions; warehouse; inventory search; job create; allocation/removal; Requirement+Extra same-box; auto-allocation; Film Order lifecycle; immutable receipts; box receipt; transfer lifecycle; checkout/check-in; caulk lifecycle; labels; staged pickup; team/multi-org; job deletion; and authorization isolation. It requires guarded fixtures, exact private-manifest cleanup, and strict nonfixture after-state equality.

## Canonical Edge And Grant Decisions

The future nonproduction Edge candidate is the repository graph rooted at current main after its three post-v279 runtime changes are certified against the already-applied 0199-0202 contracts. Record the exact commit/tree, module graph, dependencies, and lock digest again at execution; do not choose it merely because it is newer.

PROD's dormant direct `app` SELECT grants are migration-era legacy drift. X must record and preserve their exact presence rather than silently normalize security during cloning. They are not canonical nonproduction authorization. A separate, reviewed PROD migration should revoke them and retain strict ACL assertions; sync tooling must not perform that remediation.

## Architecture Alignment Handoff

After refresh acceptance, use `buildArchitectureAlignmentTemplate`. Review inventory domains, physical film capacity, reservations, requirements/EXTRA, Film Orders/receipts, transfers, checkout/check-in, staged pickup, caulk, organizations/Auth, dependency graphs, workflow coverage, debt, and missing ADRs/tests/docs. Only then begin pooled-film reservation and staged physical-box assignment work in SANDBOX.
