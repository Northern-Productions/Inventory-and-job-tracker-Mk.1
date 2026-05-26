import { queryRow } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import { asTrimmedString, normalizeWarehouseCodeFormat } from '../core/helpers.mjs';

function normalizeDefaultWarehouseInput(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (!normalized || normalized === 'ALL' || normalized === 'ALL_WAREHOUSES' || normalized === 'ALL WAREHOUSES') {
    return '';
  }

  return normalizeWarehouseCodeFormat(normalized, 'Warehouse');
}

async function getUserDefaultWarehouse(client, orgId, userId) {
  const row = await queryRow(
    client,
    `
      select coalesce(p.default_warehouse, '') as default_warehouse
      from app.user_preferences p
      join app.warehouses w
        on w.org_id = p.org_id
       and w.code = p.default_warehouse
      where p.org_id = $1
        and p.user_id = $2::uuid
        and p.default_warehouse <> ''
    `,
    [orgId, userId]
  );

  return asTrimmedString(row?.default_warehouse).toUpperCase();
}

async function updateUserDefaultWarehouse(client, orgId, authContext, payload) {
  const userId = asTrimmedString(authContext?.userId);
  if (!userId) {
    throw new HttpError(401, 'Authenticated session is required.');
  }

  const accessStatus = asTrimmedString(authContext?.accessStatus).toLowerCase();
  if (accessStatus !== 'approved') {
    throw new HttpError(403, 'Your account is awaiting approval from an admin or owner.');
  }

  const input =
    payload && typeof payload === 'object'
      ? payload.defaultWarehouse ?? payload.warehouse
      : '';
  const defaultWarehouse = normalizeDefaultWarehouseInput(input);

  if (defaultWarehouse) {
    const exists = await queryRow(
      client,
      `
        select code
        from app.warehouses
        where org_id = $1
          and code = $2
      `,
      [orgId, defaultWarehouse]
    );
    if (!exists) {
      throw new HttpError(400, 'Warehouse is not configured.');
    }
  }

  await client.query(
    `
      insert into app.user_preferences (
        org_id,
        user_id,
        default_warehouse,
        updated_at,
        updated_by
      )
      values ($1::uuid, $2::uuid, $3, now(), $4)
      on conflict (org_id, user_id) do update
      set
        default_warehouse = excluded.default_warehouse,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    [orgId, userId, defaultWarehouse, asTrimmedString(authContext?.actor)]
  );

  return {
    defaultWarehouse,
  };
}

export {
  getUserDefaultWarehouse,
  normalizeDefaultWarehouseInput,
  updateUserDefaultWarehouse,
};
