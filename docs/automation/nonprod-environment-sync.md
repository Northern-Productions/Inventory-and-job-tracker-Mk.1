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

Managed nonproduction replacement must use the target-native overlay, not a broad `pg_restore --clean` of the source archive. The broad method attempts to clean target-native Auth objects and fails when the managed `postgres` role is not their owner. The overlay authenticates the encrypted archive, classifies every TOC item, proves the target catalog in a rolled-back read-only transaction, and binds an authenticated target-native managed-profile certificate, Auth shape, application-replacement, archive, and restore-plan digests before mutation. Unknown objects fail closed.

A managed-profile certificate is target-bound and authenticates the exact normalized managed plane: managed and platform schema owners/ACLs, every default-ACL entry, role security attributes and memberships, effective `public` schema capabilities, Auth ownership, managed object ownership/ACLs, extensions, and publications. Its reviewed security policy separately binds the expected `public` owner, exact application-facing `USAGE` and login sets, the sole intended application-facing bypass-RLS paths, and the complete privileged-role set. A different target, owner, ACL, grant option, default ACL, role attribute, membership, managed object, schema, extension, publication, or effective application-facing privilege rejects the profile. Profile support is descriptor-driven; project refs are certificate bindings, not restore-engine compatibility branches. Application-scoped defaults are also frozen in their own authenticated preservation manifest because they are destroyed with their namespace and govern future objects; this separate contract does not replace managed-profile authentication.

The compatibility manifest assigns every TOC entry exactly one action: `restore`, `transform`, `skip-as-managed`, `recreate-target-locally`, or `preserve-target-native`, with a nonblank reason. It restores only `app`, `app_api`, the reviewed `public` API facade, and their application ACLs/data. It separately recreates the `supabase_migrations` ledger. It preserves native roles, role memberships, `auth`, `storage`, `realtime`, `extensions`, `vault`, `graphql`, `graphql_public`, `public` ownership/defaults, extensions, publications, managed ACLs, and managed ownership. The `public` schema is a protected container: the overlay never drops it, creates it, changes its owner, or normalizes one target's ACL/defaults to another target. Only exact manifest-listed application routines inside `public` are replaced. It does not use `session_replication_role`. Source `DEFAULT ACL` archive entries remain excluded: application defaults come only from the authenticated target preservation manifest, never from Golden X.

Before an authorized overlay, the source copy is quarantined in its disposable private environment. Only sanitized `auth.users` and `auth.identities` rows are emitted with explicit column lists; generated columns remain target-generated. Target-native Auth definitions, instances, and Auth migration history are preserved. Sessions, refresh tokens, one-time tokens, flow state, MFA, OAuth, SAML/SSO, WebAuthn, and Auth audit ephemera are omitted and asserted empty. Source and target Auth column order, types, nullability, generated expressions, and reviewed trigger shape must match exactly.

Application replacement runs in one `SERIALIZABLE` transaction. It first proves existing `app` and `app_api` schemas are owned by the executing application owner and that no external foreign key, view, trigger, or policy depends on the replaceable plane. It then drops only the reviewed application schemas and exact manifest-listed `public` routines. The archive restore list is split so only the two schema containers are recreated first. The overlay then reapplies the authenticated application-default-ACL plan with supported `ALTER DEFAULT PRIVILEGES` statements under the exact owner/grantor, proves semantic equality, and only then restores definitions that can inherit those defaults. It next purges copied Auth relational/ephemeral rows, inserts quarantined users then identities, restores application data and the migration ledger, restores post-data objects/ACLs, and verifies Auth, session/token, migration, application, and final default-ACL invariants before commit. A failure rolls back the complete overlay. Existing DEV preservation is applied only afterward through its separate exact manifest.

After post-data restore and before verification or commit, the overlay applies source-object ACL convergence. The package authenticates a source contract keyed by schema, object class, object name, PostgreSQL routine identity arguments, owner, grantee, privilege, grantor, and grant option. It grants only an exact reviewed source privilege missing because the target's hardened defaults did not create it, revokes only an exact reviewed target-only privilege produced by target defaults, and rejects any value mismatch. Unknown roles, signatures, objects, owners, privileges, or grant options fail the transaction. The final effective object contract must equal the frozen source contract exactly. Object convergence is deliberately separate from the application-default-ACL preservation manifest: current-object equality cannot prove future-object inheritance. Final verification requires both contracts.

New or restored application functions must finish with an explicit reviewed ACL contract. They must not rely accidentally on native default `EXECUTE` privileges. In particular, `SECURITY DEFINER` routines are compared by stable signature and direct recipients; an unexpected grant to `PUBLIC`, `anon`, `authenticated`, `authenticator`, `service_role`, or any unreviewed role fails closed. This is exact source convergence, not a rule that these roles may never receive an explicitly declared source grant.

Post-restore managed-exception verification uses the certified effective-access identity, not an assumption that the effective privilege appears as a direct raw grant to the login role. `TARGET_NATIVE_AUTHENTICATOR_PUBLIC_SCHEMA_USAGE` remains the exact SANDBOX application-ACL convergence exception, bound to its effective and catalog digests and zero added `CREATE`, relation, sequence, or application-function capability. It is not transferred to DEV. Each target instead carries its own authenticated managed-profile certificate; a different grantee, schema privilege, digest, capability, or additional exception fails closed. Neither mechanism implements a general schema-ACL ignore.

The managed-like rehearsal creates non-superuser `postgres`, managed owner roles, native schema ownership, extension placement, and the native Realtime publication. It issues independent in-memory authenticated certificates for a current SANDBOX-style profile and a historical DEV-style profile, plus independently target/profile-bound application-default-ACL manifests. It reproduces the namespace-drop loss, proves the corrected overlay on both a blank managed target and a populated target, and performs a second destructive DEV-style overlay as a recovery rehearsal. Both profiles must derive the same application/Auth baseline while retaining distinct `public` owners, managed defaults, schema ACLs, memberships, profile identities, and target bindings. The forward rehearsal applies 0203, 0204, and 0205 in exact order and treats only their reviewed catalog effects as permitted deltas. Recovery is proven for both the historical pre-0204 profile and the current hardened 0205 profile. A current-state Y2 uses a separate authenticated exact-Auth recovery authority covering the fixed reviewed Auth table inventory; it does not weaken Golden X quarantine. The recovery package restores active target-native smoke Auth, application state, migration ledger, managed profile, application/default ACLs, and future-object behavior exactly. After each corrected overlay, disposable future table, sequence, and function probes must inherit exactly the predicted privileges, and the 0205 rollback-only probe must prove weight-authoritative check-in and calibration self-heal with zero residue.

## Application Default ACL Preservation

The selected strategy is authenticated capture plus reapplication before object creation. Preserving the application schema container was rejected because exact removal of every unmanifested object and dependency inside a retained namespace would require a second destructive object-discovery engine and could leave stale application state. Dropping the reviewed schemas remains deterministic; the preservation manifest makes the namespace-bound defaults deterministic too.

`APPLICATION_DEFAULT_ACL_PRESERVATION` stores normalized owner/grantor, schema, object class, grantee, privilege, grant option, categorical source evidence, target/profile binding, before/expected-after digests, and the exact grouped plan. It authenticates semantic identities rather than OIDs, ACL array order, or row count. Missing, additional, unknown, differently owned, differently scoped, differently granted, or grant-option-changed entries fail before package generation. The generated SQL never writes `pg_default_acl` directly.

The current repository application contract maps future `app` tables and sequences granted to `service_role` to migration 0103. A current managed target may additionally carry the reviewed complete authenticated table/sequence set as managed-platform target state; the DEV and SANDBOX manifests therefore remain distinct. A partial managed set, any other grantee or privilege, or any unknown application default fails closed. Future public-function security is checked independently because global and per-schema PostgreSQL default privileges have different semantics. Migration 0102's schema-scoped revoke cannot remove PostgreSQL's built-in global `PUBLIC EXECUTE`; 0204 supplies the required global revoke and removes only additive application-schema platform grants. A readiness run must therefore require 0204's exact global owner-only profile and prove actual future functions deny `PUBLIC`, `anon`, `authenticated`, and `service_role` while preserving owner execution. Current routine ACLs, table defaults, and sequence defaults remain separate contracts and may not be normalized as a side effect. Tooling must not synthesize a missing shared-environment security policy merely to make readiness pass.

A future DEV cutover must freeze the source-object ACL convergence contract, the target application-default-ACL preservation certificate, and the pre-cutover routine-default profile before destruction. It must verify application defaults immediately after schema recreation and again after object convergence, apply 0203, 0204, and 0205 in order, authenticate the resulting routine-default profile, and run the approved semantic future-object and check-in assertions. A Y2 recovery must restore the pre-cutover routine-default profile before recreating application objects; restoring it afterward is unsafe because newly created routines have already inherited the wrong ACL. Recovery then restores the exact application/Auth/migration planes and proves the full managed fingerprint plus future-object behavior equal the frozen pre-cutover evidence.

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

## Certified DEV Cutover And Y2 Recovery

Golden X is intentionally frozen at 185 migrations through 0202. It is not recaptured from current PROD. A successful DEV refresh derives the application plane from Golden X, applies X-NP, preserves the exact target-native DEV managed/default-ACL profile, and then applies exact migration bytes for 0203, 0204, and 0205 to finish at 188 migrations through `20260824100000`.

Immediately before the first destructive DEV boundary, the authorized run captures a fresh encrypted/authenticated Y2 from current DEV. Y2 is attempt-bound and restore-tested before the permanent attempt marker and destructive-boundary marker are published. It includes the exact application and migration planes, target-native Auth needed for recovery, permanent smoke Owner state, managed/default ACL evidence, selected organization/default warehouse evidence, side-effect posture, and runtime provenance. The older recovery Y remains historical evidence and is not substituted for Y2.

Retained managed-profile certificates that predate 0204 are historical inputs, not current-state substitutes. Their routine-default delta is migration-defined: 0204 adds the explicit global owner-only function default and removes the reviewed schema-scoped automatic function grants. The cutover must capture and authenticate the current hardened target profile in Y2; an unrecognized managed/default-ACL difference still fails closed.

The permanent DEV and SANDBOX smoke identities are target-native test infrastructure. Each remains an active Owner only in its intended nonproduction certification organization. Golden-copied identities remain quarantined and never inherit that Owner capability.

The canonical commands are:

```text
npm --prefix backend run env:prepare-dev-refresh-certified -- --env <guarded-dev-env> --authority-key <private-key> --retained-root <retained-golden-root> --output-dir <new-private-preparation-dir> --side-effect-certificate <private-read-only-certificate> --edge-certificate <private-read-only-certificate> --postgres-bin <postgres-18-bin>

npm --prefix backend run env:refresh-dev-certified -- --apply --quiet-window-active --env <guarded-dev-env> --authority-key <private-key> --contract <signed-contract> --operation-inventory <signed-operation-inventory> --state-dir <new-private-state-dir> --evidence-dir <new-private-evidence-dir>

npm --prefix backend run env:recover-dev-certified -- --apply --quiet-window-active --recovery-authorized --env <guarded-dev-env> --authority-key <private-key> --contract <same-signed-contract> --operation-inventory <same-signed-operation-inventory> --state-dir <existing-private-state-dir> --evidence-dir <new-private-recovery-evidence-dir>
```

## Failed-Recovery Remediation

A certified refresh recovery that reaches `RECOVERY_FAILED` remains permanently closed. Its journal,
marker, invocation evidence, and `retryAllowed=false` value are immutable and cannot be reset merely
because the target later appears equal to Y2. When separately approved, the repository can prepare a
new recovery-remediation lineage whose purpose is to deliberately restore the original Y2 and establish
a new known outcome without reinterpreting or completing the failed recovery.

Preparation is read-only against DEV business and schema state, with one explicit permanent-smoke
password login/logout canary as the sole bounded Auth-runtime exception. It binds the exact failed attempt, original Y2, failed recovery
marker and invocation, current tooling commit/tree, canonical application commit, and a fresh observed
DEV certificate. It requires current DEV to equal original Y2 across every recoverable plane and does
not capture the remediation fallback. The future destructive command captures a fresh coherent,
encrypted, authenticated, component-digested R3 immediately before its own one-shot marker and
destructive boundary. R3 must restore-test through the canonical recovery primitive and equal both
current DEV and original Y2 before mutation is permitted.

Recovery remediation preserves target-native managed Auth. It regenerates both the deliberate
original-Y2 application restore and the R3 fallback as `preserve-target-native-auth` packages. Those
packages emit no Auth delete, insert, or update, do not touch `auth.instances` or
`auth.schema_migrations`, and prove every reviewed Auth table remains byte-identical inside the
application restore transaction. The retained historical exact-Y2 package remains immutable evidence
and is never executed by the successor remediation. This scope rule is remediation-specific and does
not silently change the Golden-X refresh design.

The signed remediation preparation carries a semantic Auth certificate. Copied/quarantined users and
identities protect all recovery-significant fields, including credential digests and quarantine state;
the native smoke identity separately protects stable user/identity metadata, active Owner membership,
organization, and default warehouse. Only monotonic native login timestamps and at most one
smoke-owned session/refresh-token pair from a failed logout are permitted. The exception never applies
to copied users. Preparation, precheck, post-Y2 verification, and post-R3 verification use exact user,
organization, role, warehouse, and read-only API assertions. Credential-bearing requests use exact
origins and fail on redirects.

The remediation executes the real database quiet-window census at precheck and immediately before the
boundary. It also rechecks public Edge health, exact management version/status/JWT metadata, the
private deployed-body size and SHA-256 identity, and the signed zero cron/network/webhook/
foreign-resource posture. The CLI quiet-window switch records authorization intent only. Credential
environment files must be exact owner-protected artifacts before any read; reparse-point environment
files require a separately protected transient materialization.

The disposable remediation profile mirrors the observed managed DEV permissions: all reviewed Auth
tables are selectable, users/identities and the other runtime tables are writable, and
`auth.schema_migrations` is read-only. A blanket Auth grant remains available only as an explicitly
nonrepresentative high-privilege refresh-test profile. The current Golden-X cutover still generates
Auth DML that includes `auth.schema_migrations`; live DEV does not grant that DML. A future full refresh
must correct and recertify that separate path before another cutover. This capability mismatch is a
plausible failure mechanism, not proof of the historical cutover's cause.

The canonical commands are:

```text
npm --prefix backend run env:prepare-dev-recovery-remediation-certified -- --env <guarded-dev-env> --authority-key <private-key> --original-contract <failed-refresh-contract> --original-preparation <failed-refresh-preparation> --failed-state-dir <failed-refresh-state-dir> --expected-original-attempt <failed-refresh-attempt-id> --expected-original-y2 <original-y2-id> --output-dir <new-private-preparation-dir> --side-effect-certificate <private-read-only-certificate> --edge-certificate <private-read-only-certificate> --postgres-bin <postgres-18-bin>

npm --prefix backend run env:remediate-dev-recovery-certified -- --apply --quiet-window-active --remediation-authorized --env <guarded-dev-env> --authority-key <private-key> --preparation <signed-remediation-preparation> --contract <signed-remediation-contract> --operation-inventory <signed-remediation-inventory> --state-dir <new-private-remediation-state-dir> --evidence-dir <new-private-remediation-evidence-dir>

npm --prefix backend run env:recover-dev-recovery-remediation-certified -- --apply --quiet-window-active --remediation-recovery-authorized --env <guarded-dev-env> --authority-key <private-key> --preparation <same-signed-remediation-preparation> --contract <same-signed-remediation-contract> --operation-inventory <same-signed-remediation-inventory> --state-dir <existing-private-remediation-state-dir> --evidence-dir <new-private-remediation-recovery-evidence-dir>
```

The remediation uses an independent append-only authenticated journal and permanent marker. Its real
stages are `REMEDIATION_PRECHECK`, `CURRENT_Y2_PARITY`, `R3_CAPTURE`, `R3_VALIDATED`,
`RESTORE_ORIGINAL_Y2`, `AUTH_RUNTIME_VERIFIED`, `APPLICATION_RUNTIME_VERIFIED`, and
`FINAL_Y2_PARITY`; R3 recovery uses `REMEDIATION_RECOVERY_DATABASE` and
`REMEDIATION_RECOVERY_VERIFIED`. Synthetic workers are rejected. A pre-boundary failure is terminal.
A post-boundary failure becomes `REMEDIATION_RECOVERY_REQUIRED` and cannot resume or retry the
remediation; only the separately authorized one-shot R3 recovery command may run.

Restore execution retains authenticated categorical evidence for restore start, database/session
identity, transaction start, mutation application, commit/rollback/ambiguity, post-commit state,
cleanup, and result publication. Failure-cause v2 adds an explicit transaction outcome while readers
remain compatible with retained v1 failure evidence. Successful remediation preserves the old
`RECOVERY_FAILED` record and concludes only the new remediation lineage.

The signed operation inventory pins every stage's absolute executable and script bytes, arguments, bounded timeout, working directory, and permitted environment variable names. The orchestrator executes the complete stage chain itself; operators do not manually stitch stage commands. Child output is suppressed. A child can return only categorical/count evidence through an inherited owner-protected file descriptor, after which the orchestrator validates and signs accepted evidence.

Preparation enumerates exactly `PRECHECK`, `QUIET_WINDOW`, `Y2_CAPTURE`, `Y2_VALIDATED`, `SIDE_EFFECTS_QUARANTINED`, `DATABASE_CUTOVER`, `DATABASE_VERIFIED`, `AUTH_RUNTIME`, `EDGE_RUNTIME`, `WORKFLOW_CERTIFICATION`, `FIXTURE_CLEANUP`, `FINAL_PARITY`, `RECOVERY_DATABASE`, `RECOVERY_AUTH_RUNTIME`, and `RECOVERY_VERIFIED`. Every entry resolves to the production stage worker and its exact digest. `dev-certified-test-worker.mjs` is test-only; preparation, inventory verification, refresh, and recovery all reject its path or digest even when an inventory is otherwise correctly authenticated.

`SIDE_EFFECTS_QUARANTINED` is a historical stage name for a verify-only guard. It proves the already-safe DEV posture before destruction and has no configuration mutation capability. Unsafe mail, SMS, URL, vendor-secret, cron, network, webhook, foreign-resource, Storage/Vault, or signup posture blocks the attempt before Y2/destruction and is corrected only in a separately approved ordinary configuration task. `EDGE_RUNTIME` is likewise read-only: source graph, dependency lock, deployed metadata, API contract, and runtime compatibility must already match. Incompatibility blocks before destruction; refresh never deploys Edge and recovery only proves that Edge remained unchanged.

The permanent target-native DEV smoke identity remains active Owner in its existing certification organization. Normal fixtures use that organization. A temporary organization or user is permitted only for the inherent team/multi-organization and tenant-isolation workflows. Golden-copied users remain frozen and can never gain Owner through import. Managed Auth infrastructure and platform provider configuration are preserved, not recreated. Y2 restores relational Auth/application state; active sessions and access/refresh tokens may be intentionally invalidated, and the permanent smoke identity must support fresh authentication afterward.

The repository-owned Playwright runner executes all 20 workflows through the local frontend and application API against the guarded target, with loopback-only browser traffic in disposable certification. It does not depend on Codex Desktop browser state. Each generated stable ID is fsynced into an attempt/target/workflow-bound append-only HMAC ledger before dependent work continues. API-created deltas are appended as one authenticated batch; direct bootstrap IDs are recorded before its database commit. Cleanup accepts only exact ledger IDs and exact authenticated restoration records, never prefixes, timestamps, names, or discovery-added targets.

A browser child failure is distinct from an orchestrator failure. While the orchestrator remains alive it may perform exact ledger cleanup, prove zero residue/parity, and make one clean browser-stage retry without repeating database cutover. Cleanup or parity uncertainty escalates to `RECOVERY_REQUIRED`. Any disappearance or restart of the main orchestrator after the destructive boundary remains `RECOVERY_REQUIRED`; the destructive run is never resumed and only the separately authorized one-shot Y2 recovery command is permitted.

The durable state machine is append-only and HMAC authenticated. Frozen manifests, the attempt marker, destructive-boundary marker, and recovery marker are exclusive owner-protected artifacts. Once the destructive boundary exists, any interruption or stage failure yields `RECOVERY_REQUIRED`. A new process may run only the certified Y2 recovery command; destructive refresh never resumes where it stopped. Recovery is one-shot and exact. No force retry, marker deletion, discovery-added cleanup target, PROD/SANDBOX target, linked project, or unpinned operation is accepted.

The DEV workflow fixture authority is distinct from the SANDBOX-only cleanup wrapper. Its frozen stage operation must be target-bound, exact-manifest and exact-ID based, one-shot, and must prove zero fixture residue plus strict nonfixture equality. Existing SANDBOX recovery behavior remains SANDBOX-only and unchanged.

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
temporarily disables only `trg_prevent_last_owner_loss` on `app.organization_members`, and
deletes only manifest-owned rows. A signed budget containing both Film Order links and Film
Orders selects exact-root, count-checked link/order/event deletion before organization-root
deletion so history triggers cannot violate the organization cascade; a one-sided budget
fails closed. A nonzero signed `box_transfers` budget selects exact-root, count-checked
transfer-history deletion. That path verifies the migration-defined immutable-history guard,
temporarily disables only `trg_0191_guard_box_transfers`, deletes the exact manifest-root
budget, forces deferred constraints immediate, and restores and re-verifies the guard before
organization-root deletion. Film Order and transfer-history ordering compose when both
budgets are nonzero. The transaction then proves exact counts and strict nonfixture equality,
re-enables and re-verifies the trigger, proves every surviving
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

If an authenticated ordinary attempt instead failed with `P0001` and a separate rolled-back
diagnosis positively attributed the failure to `guard_box_transfer_mutation`, the separately
approved `recover-transfer-history` action may be used once with
`--confirmed-failure-routine guard_box_transfer_mutation`. It requires the same exact signed
plan and failed ordinary evidence, verifies the committed trigger source read-only, and uses
the combined trigger-safe history mode selected solely from signed table budgets. It never
accepts transfer IDs, discovered roots, or a widened cleanup target. Its exclusive override
marker remains permanent regardless of outcome.

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

Both targets execute the tracked 20-step contract returned by `buildGoldenWorkflowContract`: native sign-in; org context; permissions; warehouse; inventory search; job create; allocation/removal; Requirement+Extra same-box; auto-allocation; Film Order lifecycle; immutable receipts; box receipt; transfer lifecycle; checkout/check-in; caulk lifecycle; labels; staged pickup; team/multi-org; job deletion; and authorization isolation. Checkout/check-in must prove the 0205 contract: returned weight is authoritative, stale feet cannot override it, deterministic calibration may self-heal, and ordered receive persists sufficient calibration. It requires guarded fixtures, exact private-manifest cleanup, and strict nonfixture after-state equality.

## Canonical Edge And Grant Decisions

The certified nonproduction runtime source is rooted at canonical main commit `955104b0df3ceadcdf80d89115edd4cac7afe90c` and tree `12c9af7884c43f9527b4d54d0b05900d24541229`, with database lineage through 0205. Record the exact commit/tree, module graph, dependencies, lock digest, and current target deployment identity again at execution; do not infer equality from a version number or recency.

PROD's dormant direct `app` SELECT grants are migration-era legacy drift. X must record and preserve their exact presence rather than silently normalize security during cloning. They are not canonical nonproduction authorization. A separate, reviewed PROD migration should revoke them and retain strict ACL assertions; sync tooling must not perform that remediation.

## Architecture Alignment Handoff

After refresh acceptance, use `buildArchitectureAlignmentTemplate`. Review inventory domains, physical film capacity, reservations, requirements/EXTRA, Film Orders/receipts, transfers, checkout/check-in, staged pickup, caulk, organizations/Auth, dependency graphs, workflow coverage, debt, and missing ADRs/tests/docs. Only then begin pooled-film reservation and staged physical-box assignment work in SANDBOX.
