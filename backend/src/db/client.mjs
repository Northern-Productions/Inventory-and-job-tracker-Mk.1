// Purpose: Shared database client lifecycle and query helpers.
import { HttpError } from '../lib/http.mjs';
import { pool, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/runtime.mjs';

const CONCURRENCY_CONFLICT_SQLSTATE = new Set(['40001', '40P01', '55P03']);

export function ensureConfigured() {
  if (!pool) {
    throw new HttpError(500, 'DATABASE_URL (or SUPABASE_DB_URL) is not configured.');
  }

  if (!SUPABASE_URL) {
    throw new HttpError(500, 'SUPABASE_URL is not configured.');
  }

  if (!SUPABASE_ANON_KEY) {
    throw new HttpError(500, 'SUPABASE_ANON_KEY is not configured.');
  }
}

function assertCallback(callback, caller) {
  if (typeof callback !== 'function') {
    throw new HttpError(500, `${caller} callback must be a function.`);
  }
}

function isConcurrencyConflictError(error) {
  const sqlState = error && typeof error === 'object' ? error.code : '';
  return typeof sqlState === 'string' && CONCURRENCY_CONFLICT_SQLSTATE.has(sqlState);
}

export async function withReadClient(callback) {
  ensureConfigured();
  assertCallback(callback, 'withReadClient');
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function runParallelReadTasks(taskFactories) {
  ensureConfigured();
  const tasks = Array.isArray(taskFactories) ? taskFactories : [];
  for (let index = 0; index < tasks.length; index += 1) {
    assertCallback(tasks[index], 'runParallelReadTasks');
  }

  const clients = await Promise.all(tasks.map(() => pool.connect()));
  try {
    return await Promise.all(tasks.map((taskFactory, index) => taskFactory(clients[index])));
  } finally {
    for (let index = 0; index < clients.length; index += 1) {
      clients[index].release();
    }
  }
}

export async function withMutation(callback) {
  ensureConfigured();
  assertCallback(callback, 'withMutation');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    await client.query('SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await client.query(`
      lock table
        app.boxes,
        app.box_id_aliases,
        app.box_transfers,
        app.allocations,
        app.film_orders,
        app.film_order_box_links,
        app.jobs,
        app.job_requirements,
        app.caulk_manufacturers,
        app.caulk_products,
        app.caulk_stock,
        app.caulk_transactions,
        app.caulk_transfers,
        app.job_caulk_requirements,
        app.caulk_job_allocations,
        app.caulk_job_checkouts,
        app.audit_log,
        app.roll_weight_log,
        app.film_catalog
      in share row exclusive mode
    `);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {
      // Ignore rollback failures and surface the original error.
    }
    if (isConcurrencyConflictError(error)) {
      throw new HttpError(409, 'Concurrent update conflict. Retry the request.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function queryRows(client, text, params = []) {
  const result = await client.query(text, params);
  return result.rows;
}

export async function queryRow(client, text, params = []) {
  const rows = await queryRows(client, text, params);
  return rows[0] || null;
}
