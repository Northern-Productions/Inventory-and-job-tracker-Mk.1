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

X-NP preserves copied Auth UUID relationships while replacing routable identity fields with deterministic `.invalid` values, invalidating password verifiers, banning copied accounts, clearing token-bearing user columns, sanitizing email identities, and deleting copied sessions, refresh tokens, one-time tokens, flow state, MFA, OAuth, SAML/SSO, WebAuthn, and Auth audit ephemera. It accepts only the reviewed Auth table/column/provider shape. Rehearsals require the disposable loopback guard. An authorized managed run additionally requires an exact DEV/SANDBOX mutation-target report, connection-derived project-ref equality, a non-loopback `postgres` database session, the dedicated application name, and SSL; PROD is categorically rejected. The Auth identities email column is generated from `identity_data`; quarantine updates the source JSON rather than assigning the generated column. Native rehearsal creates and verifies an independent unroutable smoke identity with a target-local credential after quarantine. Real target smoke users are still created through the target Auth Admin API with unique target credentials; copied credentials are never reused.

## Native Rehearsal Compatibility

Before X-NP, each native restore must equal the exported PROD snapshot for migrations, protected schema/data, application relations, columns, routines, triggers, semantic constraints and foreign keys, indexes, RLS policies, sequences, Auth topology, and direct application grants. Capture and comparison sessions use UTC so `timestamptz` fingerprints are deterministic. PostgreSQL 18's generated `contype = 'n'` catalog entries are excluded from the cross-major constraint signature only because exact column nullability is compared separately; PK, unique, FK, check, and exclusion semantics remain exact.

Managed nonproduction replacement must use the target-native overlay, not a broad `pg_restore --clean` of the source archive. The broad method attempts to clean target-native Auth objects and fails when the managed `postgres` role is not their owner. The overlay authenticates the encrypted archive, classifies every TOC item, proves the target catalog in a rolled-back read-only transaction, and binds the catalog, Auth shape, application-replacement, archive, and restore-plan digests before mutation. Unknown objects fail closed.

The compatibility manifest assigns every TOC entry exactly one action: `restore`, `transform`, `skip-as-managed`, `recreate-target-locally`, or `preserve-target-native`, with a nonblank reason. It restores only `app`, `app_api`, the reviewed `public` API facade, and their application ACLs/data. It separately recreates the `supabase_migrations` ledger. It preserves native roles, role memberships, `auth`, `storage`, `realtime`, `extensions`, `vault`, `graphql`, `graphql_public`, `public` ownership/defaults, extensions, publications, managed ACLs, and managed ownership. It does not use `session_replication_role`.

Before an authorized overlay, the source copy is quarantined in its disposable private environment. Only sanitized `auth.users` and `auth.identities` rows are emitted with explicit column lists; generated columns remain target-generated. Target-native Auth definitions, instances, and Auth migration history are preserved. Sessions, refresh tokens, one-time tokens, flow state, MFA, OAuth, SAML/SSO, WebAuthn, and Auth audit ephemera are omitted and asserted empty. Source and target Auth column order, types, nullability, generated expressions, and reviewed trigger shape must match exactly.

Application replacement runs in one `SERIALIZABLE` transaction. It first proves existing `app` and `app_api` schemas are owned by the executing application owner and that no external foreign key, view, trigger, or policy depends on the replaceable plane. It then drops only the reviewed application schemas and exact manifest-listed `public` routines, restores application definitions, purges copied Auth relational/ephemeral rows, inserts quarantined users then identities, restores application data and the migration ledger, restores post-data objects/ACLs, and verifies Auth, session/token, migration, and application invariants before commit. A failure rolls back the complete overlay. Existing DEV preservation is applied only afterward through its separate exact manifest.

After post-data restore and before verification or commit, the overlay applies source-ACL convergence. The package authenticates a source contract keyed by schema, object class, object name, PostgreSQL routine identity arguments, owner, grantee, privilege, grantor, and grant option. It preserves every source grant, fails on missing or value-mismatched source privileges, and revokes only reviewed target-only application grants produced while native target defaults created the restored objects. Unknown roles, signatures, objects, owners, privileges, or grant options fail the transaction. Target `pg_default_acl`, managed schema ACLs, managed ownership, and role memberships remain target-native and are fingerprinted separately.

New or restored application functions must finish with an explicit reviewed ACL contract. They must not rely accidentally on native default `EXECUTE` privileges. In particular, `SECURITY DEFINER` routines are compared by stable signature and direct recipients; an unexpected grant to `PUBLIC`, `anon`, `authenticated`, `authenticator`, `service_role`, or any unreviewed role fails closed. This is exact source convergence, not a rule that these roles may never receive an explicitly declared source grant.

Post-restore managed-exception verification uses the certified effective-access identity, not an assumption that the effective privilege appears as a direct raw grant to the login role. The only current certificate is `TARGET_NATIVE_AUTHENTICATOR_PUBLIC_SCHEMA_USAGE`, bound to its exact effective and catalog digests and zero added `CREATE`, relation, sequence, or application-function capability. The verifier requires exactly one exception with every certified field unchanged; a different grantee, schema privilege, digest, capability, or additional exception fails closed. It never implements a general schema-ACL ignore.

The managed-like rehearsal creates non-superuser `postgres`, managed owner roles, native schema ownership, extension placement, and the native Realtime publication. It must reproduce the old ownership rejection and atomic rollback, then prove the overlay on both a blank managed target and a populated managed target. Application/Auth parity, migration history, target-native managed-plane equality, quarantine, and private-artifact teardown are mandatory.

Generic PostgreSQL cannot reproduce Supabase Auth HTTP services, managed secrets/platform metadata, every managed extension, managed side-effect runtime, nonselected managed schemas, or server-role login attributes. Those are declared platform differences, not parity exceptions between derived targets. Database restoration, Auth relationship quarantine, credential replacement, session/token purge, side-effect no-call state, and domain contracts must pass locally; Auth HTTP, Edge, Storage, and browser behavior remain required on the real SANDBOX.

## Private Restore Diagnostics

Normal restore output remains categorical and sanitized. A restore subprocess may write bounded raw stdout/stderr only to an exclusively created, owner-protected private temporary artifact. Credentials, database URLs, managed hosts, bearer/token shapes, identifiers, and private paths are removed before any diagnostic leaves the private callback. Useful PostgreSQL error class, SQLSTATE category, object context, and overlay stage remain. The raw bytes are zeroed in memory where practical and the temporary artifact is removed on success and failure; raw diagnostics are never committed or retained as report evidence.

## Official Supabase Method Alignment

The overlay follows Supabase's supported logical-migration shape by separating application schema, data, roles/ACL decisions, and migration history; filtering managed schemas; and suppressing source ownership. It intentionally preserves target-native managed roles and skips source references that would replace Supabase ownership or CLI roles. Unlike a generic Supabase migration, this application must retain Auth UUID relationships, so it adds a narrowly reviewed relational transplant into native Auth tables after source-side X-NP quarantine. It intentionally does not use `session_replication_role=replica`: managed targets do not grant that setting to the execution role, and exact ordering plus normal constraints prove the required relationships instead.

Relevant provider guidance:

- `https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore`
- `https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres`
- `https://supabase.com/docs/reference/cli/supabase-auth`
- `https://supabase.com/docs/guides/platform/clone-project`

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

## Exact SANDBOX Fixture Recovery

`env:sandbox:fixture-recovery` is the only environment-sync path allowed to suspend the
last-owner trigger while destroying an exact organization-root fixture. It is SANDBOX-only
and never accepts names, prefixes, dates, discovered rows, DEV, or PROD as cleanup authority.

The command has two stages. `prepare` authenticates the private fixture manifest, failure
record, recovery freeze, lineage record, and ID journal, then uses a rolled-back
`REPEATABLE READ READ ONLY` snapshot to bind exact per-table counts, strict nonfixture
projections, Auth categories, side-effect state, application/schema/ACL/RLS fingerprints,
managed-plane fingerprints, `pg_default_acl`, migration state, and the source-matched
`trg_prevent_last_owner_loss` definition into an exclusively created owner-protected plan.
The plan copies no cleanup identity that was not already present in the authenticated
manifest.

The private ID journal may contain bounded, structurally validated IDs harvested from later
workflow responses, including camel-case and snake_case API/SQL field names. Those values
are corroborating evidence only: they contribute no cleanup target and are never promoted
into the plan. Auth-context organization entries must still
match the manifest's exact organization roots. The manifest remains the sole deletion
authority.

`cleanup` requires the authenticated plan, an explicit SANDBOX project ref, `--apply`, and
`--quiet-window-active`. It publishes a permanent exclusive one-shot attempt marker before
database work. Inside exactly one `SERIALIZABLE` transaction it rechecks the complete plan,
temporarily disables only `trg_prevent_last_owner_loss` on `app.organization_members`,
deletes only the manifest's exact organization roots, proves exact cascade counts and strict
nonfixture equality, re-enables and re-verifies the trigger, proves every surviving
organization has an active owner, and compares all protected fingerprints before commit.
The product function and trigger definition are never changed. A rollback restores the
trigger transactionally; a commit ambiguity remains frozen and is never retried
automatically.

After a known database commit, the command deletes only the manifest's one exact temporary
Auth identity through the target-native Auth Admin API and performs a rolled-back strict
after-state check. The permanent smoke identity and copied quarantined identities are
categorically verified and never supplied as deletion targets. Private plan, attempt, and
result artifacts are fsynced and owner-protected. Normal output is categorical and
count-only.

Example shape (private paths and values intentionally omitted):

```text
npm --prefix backend run env:sandbox:fixture-recovery -- --action prepare --expected-project-ref <sandbox-ref> --expected-application-commit <commit> --authority-dir <private-dir> --authority-key <private-key> --project-artifact <private-project-artifact> --database-password-artifact <private-password-artifact>

npm --prefix backend run env:sandbox:fixture-recovery -- --action cleanup --apply --quiet-window-active --expected-project-ref <sandbox-ref> --expected-application-commit <commit> --authority-dir <private-dir> --authority-key <private-key> --project-artifact <private-project-artifact> --database-password-artifact <private-password-artifact>
```

An existing attempt or result freezes ordinary invocation. Do not remove it, broaden the
manifest, retry, or substitute ad hoc SQL.

If an authenticated ordinary attempt failed specifically because Film Order delete triggers
created history during organization cascade, the separately approved
`recover-film-order-history` action may be used once. It requires the original signed plan,
the permanent failed ordinary marker/result, an exact confirmed constraint category, and a
new exclusive override marker. In one serializable transaction it deletes exact-root links,
then exact-root orders, then the original plus exactly one generated event per deleted link
and order, before deleting the same manifest roots. Every count is bound to the plan; the
manifest remains the sole authority, and ordinary cleanup remains permanently frozen.

For B, run the complete PostgreSQL preflight first, pin source and restore fingerprint sessions to UTC, and require the native source-to-restore compatibility result before X-NP. The same encrypted component must feed both D and E. The rehearsal's shared structural smoke identity exists only to keep lineage fingerprints comparable; each real project must receive its own credential and Auth identity through its own Auth Admin API.

## One-Retry SANDBOX Procedure

This procedure is a design, not authorization. One explicit Sage/Rob approval is required for one attempt.

1. Guard the declared SANDBOX project and reject PROD, DEV, loopback, linked, or mismatched credentials.
2. Prove SANDBOX remains quarantined, healthy, empty of application/Auth user state, and free of prior restore artifacts.
3. Capture a fresh native managed-catalog fingerprint in `REPEATABLE READ READ ONLY`, prove the non-superuser executor and exact native owners/privileges, then roll back.
4. Authenticate X ciphertext, wrapped key, manifest, component size/digest, source commit, migration tip, and retained certification without persistent plaintext.
5. Generate and authenticate the complete managed-restore compatibility manifest; require zero uncertain entries and exact target-proof bindings.
6. Preserve the target-native roles, ownership, managed schemas, extensions, publication, Auth definitions/control rows, project keys, and platform plumbing.
7. Restore only the manifest-selected portable application plane inside one `SERIALIZABLE` transaction.
8. Quarantine the disposable source first, then transplant only explicit sanitized Auth user/identity columns into the native Auth shape.
9. Prove zero copied sessions, refresh tokens, one-time tokens, flow state, MFA, OAuth, SAML/SSO, WebAuthn, Auth audit ephemera, and usable copied credentials.
10. Prove cron, hooks, foreign access, network callers, routable identities, and outbound side effects remain absent or disabled.
11. Prove application schema/data/grants, migration history, Auth relationships, managed-catalog preservation, and declared X-NP parity.
12. On any SQL or verification failure, rely on the single transaction rollback, stop the attempt, and do not broaden, retry, or repair.
13. Classify failure from the owner-protected transient diagnostic, retain only sanitized categories/counts, and remove raw material.
14. Complete strict X-NP and protected-state verification before any service exposure.
15. Only after every database gate passes may separately approved target-native smoke-user creation, Edge deployment, browser workflows, and exact cleanup begin.

## Golden Workflow Contract

Both targets execute the tracked 20-step contract returned by `buildGoldenWorkflowContract`: native sign-in; org context; permissions; warehouse; inventory search; job create; allocation/removal; Requirement+Extra same-box; auto-allocation; Film Order lifecycle; immutable receipts; box receipt; transfer lifecycle; checkout/check-in; caulk lifecycle; labels; staged pickup; team/multi-org; job deletion; and authorization isolation. It requires guarded fixtures, exact private-manifest cleanup, and strict nonfixture after-state equality.

## Canonical Edge And Grant Decisions

The future nonproduction Edge candidate is the repository graph rooted at current main after its three post-v279 runtime changes are certified against the already-applied 0199-0202 contracts. Record the exact commit/tree, module graph, dependencies, and lock digest again at execution; do not choose it merely because it is newer.

PROD's dormant direct `app` SELECT grants are migration-era legacy drift. X must record and preserve their exact presence rather than silently normalize security during cloning. They are not canonical nonproduction authorization. A separate, reviewed PROD migration should revoke them and retain strict ACL assertions; sync tooling must not perform that remediation.

## Architecture Alignment Handoff

After refresh acceptance, use `buildArchitectureAlignmentTemplate`. Review inventory domains, physical film capacity, reservations, requirements/EXTRA, Film Orders/receipts, transfers, checkout/check-in, staged pickup, caulk, organizations/Auth, dependency graphs, workflow coverage, debt, and missing ADRs/tests/docs. Only then begin pooled-film reservation and staged physical-box assignment work in SANDBOX.
