import { queryRow, queryRows } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import { asTrimmedString } from '../core/helpers.mjs';
import { applyAuthenticatedSessionContext } from './access.mjs';

function mapWarehouseEntry(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value;
  const code = asTrimmedString(source.code).toUpperCase();
  if (!code) {
    return null;
  }

  return {
    code,
    name: asTrimmedString(source.name) || code,
    boxIdPrefix: asTrimmedString(source.boxIdPrefix || source.box_id_prefix).toUpperCase(),
  };
}

function parseRaisedHttpStatus(error) {
  const detail = asTrimmedString(error?.detail);
  const match = detail.match(/(?:^|[\s,;])status=(\d{3})(?:$|[\s,;])/i);
  if (!match) {
    return 0;
  }

  return Number.parseInt(match[1], 10) || 0;
}

function rethrowWarehouseRpcError(error) {
  if (error instanceof HttpError) {
    throw error;
  }

  const statusCode = parseRaisedHttpStatus(error);
  if (statusCode >= 400 && statusCode <= 599) {
    throw new HttpError(statusCode, asTrimmedString(error?.message) || 'Warehouse request failed.');
  }

  throw error;
}

function normalizeWarehousePayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    code: asTrimmedString(source.code),
    name: asTrimmedString(source.name),
    boxIdPrefix: asTrimmedString(source.boxIdPrefix),
  };
}

async function listWarehouses(client, orgId, authContext = null) {
  const usesAuthenticatedTransaction = Boolean(authContext);
  try {
    if (usesAuthenticatedTransaction) {
      await client.query('BEGIN');
      await applyAuthenticatedSessionContext(client, authContext);
    }

    const rows = await queryRows(
      client,
      `
        select
          code,
          name,
          box_id_prefix
        from public.api_acl_list_warehouses($1::uuid)
      `,
      [orgId]
    );

    if (usesAuthenticatedTransaction) {
      await client.query('COMMIT');
    }

    return rows.map(mapWarehouseEntry).filter(Boolean);
  } catch (error) {
    if (usesAuthenticatedTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        // Ignore rollback failures and surface the original error.
      }
    }
    rethrowWarehouseRpcError(error);
  }
}

async function addWarehouse(client, orgId, actor, payload) {
  try {
    const row = await queryRow(
      client,
      `
        select
          public.api_acl_add_warehouse($1::uuid, $2::text, $3::jsonb) as warehouse
      `,
      [orgId, asTrimmedString(actor), normalizeWarehousePayload(payload)]
    );

    const entry = mapWarehouseEntry(row?.warehouse);
    if (!entry) {
      throw new HttpError(500, 'Warehouse mutation completed but returned no payload.');
    }

    return entry;
  } catch (error) {
    rethrowWarehouseRpcError(error);
  }
}

export {
  addWarehouse,
  listWarehouses,
};
