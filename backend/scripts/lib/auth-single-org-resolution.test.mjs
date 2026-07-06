import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildSafeAccessContext,
  resolvePilotOrgAccess,
} from '../../../shared/domain/authOrgResolution.mjs';

const DEFAULT_ORG = '11111111-1111-4111-8111-111111111111';
const CLIENT_ORG = '22222222-2222-4222-8222-222222222222';
const THIRD_ORG = '33333333-3333-4333-8333-333333333333';

test('auth org resolver prefers configured default only when user is a member', () => {
  const decision = resolvePilotOrgAccess({
    defaultOrgId: DEFAULT_ORG,
    memberships: [
      { org_id: CLIENT_ORG, role: 'member', created_at: '2026-01-02T00:00:00.000Z' },
      { org_id: DEFAULT_ORG, role: 'owner', created_at: '2026-01-01T00:00:00.000Z' },
    ],
  });

  assert.equal(decision.kind, 'approved');
  assert.equal(decision.orgId, DEFAULT_ORG);
  assert.equal(decision.reason, 'default-org-approved-membership');
});

test('auth org resolver uses a single approved non-default membership when default is configured', () => {
  const decision = resolvePilotOrgAccess({
    defaultOrgId: DEFAULT_ORG,
    memberships: [{ org_id: CLIENT_ORG, role: 'member' }],
  });

  assert.equal(decision.kind, 'approved');
  assert.equal(decision.orgId, CLIENT_ORG);
  assert.equal(decision.reason, 'single-approved-membership');
});

test('auth org resolver uses a single approved membership when no default is configured', () => {
  const decision = resolvePilotOrgAccess({
    memberships: [{ org_id: CLIENT_ORG, role: 'admin' }],
  });

  assert.equal(decision.kind, 'approved');
  assert.equal(decision.orgId, CLIENT_ORG);
});

test('auth org resolver fails closed for multiple approved memberships', () => {
  const decision = resolvePilotOrgAccess({
    defaultOrgId: DEFAULT_ORG,
    memberships: [
      { org_id: CLIENT_ORG, role: 'member' },
      { org_id: THIRD_ORG, role: 'member' },
    ],
  });

  assert.equal(decision.kind, 'org_selection_required');
  assert.equal(decision.orgId, '');
  assert.deepEqual(decision.candidateOrgIds, [CLIENT_ORG, THIRD_ORG]);
});

test('auth org resolver preserves known pending and denied access states without guessing default org', () => {
  const pendingDecision = resolvePilotOrgAccess({
    defaultOrgId: DEFAULT_ORG,
    memberships: [],
    accessRequests: [{ org_id: CLIENT_ORG, status: 'pending' }],
  });
  assert.equal(pendingDecision.kind, 'pending');
  assert.equal(pendingDecision.orgId, CLIENT_ORG);

  const deniedDecision = resolvePilotOrgAccess({
    defaultOrgId: DEFAULT_ORG,
    memberships: [],
    accessRequests: [{ org_id: CLIENT_ORG, status: 'denied' }],
  });
  assert.equal(deniedDecision.kind, 'denied');
  assert.equal(deniedDecision.orgId, CLIENT_ORG);
});

test('auth org resolver returns no_access instead of creating a default-org request with no org signal', () => {
  const decision = resolvePilotOrgAccess({
    defaultOrgId: DEFAULT_ORG,
    memberships: [],
    accessRequests: [],
  });

  assert.equal(decision.kind, 'no_access');
  assert.equal(decision.orgId, '');
});

test('safe unresolved auth context carries denied permissions and no tenant org for data routes', () => {
  const context = buildSafeAccessContext({
    identity: {
      userId: 'user-1',
      email: 'user@example.com',
      name: 'User Example',
      token: 'token',
    },
    actor: 'User Example <user@example.com>',
    decision: {
      kind: 'org_selection_required',
      orgId: '',
      reason: 'multiple-approved-memberships',
    },
  });

  assert.equal(context.accessStatus, 'org_selection_required');
  assert.equal(context.orgId, '');
  assert.equal(context.permissions.inventory.read, false);
  assert.equal(context.permissions.jobs.write, false);
});

test('local backend resolver reads memberships and access requests before choosing an org', async () => {
  const source = await readFile(new URL('../../src/app/services/accessAuth.mjs', import.meta.url), 'utf8');

  assert.match(source, /from app\.organization_members/);
  assert.match(source, /from app\.access_requests/);
  assert.match(source, /resolvePilotOrgAccess\(\{/);
  assert.doesNotMatch(source, /DEFAULT_ORG_ID is not assigned to the authenticated user/);
});
