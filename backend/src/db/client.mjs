// Purpose: Shared database client lifecycle and query helpers.
import { HttpError } from '../lib/http.mjs';
import { pool, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/runtime.mjs';

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

export async function withReadClient(callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function withMutation(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
