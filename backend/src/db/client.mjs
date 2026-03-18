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
        app.allocations,
        app.film_orders,
        app.film_order_box_links,
        app.jobs,
        app.job_requirements,
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
