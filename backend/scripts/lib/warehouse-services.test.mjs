import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpError } from '../../src/lib/http.mjs';
import { addWarehouse, listWarehouses } from '../../src/app/services/warehouses.mjs';

class FakeWarehouseClient {
  constructor() {
    this.listRows = [];
    this.addResult = null;
    this.error = null;
    this.queryLog = [];
  }

  normalizeSql(text) {
    return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async query(text, params = []) {
    this.queryLog.push(this.normalizeSql(text));

    if (this.error) {
      throw this.error;
    }

    const sql = this.normalizeSql(text);

    if (sql.includes("set_config('request.jwt.claim.sub'")) {
      return { rows: [{ ok: true }] };
    }

    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
      return { rows: [] };
    }

    if (sql.includes('from public.api_acl_list_warehouses($1::uuid)')) {
      assert.equal(params[0], 'org-1');
      return { rows: this.listRows };
    }

    if (sql.includes('public.api_acl_add_warehouse($1::uuid, $2::text, $3::jsonb) as warehouse')) {
      assert.equal(params[0], 'org-1');
      assert.equal(params[1], 'Owner User');
      return {
        rows: [{ warehouse: this.addResult }],
      };
    }

    throw new Error(`Unhandled SQL in fake warehouse client: ${sql}`);
  }
}

test('listWarehouses normalizes DB-backed warehouse rows for the local adapter and can project auth context for ACL reads', async () => {
  const client = new FakeWarehouseClient();
  client.listRows = [
    { code: 'il1', name: 'Wauconda IL1', box_id_prefix: 'il1' },
    { code: 'mo1', name: 'St. Louis MO1', box_id_prefix: 'mo1' },
  ];

  const entries = await listWarehouses(client, 'org-1', {
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'owner@example.com',
  });

  assert.deepEqual(entries, [
    { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
    { code: 'MO1', name: 'St. Louis MO1', boxIdPrefix: 'MO1' },
  ]);
  assert.ok(client.queryLog.includes('begin'));
  assert.ok(client.queryLog.some((sql) => sql.includes("set_config('request.jwt.claim.sub'")));
  assert.ok(client.queryLog.includes('commit'));
});

test('addWarehouse normalizes the RPC response payload for the local adapter', async () => {
  const client = new FakeWarehouseClient();
  client.addResult = {
    code: 'mo1',
    name: 'St. Louis MO1',
    boxIdPrefix: 'mo1',
  };

  const entry = await addWarehouse(client, 'org-1', 'Owner User', {
    code: 'MO1',
    name: 'St. Louis MO1',
    boxIdPrefix: 'MO1',
  });

  assert.deepEqual(entry, {
    code: 'MO1',
    name: 'St. Louis MO1',
    boxIdPrefix: 'MO1',
  });
});

test('addWarehouse translates database HTTP errors into local HttpError responses', async () => {
  const client = new FakeWarehouseClient();
  const databaseError = new Error('Warehouse MO1 already exists.');
  databaseError.detail = 'status=400';
  client.error = databaseError;

  await assert.rejects(
    () =>
      addWarehouse(client, 'org-1', 'Owner User', {
        code: 'MO1',
        name: 'St. Louis MO1',
        boxIdPrefix: 'MO1',
      }),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, 'Warehouse MO1 already exists.');
      return true;
    }
  );
});
