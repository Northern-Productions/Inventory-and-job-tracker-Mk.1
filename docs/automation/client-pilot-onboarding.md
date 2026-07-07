# Client Pilot Onboarding Runbook

This runbook defines the safe path for onboarding an outside client pilot into the production Window Film Inventory app. It is an operational guide only. It does not approve any production mutation by itself.

## Pilot Model

- One production database is used.
- Each company gets a separate organization.
- Client pilot data starts directly in production under the client's own organization.
- DEV remains development and testing only.
- There is no demo database to production merge path.
- Pilot users should belong to only one active approved organization wherever possible.
- If Rob needs support access to the client organization, use a separate support account tied only to that client organization until an organization switcher exists.
- Users with multiple active approved organizations fail closed until organization selection is built.
- Every production onboarding mutation requires explicit Rob/Sage approval before execution.

## Preconditions

Complete this checklist before scheduling a production onboarding window:

- RLS tenant hardening is released.
- Direct authenticated write grant hardening is released.
- Offline/PWA tenant cache isolation is released.
- Auth single-org pilot resolution is released.
- Two-org isolation coverage is released.
- Production migration history is clean and aligned.
- Supabase Edge/API health is OK.
- Vercel production is deployed at the expected main commit.
- The production bundle/config points to PROD, not DEV or localhost.
- There are no active emergency bugs or tenant isolation blockers.
- Client pilot terms, data handling expectations, and support expectations are agreed outside the app.
- Rob approves the exact production onboarding window.
- Rob/Sage approve the exact production mutation plan for the client organization.

Use the read-only helper before an approved production onboarding window:

```powershell
npm --prefix backend run client-pilot:readiness -- --target prod --env backend/.env.prod --allow-prod-read --expected-main <expected_main_sha>
```

The helper validates the selected env file target and prints the approval gates. It does not create organizations, users, warehouses, owner companies, inventory, jobs, or any other production data.

## Current Capability Map

### Available In The App UI Today

- User sign-up/sign-in and access status splash.
- Admin Access page for pending/approved/denied access requests.
- Approve or deny access requests for the resolved organization.
- Change member/admin feature permissions.
- Promote member to admin, demote admin to member, and promote admin to owner from owner-controlled admin access tooling.
- Username change request review.
- Owner Companies page for creating active owner companies and deactivating them.
- Bulk Ownership Transfer page for explicitly listed film boxes and caulk stock rows.
- Default warehouse selection per approved user.
- Warehouse-backed inventory, box details, jobs, film orders, allocations, labels, reports, and activity history under the resolved organization.

### Available In API/RPC Or Existing Operational Scripts

- Owner-only warehouse creation through `/owner/warehouses/add` and `public.api_acl_add_warehouse`.
- Owner-company create/deactivate and ownership transfer through owner-only routes and RPCs.
- Starting inventory can be added through normal UI flows, or through existing import scripts after explicit approval.
- Existing import tooling includes dry-run and apply modes for legacy film inventory and caulk inventory. Apply modes are production mutations and require separate approval.
- Audit/history routes and audit tables record operational mutations through the app/RPC surfaces.
- Read-only production release and environment guards exist through release doctor, env target checks, schema/latest, Vercel status verification, and health checks.

### Requires An Approved Admin/SQL/RPC Procedure Today

- Creating the client organization row in `app.organizations`.
- Creating the first owner membership for that organization if the owner cannot self-request into a newly created org.
- Creating or inviting Supabase Auth users outside normal self-sign-up.
- Assigning the first owner role before organization-local UI administration is possible.
- Exporting a client-only dataset if needed at offboarding.
- Archiving or deleting client data if ever required by contract.

### Unsafe Or Missing For The Pilot

- There is no full organization switcher. Do not give one human account multiple active approved organizations for the pilot unless the expected result is fail-closed access.
- There is no self-service production organization creation UI.
- There is no approved automated production onboarding script in this branch.
- There is no approved production data deletion tool in this branch.
- Starting inventory import apply modes are not safe to run without a separate reviewed and approved plan.

## Client Data Model To Collect

Collect this information before creating anything in production:

- Legal/company display name for the organization.
- Short internal organization label.
- Warehouse names, warehouse codes, and box ID prefixes.
- Owner companies to create for inventory ownership.
- Pilot users, email addresses, requested display names, intended roles, and feature permissions.
- Default warehouse for each user.
- Support account email, if Rob support access is required.
- Starting inventory source files, ownership assumptions, warehouse mapping, and import/add approach.
- Starting jobs or film orders, only if the pilot explicitly needs seeded work.
- Offboarding/export obligations in the client agreement.

Keep warehouse and ownership separate:

- Warehouse means physical location.
- Owner company means who owns the box or caulk stock.
- Do not use warehouse as a substitute for owner company.
- Do not use owner company as a substitute for warehouse.

## Production Mutation Approval Gates

Every item below needs explicit Rob/Sage approval before execution:

- Create production client organization.
- Create or invite production users.
- Approve access requests.
- Assign owner/admin/member roles.
- Change feature permissions.
- Create warehouses.
- Create owner companies.
- Import or add starting inventory.
- Create starting jobs or film orders.
- Create a Rob/client support account.
- Disable, deny, or remove user access.
- Export client data.
- Archive, delete, or purge client data.
- Any production SQL, RPC, script apply mode, or Supabase Auth admin operation.

Approval should name the production target, organization, actor, exact command or UI workflow, expected affected records, rollback/stop plan, and verification checklist.

## Onboarding Sequence

### 1. Read-Only Production Preflight

1. Confirm the production onboarding window is approved.
2. Confirm the target is PROD and the project ref is `tiwpulgvxtwlmqdnyuzd`.
3. Run the client-pilot readiness helper in read-only mode.
4. Run release doctor or equivalent production status checks.
5. Confirm production migration history is aligned.
6. Confirm Edge/API `/health` is OK.
7. Confirm Vercel production is at the expected main commit.
8. Confirm production bundle/config points to PROD.
9. Confirm no emergency bugs are active.
10. Record preflight evidence.

### 2. Create Organization

1. Stop unless Rob/Sage have approved the exact organization creation mutation.
2. Create the client organization in production using the approved admin path.
3. Record the new organization ID.
4. Verify the organization row exists.
5. Verify no other organization rows were changed.

### 3. Establish First Owner

1. Prefer a client owner user with a single active approved organization.
2. If the client owner self-signs up and creates an access request, approve that request into the client organization.
3. If a direct first-owner setup is required, use only the approved admin/RPC/SQL path.
4. Assign the owner role only after approval.
5. Verify the owner can log in and resolves to the client organization.
6. Verify the owner cannot see Rob's organization data.

### 4. Add Users And Roles

1. Have each user sign up with their own account.
2. Approve users into only the client organization.
3. Assign roles:
   - Owner: full workspace and owner tools.
   - Admin: admin console if access management is enabled.
   - Member: feature-limited regular user.
4. Set feature permissions deliberately.
5. Avoid multi-org memberships.
6. Verify pending/denied users cannot load company data.

### 5. Configure Warehouses

1. Stop unless warehouse creation is approved.
2. Create each warehouse with the approved code, name, and box ID prefix.
3. Verify warehouse list under the client organization.
4. Verify warehouse filters show only client warehouses for client users.
5. Verify Rob's organization warehouses are not visible to client users.

### 6. Configure Owner Companies

1. Stop unless owner-company creation is approved.
2. Use the Owner Companies page when possible.
3. Create active owner companies for the client.
4. Verify owner company dropdowns and inventory ownership views are scoped.
5. Deactivate owner companies only with approval.

### 7. Set User Default Warehouses

1. Each approved user sets their default warehouse from Change Warehouse.
2. Confirm default warehouse persists for the user and organization.
3. Confirm no user receives a default warehouse from another organization.

### 8. Add Or Import Starting Inventory

1. Stop unless starting inventory add/import is approved.
2. Prefer small manual entry through the UI for the first pilot unless a reviewed import plan is approved.
3. If using import scripts, run dry-run first and review all generated artifacts.
4. Apply import only after a separate approval naming source file, organization ID, warehouse mapping, actor, and expected counts.
5. Verify before/after counts.
6. Verify owner company assignment where applicable.
7. Verify audit/history entries.

### 9. Optional Starting Jobs And Film Orders

1. Create starting jobs only if approved.
2. Keep job creation under the client organization.
3. Verify job details, related requirements, film orders, allocations, and reports are client-scoped.
4. Do not seed demo jobs into production unless explicitly approved as client pilot data.

### 10. Tenant Isolation Verification

Run these checks after onboarding:

1. Client user logs in and sees only the client organization.
2. Rob/internal user logs in and sees only Rob's organization.
3. Support account, if used, sees only the client organization.
4. A multi-org test/support account fails closed with organization selection required.
5. Inventory list, box details, jobs, film orders, labels, reports, owner companies, warehouses, search/autocomplete, and audit/history are all scoped.
6. Direct URLs for another organization's box/job/film order do not expose data.
7. Logout/login clears or isolates offline inventory cache.
8. Browser Cache Storage has no unsafe authenticated API runtime cache behavior.
9. React Query cache does not show stale prior-org data after auth changes.
10. Record verification evidence.

### 11. Freeze And Start Pilot

1. Confirm client users can perform the approved first-day workflows.
2. Confirm support path and escalation contacts.
3. Confirm no unauthorized Rob/internal access exists.
4. Record final onboarding evidence.
5. Announce pilot start.

## First-Day QA Checklist

Read-only checks:

- Client login succeeds.
- Client user lands in approved access state.
- Inventory list loads and shows only client data.
- Box Details loads for a client box.
- Jobs page loads and shows only client jobs.
- Film Orders loads and shows only client orders.
- Reports load and are client-scoped.
- Owner company and warehouse filters show only client options.
- Search/autocomplete does not show another organization.
- Activity/history/audit views are client-scoped.
- Direct URL to another organization's record fails safely.
- Logout and login do not reveal stale offline inventory.

Mutation checks, only if approved for pilot QA:

- Add one clearly marked pilot box.
- Edit that pilot box.
- Mark label printed for that pilot box.
- Create one pilot job.
- Create one pilot film order.
- Allocate only pilot/client inventory to a pilot job.
- Remove the pilot allocation.
- Check out/check in only approved pilot fixture material.

Do not run mutation QA on real business data unless the client and Rob/Sage explicitly approve the exact records and rollback/cleanup plan.

## Support And Access Rules

- No shared user accounts.
- Rob support uses a separate support account tied only to the client organization until org switching exists.
- Avoid active approved multi-org memberships.
- Do not approve Rob's normal production account into the client organization for the pilot unless fail-closed behavior is the intended test.
- Admin actions must be auditable.
- No client access to DEV.
- Do not send screenshots or exports containing one organization's data to another organization.
- Do not use direct database access for routine support when an app UI/RPC path exists.

## Release Operations During The Pilot

- DEV remains the Codex testing environment.
- Communicate release windows to Rob and the client.
- Use higher caution for production migrations during pilot hours.
- Prefer read-only production verification unless a safe fixture path is explicitly approved.
- Take an export/backup checkpoint before major approved production changes when practical.
- Avoid risky features during client business hours.
- Do not change Supabase auth settings during a pilot without a separate release plan.

## Offboarding

If the client does not buy:

1. Stop and get explicit approval for the offboarding path.
2. Disable or deny client users.
3. Revoke support account access.
4. Export data only if promised and approved.
5. Preserve/archive data according to the client agreement.
6. Do not delete business records without explicit written approval.
7. Record offboarding evidence.

## Conversion To Customer

If the client buys:

1. Keep the same organization and data.
2. No merge is needed.
3. Convert the pilot organization operationally to a customer organization.
4. Review long-term owner/admin/support model.
5. Review backup/export expectations.
6. Review future org-switcher requirements if support needs multi-client access.

## Emergency Or Incident Response

If there is a suspected data leak, incorrect access, or unsafe mutation:

1. Stop all nonessential onboarding/pilot operations.
2. Preserve evidence.
3. Do not delete records or logs.
4. Disable or deny affected user access only if Rob/Sage approve, unless immediate access freeze is required to stop a leak.
5. Capture user IDs, organization IDs, route, time window, and screenshots without secrets.
6. Escalate to Sage/Codex review.
7. Verify RLS, Edge auth context, direct links, reports, dropdowns, search, audit/history, offline cache, and localStorage/PWA state.
8. Prepare a narrowly scoped fix branch if code changes are needed.

## Evidence To Record

For every onboarding action, record:

- Date/time.
- Actor.
- Environment and project ref.
- Organization ID.
- Command or UI path used.
- Approval reference.
- Expected affected records.
- Actual affected records.
- Verification result.
- Any skipped checks and why.

Never record secrets, tokens, auth headers, DB URLs, or full env files in the evidence.
