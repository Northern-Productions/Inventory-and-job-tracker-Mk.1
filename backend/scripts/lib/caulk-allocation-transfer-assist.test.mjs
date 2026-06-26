import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpError } from '../../src/lib/http.mjs';
import { addCaulkAllocation } from '../../src/app/services/caulkAllocations.mjs';

class FakeCaulkClient {
  constructor() {
    this.jobId = '33333333-3333-4333-8333-333333333333';
    this.ownerCompanyId = '44444444-4444-4444-8444-444444444444';
    this.warehouses = new Set(['IL1', 'MS1']);
    this.jobs = new Map([
      ['4761', { id: this.jobId, job_number: '4761', lifecycle_status: 'ACTIVE' }],
    ]);
    this.products = new Map([
      ['11111111-1111-4111-8111-111111111111', { id: '11111111-1111-4111-8111-111111111111' }],
    ]);
    this.requirements = new Map([
      [
        '22222222-2222-4222-8222-222222222222',
        {
          id: '22222222-2222-4222-8222-222222222222',
          job_id: this.jobId,
        },
      ],
    ]);
    this.stock = new Map([
      [this.stockKey('11111111-1111-4111-8111-111111111111', 'IL1'), 74],
      [this.stockKey('11111111-1111-4111-8111-111111111111', 'MS1'), 0],
    ]);
    this.allocations = [];
    this.transfers = [];
    this.deltaLog = [];
    this.plannerScopes = [];
    this.logIdCounter = 0;
    this.transferIdCounter = 0;
  }

  stockKey(productId, warehouse) {
    return `${productId}:${warehouse}`;
  }

  normalizeSql(text) {
    return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  getStock(productId, warehouse) {
    return this.stock.get(this.stockKey(productId, warehouse)) ?? 0;
  }

  async query(text, params = []) {
    const sql = this.normalizeSql(text);

    if (sql.includes('select app_api.require_effective_feature_access')) {
      return { rows: [{ ok: true }] };
    }

    if (sql.includes('select (app_api.require_active_job_for_caulk($1::uuid, $2::text)).*')) {
      const job = this.jobs.get(String(params[1]).trim());
      if (!job) {
        throw new HttpError(404, `Job ${params[1]} was not found.`);
      }
      if (job.lifecycle_status !== 'ACTIVE') {
        throw new HttpError(400, `Job ${job.job_number} is closed and cannot receive caulk allocations.`);
      }
      return { rows: [job] };
    }

    if (sql.includes('select * from app.jobs j where j.org_id = $1::uuid and j.id = $2::uuid for update')) {
      const job = Array.from(this.jobs.values()).find((entry) => entry.id === params[1]) || null;
      return { rows: job ? [job] : [] };
    }

    if (sql.includes('select * from app.caulk_products p where p.org_id = $1::uuid and p.id = $2::uuid')) {
      const product = this.products.get(params[1]) || null;
      return { rows: product ? [product] : [] };
    }

    if (sql.includes('select * from app.job_caulk_requirements r where r.org_id = $1::uuid and r.id = $2::uuid and r.job_id = $3::uuid for update')) {
      const requirement = this.requirements.get(params[1]) || null;
      return { rows: requirement && requirement.job_id === params[2] ? [requirement] : [] };
    }

    if (sql.includes('select app_api.create_log_id() as id')) {
      this.logIdCounter += 1;
      return { rows: [{ id: `CAULK-${this.logIdCounter}` }] };
    }

    if (sql.includes('select app_api.caulk_require_warehouse($1::uuid, $2::text) as warehouse')) {
      const warehouse = String(params[1] ?? '').trim().toUpperCase();
      if (!this.warehouses.has(warehouse)) {
        throw new HttpError(400, `Warehouse ${warehouse} was not found for this organization.`);
      }
      return { rows: [{ warehouse }] };
    }

    if (sql.includes('select * from app.owner_companies where org_id = $1::uuid and id = $2::uuid limit 1')) {
      return {
        rows: params[1] === this.ownerCompanyId
          ? [
              {
                id: this.ownerCompanyId,
                code: 'MGT',
                display_name: 'MGT',
                is_active: true,
              },
            ]
          : [],
      };
    }

    if (sql.includes('select owner_company_id from app.caulk_stock where org_id = $1::uuid and product_id = $2::uuid and warehouse = $3::text order by updated_at desc, id desc')) {
      return {
        rows: this.stock.has(this.stockKey(params[1], params[2]))
          ? [{ owner_company_id: this.ownerCompanyId }]
          : [],
      };
    }

    if (sql.includes('insert into app.caulk_stock (')) {
      const [, productId, warehouse] = params;
      const key = this.stockKey(productId, warehouse);
      if (!this.stock.has(key)) {
        this.stock.set(key, 0);
      }
      return { rows: [] };
    }

    if (sql.includes('select * from app.caulk_stock s where s.org_id = $1::uuid and s.product_id = $2::uuid and s.warehouse = $3::text and s.owner_company_id = $4::uuid for update')) {
      const [, productId, warehouse] = params;
      return {
        rows: [
          {
            org_id: params[0],
            product_id: productId,
            warehouse,
            owner_company_id: params[3],
            tubes_on_hand: this.getStock(productId, warehouse),
          },
        ],
      };
    }

    if (sql.includes('select app_api.caulk_create_transaction_id() as transfer_id')) {
      this.transferIdCounter += 1;
      return { rows: [{ transfer_id: `TX-${this.transferIdCounter}` }] };
    }

    if (sql.includes('select app_api.caulk_apply_stock_delta_for_owner(')) {
      const [, actor, productId, warehouse, ownerCompanyId, action, deltaTubes, reason, transferId, sourceBoxId, notes] = params;
      const before = this.getStock(productId, warehouse);
      const after = before + Number(deltaTubes);
      if (after < 0) {
        throw new HttpError(400, `Insufficient stock. Requested delta would move tubes below zero (${after}).`);
      }
      this.stock.set(this.stockKey(productId, warehouse), after);
      this.deltaLog.push({
        actor,
        productId,
        warehouse,
        ownerCompanyId,
        action,
        deltaTubes: Number(deltaTubes),
        reason,
        transferId,
        sourceBoxId,
        notes,
      });
      return { rows: [{ result: { resultingTubesOnHand: after } }] };
    }

    if (sql.includes('insert into app.caulk_job_allocations (')) {
      const [orgId, allocationId, jobId, jobNumber, requirementId, productId, ownerCompanyId, warehouse, allocatedTubes, reservedTubesRemaining, actor, allocationRowId, notes] =
        params;
      this.allocations.push({
        id: allocationRowId,
        org_id: orgId,
        caulk_allocation_id: allocationId,
        job_id: jobId,
        job_number: jobNumber,
        requirement_id: requirementId || null,
        product_id: productId,
        owner_company_id: ownerCompanyId,
        warehouse,
        allocated_tubes: allocatedTubes,
        reserved_tubes_remaining: reservedTubesRemaining,
        checked_out_tubes_total: 0,
        notes,
        created_by: actor,
        updated_by: actor,
      });
      return { rows: [] };
    }

    if (sql.includes('insert into app.caulk_transfers (')) {
      const [
        orgId,
        transferId,
        caulkAllocationId,
        jobId,
        jobNumber,
        productId,
        ownerCompanyId,
        sourceWarehouse,
        destinationWarehouse,
        pendingTubes,
        status,
        notes,
        createdAt,
        createdBy,
        receivedAt,
        receivedBy,
        cancelledAt,
        cancelledBy,
        updatedAt,
        updatedBy,
      ] = params;
      const nextTransfer = {
        org_id: orgId,
        transfer_id: transferId,
        caulk_allocation_id: caulkAllocationId,
        job_id: jobId || null,
        job_number: jobNumber,
        product_id: productId,
        owner_company_id: ownerCompanyId,
        source_warehouse: sourceWarehouse,
        destination_warehouse: destinationWarehouse,
        pending_tubes: pendingTubes,
        status,
        notes,
        created_at: createdAt,
        created_by: createdBy,
        received_at: receivedAt || '',
        received_by: receivedBy || '',
        cancelled_at: cancelledAt || '',
        cancelled_by: cancelledBy || '',
        updated_at: updatedAt,
        updated_by: updatedBy,
      };
      this.transfers.push(nextTransfer);
      return { rows: [nextTransfer] };
    }

    if (sql.includes('select app_api.reconcile_auto_planned_allocations($1::uuid, $2::text, $3::jsonb) as result')) {
      this.plannerScopes.push(JSON.parse(params[2]));
      return {
        rows: [
          {
            result: {
              filmInserted: 0,
              filmUpdated: 0,
              filmCancelled: 0,
              caulkInserted: 0,
              caulkUpdated: 0,
              caulkCancelled: 0,
              warnings: [],
              warningCount: 0,
            },
          },
        ],
      };
    }

    if (
      sql.includes('update app.jobs j') &&
      sql.includes('from app.job_caulk_requirements r') &&
      sql.includes("coalesce(p.workflow_status, 'active') = 'active'")
    ) {
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in fake caulk client: ${sql}`);
  }
}

test('addCaulkAllocation canonical path uses jobId without hidden planner allocation', async () => {
  const client = new FakeCaulkClient();
  const result = await addCaulkAllocation(client, 'org-1', 'tester', {
    jobId: client.jobId,
    jobNumber: '4761',
    requirementId: '22222222-2222-4222-8222-222222222222',
    productId: '11111111-1111-4111-8111-111111111111',
    warehouse: 'IL1',
    allocatedTubes: 2,
    notes: 'Canonical add.',
  });

  assert.equal(result.result.jobId, client.jobId);
  assert.equal(result.result.jobNumber, '4761');
  assert.equal(client.allocations.length, 1);
  assert.equal(client.allocations[0].job_id, client.jobId);
  assert.equal(client.allocations[0].job_number, '4761');
  assert.deepEqual(client.plannerScopes, []);
});

test('addCaulkAllocation rejects canonical jobId and jobNumber mismatch', async () => {
  const client = new FakeCaulkClient();

  await assert.rejects(
    () =>
      addCaulkAllocation(client, 'org-1', 'tester', {
        jobId: client.jobId,
        jobNumber: '9999',
        productId: '11111111-1111-4111-8111-111111111111',
        warehouse: 'IL1',
        allocatedTubes: 2,
      }),
    (error) => {
      assert(error instanceof HttpError);
      assert.equal(error.message, 'Job identity mismatch: selected job does not match jobNumber.');
      return true;
    }
  );
  assert.equal(client.allocations.length, 0);
  assert.deepEqual(client.plannerScopes, []);
});

test('addCaulkAllocation starts a pending transfer for the shortage and leaves destination stock unchanged', async () => {
  const client = new FakeCaulkClient();
  const result = await addCaulkAllocation(client, 'org-1', 'tester', {
    jobNumber: '4761',
    requirementId: '22222222-2222-4222-8222-222222222222',
    productId: '11111111-1111-4111-8111-111111111111',
    warehouse: 'MS1',
    allocatedTubes: 3,
    notes: 'Send from IL1.',
    transferFromWarehouse: 'IL1',
  });

  assert.deepEqual(result.warnings, [
    'Started transfer of 3 tubes from IL1 to MS1. Receive it before checkout or staging.',
  ]);
  assert.equal(client.getStock('11111111-1111-4111-8111-111111111111', 'IL1'), 71);
  assert.equal(client.getStock('11111111-1111-4111-8111-111111111111', 'MS1'), 0);
  assert.equal(client.allocations.length, 1);
  assert.equal(client.transfers.length, 1);
  assert.equal(client.allocations[0].warehouse, 'MS1');
  assert.equal(client.allocations[0].allocated_tubes, 3);
  assert.equal(client.allocations[0].reserved_tubes_remaining, 0);
  assert.equal(client.transfers[0].source_warehouse, 'IL1');
  assert.equal(client.transfers[0].destination_warehouse, 'MS1');
  assert.equal(client.transfers[0].pending_tubes, 3);
  assert.equal(client.transfers[0].status, 'PENDING');
  assert.deepEqual(
    client.deltaLog.map((entry) => entry.action),
    ['TRANSFER_OUT']
  );
});

test('addCaulkAllocation keeps the shortage blocked when no source warehouse is selected', async () => {
  const client = new FakeCaulkClient();

  await assert.rejects(
    () =>
      addCaulkAllocation(client, 'org-1', 'tester', {
        jobNumber: '4761',
        productId: '11111111-1111-4111-8111-111111111111',
        warehouse: 'MS1',
        allocatedTubes: 3,
      }),
    (error) => {
      assert(error instanceof HttpError);
      assert.equal(
        error.message,
        'MS1 still needs 3 tubes transferred in before this allocation can be saved. Select a source warehouse first.'
      );
      return true;
    }
  );
});
