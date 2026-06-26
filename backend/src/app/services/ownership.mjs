import crypto from 'node:crypto';

import { queryRow, queryRows } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import { asTrimmedString, requireString, requireUuid } from '../core/helpers.mjs';
import { findBoxById } from '../repositories/inventoryRepositories.mjs';
import { saveBoxRecord } from '../repositories/boxesRepository.mjs';
import { appendAuditEntry } from '../repositories/auditRepository.mjs';
import { applyReservationMetricsToBox } from './runtime/runtimeAllocationReservations.mjs';
import { listAllocationsByBox, toPublicBox } from '../repositories/inventoryRepositories.mjs';

function mapOwnerCompanyRow(row) {
  if (!row) {
    return null;
  }

  const code = asTrimmedString(row.code).toUpperCase();
  return {
    ownerCompanyId: asTrimmedString(row.owner_company_id || row.id),
    code,
    displayName: asTrimmedString(row.display_name) || code,
    lookupKey: asTrimmedString(row.lookup_key).toLowerCase(),
    isActive: row.is_active === true,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
    createdBy: asTrimmedString(row.created_by),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : '',
    updatedBy: asTrimmedString(row.updated_by),
    deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at).toISOString() : '',
    deactivatedBy: asTrimmedString(row.deactivated_by),
  };
}

function mapOwnershipEventRow(row) {
  if (!row) {
    return null;
  }

  return {
    eventId: asTrimmedString(row.event_id || row.id),
    resourceType: asTrimmedString(row.resource_type),
    resourceId: asTrimmedString(row.resource_id),
    resourceLabel: asTrimmedString(row.resource_label),
    oldOwnerCompanyId: asTrimmedString(row.old_owner_company_id),
    oldOwnerCode: asTrimmedString(row.old_owner_code).toUpperCase(),
    oldOwnerDisplayName: asTrimmedString(row.old_owner_display_name),
    newOwnerCompanyId: asTrimmedString(row.new_owner_company_id),
    newOwnerCode: asTrimmedString(row.new_owner_code).toUpperCase(),
    newOwnerDisplayName: asTrimmedString(row.new_owner_display_name),
    actor: asTrimmedString(row.actor),
    note: asTrimmedString(row.note),
    batchId: asTrimmedString(row.batch_id),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
  };
}

function normalizeOwnerCode(value) {
  const code = requireString(value, 'Owner code').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  if (!code) {
    throw new HttpError(400, 'Owner code is required.');
  }
  if (code.length > 16) {
    throw new HttpError(400, 'Owner code must be 16 characters or fewer.');
  }
  return code;
}

async function requireOwnerCompany(client, orgId, ownerCompanyId, options = {}) {
  const row = await queryRow(
    client,
    `
      select
        id,
        code,
        display_name,
        lookup_key,
        is_active
      from app.owner_companies
      where org_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    [orgId, requireUuid(ownerCompanyId, 'OwnerCompanyId')]
  );

  if (!row) {
    throw new HttpError(400, 'Owner company was not found.');
  }
  if (options.requireActive && row.is_active !== true) {
    throw new HttpError(400, 'Owner company is inactive and cannot be selected for new assignments.');
  }
  return row;
}

async function listOwnerCompanies(client, orgId, params = {}) {
  const includeInactive =
    params.includeInactive === true || asTrimmedString(params.includeInactive).toLowerCase() === 'true';
  const rows = await queryRows(
    client,
    `
      select *
      from app.owner_companies
      where org_id = $1::uuid
        and ($2::boolean or is_active = true)
      order by is_active desc, code asc
    `,
    [orgId, includeInactive]
  );

  return rows.map(mapOwnerCompanyRow).filter(Boolean);
}

async function upsertOwnerCompany(client, orgId, actor, payload) {
  const code = normalizeOwnerCode(payload.code);
  const displayName = asTrimmedString(payload.displayName) || code;
  const row = await queryRow(
    client,
    `
      insert into app.owner_companies (
        org_id,
        code,
        display_name,
        is_active,
        created_by,
        updated_by
      )
      values (
        $1::uuid,
        $2::text,
        $3::text,
        true,
        $4::text,
        $4::text
      )
      on conflict (org_id, lookup_key) do update set
        code = excluded.code,
        display_name = excluded.display_name,
        is_active = true,
        updated_at = now(),
        updated_by = excluded.updated_by,
        deactivated_at = null,
        deactivated_by = ''
      returning *
    `,
    [orgId, code, displayName, asTrimmedString(actor)]
  );

  return mapOwnerCompanyRow(row);
}

async function deactivateOwnerCompany(client, orgId, actor, payload) {
  const ownerCompanyId = requireUuid(payload.ownerCompanyId, 'OwnerCompanyId');
  const row = await queryRow(
    client,
    `
      update app.owner_companies
      set is_active = false,
          deactivated_at = now(),
          deactivated_by = $3::text,
          updated_at = now(),
          updated_by = $3::text
      where org_id = $1::uuid
        and id = $2::uuid
      returning *
    `,
    [orgId, ownerCompanyId, asTrimmedString(actor)]
  );

  if (!row) {
    throw new HttpError(404, 'Owner company was not found.');
  }
  return mapOwnerCompanyRow(row);
}

async function appendOwnershipEvent(client, orgId, actor, event) {
  const oldOwner = await requireOwnerCompany(client, orgId, event.oldOwnerCompanyId);
  const newOwner = await requireOwnerCompany(client, orgId, event.newOwnerCompanyId);
  const row = await queryRow(
    client,
    `
      insert into app.inventory_ownership_events (
        org_id,
        resource_type,
        resource_id,
        resource_label,
        old_owner_company_id,
        old_owner_code,
        old_owner_display_name,
        new_owner_company_id,
        new_owner_code,
        new_owner_display_name,
        actor,
        note,
        batch_id
      )
      values (
        $1::uuid,
        $2::text,
        $3::text,
        $4::text,
        $5::uuid,
        $6::text,
        $7::text,
        $8::uuid,
        $9::text,
        $10::text,
        $11::text,
        $12::text,
        $13::text
      )
      returning *
    `,
    [
      orgId,
      event.resourceType,
      event.resourceId,
      event.resourceLabel,
      oldOwner.id,
      oldOwner.code,
      oldOwner.display_name,
      newOwner.id,
      newOwner.code,
      newOwner.display_name,
      asTrimmedString(actor),
      asTrimmedString(event.note),
      asTrimmedString(event.batchId),
    ]
  );

  return mapOwnershipEventRow(row);
}

async function buildPublicBox(client, orgId, box) {
  const allocations = await listAllocationsByBox(client, orgId, box.boxId);
  return toPublicBox(applyReservationMetricsToBox(box, allocations));
}

async function changeFilmBoxOwner(client, orgId, actor, payload, batchId = '') {
  const boxId = requireString(payload.boxId, 'BoxID').toUpperCase();
  const nextOwner = await requireOwnerCompany(client, orgId, payload.ownerCompanyId, { requireActive: true });
  const existingBox = await findBoxById(client, orgId, boxId);
  if (!existingBox) {
    throw new HttpError(404, 'Box not found.');
  }

  const oldOwnerCompanyId = asTrimmedString(existingBox.ownerCompanyId);
  if (oldOwnerCompanyId === asTrimmedString(nextOwner.id)) {
    return {
      changedCount: 0,
      batchId: asTrimmedString(batchId),
      events: [],
    };
  }

  const beforePublic = await buildPublicBox(client, orgId, existingBox);
  const savedBox = await saveBoxRecord(client, orgId, {
    ...existingBox,
    ownerCompanyId: nextOwner.id,
  });
  const afterPublic = await buildPublicBox(client, orgId, savedBox);
  const note = asTrimmedString(payload.note);
  const effectiveBatchId = asTrimmedString(batchId) || crypto.randomUUID();
  const event = await appendOwnershipEvent(client, orgId, actor, {
    resourceType: 'film_box',
    resourceId: savedBox.boxId,
    resourceLabel: savedBox.boxId,
    oldOwnerCompanyId,
    newOwnerCompanyId: nextOwner.id,
    note,
    batchId: effectiveBatchId,
  });

  await appendAuditEntry(
    client,
    orgId,
    'OWNER_CHANGE',
    savedBox.boxId,
    beforePublic,
    afterPublic,
    actor,
    note || `Changed owner from ${beforePublic.ownerCompanyCode || 'unknown'} to ${nextOwner.code}.`
  );

  return {
    changedCount: 1,
    batchId: effectiveBatchId,
    events: [event],
  };
}

async function findCaulkStockRow(client, orgId, stockId) {
  const row = await queryRow(
    client,
    `
      select
        s.*,
        p.name as product_name,
        p.code as product_code,
        m.name as manufacturer,
        current_owner.code as owner_company_code,
        current_owner.display_name as owner_company_display_name
      from app.caulk_stock s
      join app.caulk_products p
        on p.org_id = s.org_id
       and p.id = s.product_id
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      left join app.owner_companies current_owner
        on current_owner.org_id = s.org_id
       and current_owner.id = s.owner_company_id
      where s.org_id = $1::uuid
        and s.id = $2::uuid
      for update
    `,
    [orgId, requireUuid(stockId, 'stockId')]
  );

  if (!row) {
    throw new HttpError(404, 'Caulk stock row was not found.');
  }
  return row;
}

async function changeCaulkStockOwner(client, orgId, actor, payload, batchId = '') {
  const stock = await findCaulkStockRow(client, orgId, payload.stockId);
  const nextOwner = await requireOwnerCompany(client, orgId, payload.ownerCompanyId, { requireActive: true });
  const oldOwnerCompanyId = asTrimmedString(stock.owner_company_id);
  if (oldOwnerCompanyId === asTrimmedString(nextOwner.id)) {
    return {
      changedCount: 0,
      batchId: asTrimmedString(batchId),
      events: [],
    };
  }

  const note = asTrimmedString(payload.note);
  const effectiveBatchId = asTrimmedString(batchId) || crypto.randomUUID();
  const existingTarget = await queryRow(
    client,
    `
      select *
      from app.caulk_stock
      where org_id = $1::uuid
        and product_id = $2::uuid
        and warehouse = $3::text
        and owner_company_id = $4::uuid
        and id <> $5::uuid
      for update
    `,
    [orgId, stock.product_id, asTrimmedString(stock.warehouse).toUpperCase(), nextOwner.id, stock.id]
  );

  if (existingTarget) {
    await client.query(
      `
        update app.caulk_stock
        set tubes_on_hand = tubes_on_hand + $3::integer,
            updated_at = now(),
            updated_by = $4::text
        where org_id = $1::uuid
          and id = $2::uuid
      `,
      [orgId, existingTarget.id, Number(stock.tubes_on_hand || 0), asTrimmedString(actor)]
    );
    await client.query(
      `
        delete from app.caulk_stock
        where org_id = $1::uuid
          and id = $2::uuid
      `,
      [orgId, stock.id]
    );
  } else {
    await client.query(
      `
        update app.caulk_stock
        set owner_company_id = $3::uuid,
            updated_at = now(),
            updated_by = $4::text
        where org_id = $1::uuid
          and id = $2::uuid
      `,
      [orgId, stock.id, nextOwner.id, asTrimmedString(actor)]
    );
  }

  const event = await appendOwnershipEvent(client, orgId, actor, {
    resourceType: 'caulk_stock',
    resourceId: asTrimmedString(stock.id),
    resourceLabel: `${asTrimmedString(stock.warehouse).toUpperCase()} ${asTrimmedString(stock.manufacturer)} ${asTrimmedString(stock.product_name)}`,
    oldOwnerCompanyId,
    newOwnerCompanyId: nextOwner.id,
    note,
    batchId: effectiveBatchId,
  });

  return {
    changedCount: 1,
    batchId: effectiveBatchId,
    events: [event],
  };
}

async function bulkTransferOwnership(client, orgId, actor, payload) {
  await requireOwnerCompany(client, orgId, payload.ownerCompanyId, { requireActive: true });
  const filmBoxIds = Array.isArray(payload.filmBoxIds)
    ? payload.filmBoxIds.map((entry) => asTrimmedString(entry).toUpperCase()).filter(Boolean)
    : [];
  const caulkStockIds = Array.isArray(payload.caulkStockIds)
    ? payload.caulkStockIds.map((entry) => asTrimmedString(entry)).filter(Boolean)
    : [];
  if (filmBoxIds.length + caulkStockIds.length === 0) {
    throw new HttpError(400, 'Select at least one exact film box or caulk stock row.');
  }

  const batchId = crypto.randomUUID();
  const events = [];
  let changedCount = 0;

  for (const boxId of filmBoxIds) {
    const result = await changeFilmBoxOwner(
      client,
      orgId,
      actor,
      { boxId, ownerCompanyId: payload.ownerCompanyId, note: payload.note },
      batchId
    );
    changedCount += result.changedCount;
    events.push(...result.events);
  }

  for (const stockId of caulkStockIds) {
    const result = await changeCaulkStockOwner(
      client,
      orgId,
      actor,
      { stockId, ownerCompanyId: payload.ownerCompanyId, note: payload.note },
      batchId
    );
    changedCount += result.changedCount;
    events.push(...result.events);
  }

  return {
    changedCount,
    batchId,
    events,
  };
}

export {
  listOwnerCompanies,
  upsertOwnerCompany,
  deactivateOwnerCompany,
  changeFilmBoxOwner,
  changeCaulkStockOwner,
  bulkTransferOwnership,
};
