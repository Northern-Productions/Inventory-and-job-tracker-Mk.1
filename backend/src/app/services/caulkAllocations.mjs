import crypto from 'node:crypto';

import { queryRow, queryRows } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import {
  asTrimmedString,
  integerOrZero,
  parseIntegerInput,
  requireString,
  requireUuid,
} from '../core/helpers.mjs';

async function callCaulkAllocationMutation(client, functionName, orgId, actor, payload) {
  const row = await queryRow(
    client,
    `
      select ${functionName}(
        $1::uuid,
        $2::text,
        $3::jsonb
      ) as result
    `,
    [orgId, actor, JSON.stringify(payload || {})]
  );

  const result =
    row && typeof row.result === 'object' && row.result !== null
      ? row.result
      : null;

  if (!result) {
    throw new HttpError(500, 'Caulk allocation mutation completed but returned no payload.');
  }

  const warnings = Array.isArray(result.warnings)
    ? result.warnings.map((value) => asTrimmedString(value)).filter(Boolean)
    : [];

  return { result, warnings };
}

async function requireAllocationWriteAccess(client, orgId) {
  await client.query(
    `
      select app_api.require_effective_feature_access(
        $1::uuid,
        'allocations',
        'write'
      )
    `,
    [orgId]
  );
}

async function requireInventoryWriteAccess(client, orgId) {
  await client.query(
    `
      select app_api.require_effective_feature_access(
        $1::uuid,
        'inventory',
        'write'
      )
    `,
    [orgId]
  );
}

async function requireActiveJobForCaulk(client, orgId, jobNumber) {
  const row = await queryRow(
    client,
    `
      select (app_api.require_active_job_for_caulk($1::uuid, $2::text)).*
    `,
    [orgId, jobNumber]
  );

  if (!row) {
    throw new HttpError(500, 'Caulk job validation completed without returning a job row.');
  }

  return row;
}

async function requireCaulkAllocationJobById(client, orgId, jobId, missingMessage) {
  const normalizedJobId = asTrimmedString(jobId);
  if (!normalizedJobId) {
    throw new HttpError(404, missingMessage);
  }

  const row = await queryRow(
    client,
    `
      select *
      from app.jobs j
      where j.org_id = $1::uuid
        and j.id = $2::uuid
      for update
    `,
    [orgId, requireUuid(normalizedJobId, 'jobId')]
  );

  if (!row) {
    throw new HttpError(404, missingMessage);
  }

  return row;
}

function assertActiveCaulkJob(job) {
  if (asTrimmedString(job?.lifecycle_status).toUpperCase() !== 'ACTIVE') {
    throw new HttpError(400, `Job ${asTrimmedString(job?.job_number)} is closed and cannot receive caulk allocations.`);
  }
}

async function requireCaulkWarehouse(client, orgId, warehouse) {
  const row = await queryRow(
    client,
    `
      select app_api.caulk_require_warehouse($1::uuid, $2::text) as warehouse
    `,
    [orgId, warehouse]
  );

  const normalized = asTrimmedString(row?.warehouse).toUpperCase();
  if (!normalized) {
    throw new HttpError(500, 'Caulk warehouse validation completed without returning a warehouse code.');
  }

  return normalized;
}

async function requireOwnerCompany(client, orgId, ownerCompanyId, fieldName = 'OwnerCompanyId') {
  const row = await queryRow(
    client,
    `
      select *
      from app.owner_companies
      where org_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    [orgId, requireUuid(ownerCompanyId, fieldName)]
  );

  if (!row) {
    throw new HttpError(400, 'Owner company was not found.');
  }
  if (row.is_active !== true) {
    throw new HttpError(400, 'Owner company is inactive and cannot be selected for new assignments.');
  }
  return row;
}

async function resolveCaulkStockOwner(client, orgId, productId, warehouse, payload = {}) {
  const normalizedWarehouse = await requireCaulkWarehouse(client, orgId, warehouse);
  const stockId = asTrimmedString(payload.stockId || payload.sourceStockId);
  if (stockId) {
    const row = await queryRow(
      client,
      `
        select owner_company_id
        from app.caulk_stock
        where org_id = $1::uuid
          and id = $2::uuid
          and product_id = $3::uuid
          and warehouse = $4::text
        limit 1
      `,
      [orgId, requireUuid(stockId, 'stockId'), productId, normalizedWarehouse]
    );
    if (!row) {
      throw new HttpError(400, 'Selected caulk stock row was not found for this product and warehouse.');
    }
    return row.owner_company_id;
  }

  const ownerCompanyId = asTrimmedString(payload.ownerCompanyId || payload.sourceOwnerCompanyId);
  if (ownerCompanyId) {
    const owner = await requireOwnerCompany(client, orgId, ownerCompanyId);
    return owner.id;
  }

  const rows = await queryRows(
    client,
    `
      select owner_company_id
      from app.caulk_stock
      where org_id = $1::uuid
        and product_id = $2::uuid
        and warehouse = $3::text
      order by updated_at desc, id desc
    `,
    [orgId, productId, normalizedWarehouse]
  );

  if (rows.length === 1) {
    return rows[0].owner_company_id;
  }

  throw new HttpError(
    400,
    'Multiple owner rows exist for this caulk product and warehouse. Select an exact owner row.'
  );
}

async function createLogId(client) {
  const row = await queryRow(client, 'select app_api.create_log_id() as id');
  const id = asTrimmedString(row?.id);
  if (!id) {
    throw new HttpError(500, 'Log ID generation failed.');
  }
  return id;
}

async function createCaulkTransactionId(client) {
  const row = await queryRow(client, 'select app_api.caulk_create_transaction_id() as transfer_id');
  const transferId = asTrimmedString(row?.transfer_id);
  if (!transferId) {
    throw new HttpError(500, 'Caulk transfer ID generation failed.');
  }
  return transferId;
}

async function applyCaulkDelta(
  client,
  orgId,
  actor,
  productId,
  warehouse,
  ownerCompanyId,
  action,
  deltaTubes,
  reason,
  transferId = '',
  sourceBoxId = '',
  notes = ''
) {
  await queryRow(
    client,
    `
      select app_api.caulk_apply_stock_delta_for_owner(
        $1::uuid,
        $2::text,
        $3::uuid,
        $4::text,
        $5::uuid,
        $6::text,
        $7::integer,
        $8::text,
        $9::text,
        $10::text,
        $11::text
      ) as result
    `,
    [orgId, actor, productId, warehouse, ownerCompanyId, action, deltaTubes, reason, transferId, sourceBoxId, notes]
  );
}

async function requireCaulkProduct(client, orgId, productId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.caulk_products p
      where p.org_id = $1::uuid
        and p.id = $2::uuid
      limit 1
    `,
    [orgId, productId]
  );

  if (!row) {
    throw new HttpError(400, 'Product was not found.');
  }

  return row;
}

async function requireCaulkRequirementForJob(client, orgId, requirementId, jobId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.job_caulk_requirements r
      where r.org_id = $1::uuid
        and r.id = $2::uuid
        and r.job_id = $3::uuid
      for update
    `,
    [orgId, requirementId, jobId]
  );

  if (!row) {
    throw new HttpError(400, 'RequirementId was not found for this job.');
  }

  return row;
}

async function clearStagedPickupForActiveCaulkRequirement(client, orgId, actor, jobId, requirementId) {
  const normalizedRequirementId = asTrimmedString(requirementId);
  if (!normalizedRequirementId) {
    return [];
  }

  const row = await queryRow(
    client,
    `
      update app.jobs j
      set is_staged_for_pickup = false,
          updated_at = now(),
          updated_by = $4::text
      from app.job_caulk_requirements r
      left join app.job_phases p
        on p.org_id = r.org_id
       and p.job_id = r.job_id
       and p.id = r.phase_id
      where j.org_id = $1::uuid
        and j.id = $2::uuid
        and j.is_staged_for_pickup = true
        and r.org_id = j.org_id
        and r.job_id = j.id
        and r.id = $3::uuid
        and coalesce(p.workflow_status, 'ACTIVE') = 'ACTIVE'
      returning j.job_number
    `,
    [orgId, jobId, normalizedRequirementId, asTrimmedString(actor)]
  );

  return row
    ? ['Staged pickup was cleared because active caulk material was added.']
    : [];
}

async function requireLockedAllocation(client, orgId, caulkAllocationId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.caulk_job_allocations a
      where a.org_id = $1::uuid
        and a.caulk_allocation_id = $2::text
      for update
    `,
    [orgId, caulkAllocationId]
  );

  if (!row) {
    throw new HttpError(404, `Caulk allocation ${caulkAllocationId} was not found.`);
  }

  return row;
}

async function findLockedPendingTransferByAllocationRowId(client, orgId, allocationRowId) {
  if (!allocationRowId) {
    return null;
  }

  return queryRow(
    client,
    `
      select *
      from app.caulk_transfers t
      where t.org_id = $1::uuid
        and t.caulk_allocation_id = $2::uuid
        and t.status = 'PENDING'
      order by t.created_at desc, t.id desc
      limit 1
      for update
    `,
    [orgId, allocationRowId]
  );
}

async function requireLockedTransfer(client, orgId, transferId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.caulk_transfers t
      where t.org_id = $1::uuid
        and t.transfer_id = $2::text
      for update
    `,
    [orgId, transferId]
  );

  if (!row) {
    throw new HttpError(404, 'Caulk transfer not found.');
  }

  return row;
}

async function requireLockedAllocationByRowId(client, orgId, allocationRowId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.caulk_job_allocations a
      where a.org_id = $1::uuid
        and a.id = $2::uuid
      for update
    `,
    [orgId, allocationRowId]
  );

  if (!row) {
    throw new HttpError(404, 'Parent caulk allocation was not found.');
  }

  return row;
}

async function seedCaulkStockRow(client, orgId, actor, productId, warehouse, ownerCompanyId) {
  const normalizedWarehouse = await requireCaulkWarehouse(client, orgId, warehouse);
  const owner = await requireOwnerCompany(client, orgId, ownerCompanyId);
  await client.query(
    `
      insert into app.caulk_stock (
        org_id,
        product_id,
        warehouse,
        owner_company_id,
        tubes_on_hand,
        updated_by
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::uuid,
        0,
        $5::text
      )
      on conflict (org_id, product_id, warehouse, owner_company_id) do nothing
    `,
    [orgId, productId, normalizedWarehouse, owner.id, asTrimmedString(actor)]
  );

  return normalizedWarehouse;
}

async function lockCaulkStockRow(client, orgId, productId, warehouse, ownerCompanyId) {
  return queryRow(
    client,
    `
      select *
      from app.caulk_stock s
      where s.org_id = $1::uuid
        and s.product_id = $2::uuid
        and s.warehouse = $3::text
        and s.owner_company_id = $4::uuid
      for update
    `,
    [orgId, productId, warehouse, ownerCompanyId]
  );
}

async function countOpenCheckoutsForAllocationRow(client, orgId, allocationRowId) {
  const row = await queryRow(
    client,
    `
      select count(*)::integer as open_checkout_count
      from app.caulk_job_checkouts c
      where c.org_id = $1::uuid
        and c.caulk_allocation_id = $2::uuid
        and c.status = 'OPEN'
    `,
    [orgId, allocationRowId]
  );

  return integerOrZero(row?.open_checkout_count);
}

function formatTubeCount(tubes) {
  return `${tubes} tube${tubes === 1 ? '' : 's'}`;
}

function normalizeWarnings(value) {
  return Array.isArray(value) ? value.map((entry) => asTrimmedString(entry)).filter(Boolean) : [];
}

function buildMutationResponse(jobNumber, caulkAllocationId, warnings = [], extraResult = {}) {
  const normalizedWarnings = normalizeWarnings(warnings);
  return {
    result: {
      ...extraResult,
      jobNumber: asTrimmedString(jobNumber),
      caulkAllocationId: asTrimmedString(caulkAllocationId),
      warnings: normalizedWarnings,
    },
    warnings: normalizedWarnings,
  };
}

function buildTransferMutationResponse(jobNumber, caulkAllocationId, transferId, warnings = [], extraResult = {}) {
  const normalizedWarnings = normalizeWarnings(warnings);
  return {
    result: {
      ...extraResult,
      jobNumber: asTrimmedString(jobNumber),
      caulkAllocationId: asTrimmedString(caulkAllocationId),
      transferId: asTrimmedString(transferId),
      warnings: normalizedWarnings,
    },
    warnings: normalizedWarnings,
  };
}

function getCoveredAllocationTubes(allocation) {
  return integerOrZero(allocation?.reserved_tubes_remaining) + integerOrZero(allocation?.checked_out_tubes_total);
}

function getTransferShortageForAllocation(allocation) {
  return Math.max(integerOrZero(allocation?.allocated_tubes) - getCoveredAllocationTubes(allocation), 0);
}

function assertNoPendingTransferForEditOrCheckout(pendingTransfer, modeLabel) {
  if (pendingTransfer) {
    throw new HttpError(
      400,
      `Receive or cancel transfer ${asTrimmedString(pendingTransfer.transfer_id)} before ${modeLabel} this allocation.`
    );
  }
}

async function saveCaulkTransferRecord(client, orgId, transfer) {
  return queryRow(
    client,
    `
      insert into app.caulk_transfers (
        org_id,
        transfer_id,
        caulk_allocation_id,
        job_id,
        job_number,
        product_id,
        owner_company_id,
        source_warehouse,
        destination_warehouse,
        pending_tubes,
        status,
        notes,
        created_at,
        created_by,
        received_at,
        received_by,
        cancelled_at,
        cancelled_by,
        updated_at,
        updated_by
      )
      values (
        $1::uuid,
        $2::text,
        $3::uuid,
        nullif($4::text, '')::uuid,
        $5::text,
        $6::uuid,
        $7::uuid,
        $8::text,
        $9::text,
        $10::integer,
        $11::app.caulk_transfer_status,
        $12::text,
        $13::timestamptz,
        $14::text,
        nullif($15::text, '')::timestamptz,
        $16::text,
        nullif($17::text, '')::timestamptz,
        $18::text,
        $19::timestamptz,
        $20::text
      )
      on conflict (org_id, transfer_id) do update set
        owner_company_id = excluded.owner_company_id,
        pending_tubes = excluded.pending_tubes,
        status = excluded.status,
        notes = excluded.notes,
        received_at = excluded.received_at,
        received_by = excluded.received_by,
        cancelled_at = excluded.cancelled_at,
        cancelled_by = excluded.cancelled_by,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      returning *
    `,
    [
      orgId,
      asTrimmedString(transfer.transferId).toUpperCase(),
      transfer.caulkAllocationId,
      asTrimmedString(transfer.jobId),
      asTrimmedString(transfer.jobNumber),
      transfer.productId,
      transfer.ownerCompanyId,
      asTrimmedString(transfer.sourceWarehouse).toUpperCase(),
      asTrimmedString(transfer.destinationWarehouse).toUpperCase(),
      integerOrZero(transfer.pendingTubes),
      asTrimmedString(transfer.status).toUpperCase(),
      asTrimmedString(transfer.notes),
      transfer.createdAt || new Date().toISOString(),
      asTrimmedString(transfer.createdBy),
      asTrimmedString(transfer.receivedAt),
      asTrimmedString(transfer.receivedBy),
      asTrimmedString(transfer.cancelledAt),
      asTrimmedString(transfer.cancelledBy),
      transfer.updatedAt || new Date().toISOString(),
      asTrimmedString(transfer.updatedBy || transfer.createdBy),
    ]
  );
}

async function reserveLocalCaulkTubes(
  client,
  orgId,
  actor,
  productId,
  targetWarehouse,
  ownerCompanyId,
  reserveTubes,
  reserveAction,
  reserveReason,
  sourceBoxId = '',
  notes = ''
) {
  if (!Number.isInteger(reserveTubes) || reserveTubes <= 0) {
    throw new HttpError(400, 'Reserve quantity must be greater than zero.');
  }

  const normalizedActor = asTrimmedString(actor);
  const normalizedNotes = asTrimmedString(notes);
  const normalizedSourceBoxId = asTrimmedString(sourceBoxId);
  const normalizedTargetWarehouse = await seedCaulkStockRow(
    client,
    orgId,
    normalizedActor,
    productId,
    targetWarehouse,
    ownerCompanyId
  );
  const targetStock = await lockCaulkStockRow(client, orgId, productId, normalizedTargetWarehouse, ownerCompanyId);
  const targetAvailable = integerOrZero(targetStock?.tubes_on_hand);
  const reservedTubes = Math.min(targetAvailable, reserveTubes);
  const shortage = Math.max(reserveTubes - reservedTubes, 0);

  if (reservedTubes > 0) {
    await applyCaulkDelta(
      client,
      orgId,
      normalizedActor,
      productId,
      normalizedTargetWarehouse,
      ownerCompanyId,
      reserveAction,
      -reservedTubes,
      reserveReason,
      '',
      normalizedSourceBoxId,
      normalizedNotes
    );
  }

  return {
    reservedTubes,
    shortageTubes: shortage,
    warehouse: normalizedTargetWarehouse,
  };
}

async function startPendingCaulkTransfer(
  client,
  orgId,
  actor,
  {
    allocationRowId,
    allocationPublicId,
    jobId,
    jobNumber,
    productId,
    ownerCompanyId,
    fromWarehouse,
    toWarehouse,
    pendingTubes,
    notes,
  }
) {
  if (!pendingTubes) {
    return {
      transferId: '',
      warnings: [],
    };
  }

  const normalizedActor = asTrimmedString(actor);
  const normalizedNotes = asTrimmedString(notes);
  const normalizedDestinationWarehouse = await seedCaulkStockRow(
    client,
    orgId,
    normalizedActor,
    productId,
    toWarehouse,
    ownerCompanyId
  );
  const requestedSourceWarehouse = asTrimmedString(fromWarehouse);
  if (!requestedSourceWarehouse) {
    throw new HttpError(
      400,
      `${normalizedDestinationWarehouse} still needs ${formatTubeCount(pendingTubes)} transferred in before this allocation can be saved. Select a source warehouse first.`
    );
  }

  const normalizedSourceWarehouse = await seedCaulkStockRow(
    client,
    orgId,
    normalizedActor,
    productId,
    requestedSourceWarehouse,
    ownerCompanyId
  );
  if (normalizedSourceWarehouse === normalizedDestinationWarehouse) {
    throw new HttpError(400, 'Transfer source and destination warehouse must differ.');
  }

  const sourceStock = await lockCaulkStockRow(client, orgId, productId, normalizedSourceWarehouse, ownerCompanyId);
  const sourceAvailable = integerOrZero(sourceStock?.tubes_on_hand);
  if (sourceAvailable < pendingTubes) {
    throw new HttpError(
      400,
      `${normalizedSourceWarehouse} only has ${formatTubeCount(sourceAvailable)} available; ${formatTubeCount(pendingTubes)} needed to cover the shortage at ${normalizedDestinationWarehouse}.`
    );
  }

  const transferId = await createCaulkTransactionId(client);
  await applyCaulkDelta(
    client,
    orgId,
    normalizedActor,
    productId,
    normalizedSourceWarehouse,
    ownerCompanyId,
    'TRANSFER_OUT',
    -pendingTubes,
    `Started caulk transfer from ${normalizedSourceWarehouse} to ${normalizedDestinationWarehouse} for job ${asTrimmedString(jobNumber)}.`,
    transferId,
    asTrimmedString(allocationPublicId),
    normalizedNotes
  );
  await saveCaulkTransferRecord(client, orgId, {
    transferId,
    caulkAllocationId: allocationRowId,
    jobId,
    jobNumber,
    productId,
    ownerCompanyId,
    sourceWarehouse: normalizedSourceWarehouse,
    destinationWarehouse: normalizedDestinationWarehouse,
    pendingTubes,
    status: 'PENDING',
    notes: normalizedNotes,
    createdAt: new Date().toISOString(),
    createdBy: normalizedActor,
    updatedAt: new Date().toISOString(),
    updatedBy: normalizedActor,
  });

  return {
    transferId,
    warnings: [
      `Started transfer of ${formatTubeCount(pendingTubes)} from ${normalizedSourceWarehouse} to ${normalizedDestinationWarehouse}. Receive it before checkout or staging.`,
    ],
  };
}

async function cancelPendingCaulkTransferInternal(client, orgId, actor, transfer, allocation, selectedJob, reason = '') {
  if (!transfer) {
    return {
      transferId: '',
      warnings: [],
    };
  }

  if (asTrimmedString(transfer.status).toUpperCase() !== 'PENDING') {
    throw new HttpError(400, `Caulk transfer ${transfer.transfer_id} is already ${transfer.status}.`);
  }

  const normalizedActor = asTrimmedString(actor);
  const pendingTubes = integerOrZero(transfer.pending_tubes);
  const normalizedReason =
    asTrimmedString(reason) ||
    `Cancelled caulk transfer from ${asTrimmedString(transfer.source_warehouse).toUpperCase()} to ${asTrimmedString(transfer.destination_warehouse).toUpperCase()} for job ${asTrimmedString(selectedJob?.job_number || transfer.job_number)}.`;

  if (pendingTubes > 0) {
    await applyCaulkDelta(
      client,
      orgId,
      normalizedActor,
      transfer.product_id,
      asTrimmedString(transfer.source_warehouse).toUpperCase(),
      transfer.owner_company_id,
      'TRANSFER_IN',
      pendingTubes,
      normalizedReason,
      asTrimmedString(transfer.transfer_id),
      '',
      normalizedReason
    );
  }

  await saveCaulkTransferRecord(client, orgId, {
    transferId: transfer.transfer_id,
    caulkAllocationId: transfer.caulk_allocation_id,
    jobId: selectedJob?.id || transfer.job_id,
    jobNumber: selectedJob?.job_number || transfer.job_number,
    productId: transfer.product_id,
    ownerCompanyId: transfer.owner_company_id,
    sourceWarehouse: transfer.source_warehouse,
    destinationWarehouse: transfer.destination_warehouse,
    pendingTubes,
    status: 'CANCELLED',
    notes: normalizedReason,
    createdAt: transfer.created_at,
    createdBy: transfer.created_by,
    receivedAt: transfer.received_at,
    receivedBy: transfer.received_by,
    cancelledAt: new Date().toISOString(),
    cancelledBy: normalizedActor,
    updatedAt: new Date().toISOString(),
    updatedBy: normalizedActor,
  });

  return {
    transferId: asTrimmedString(transfer.transfer_id),
    jobId: asTrimmedString(selectedJob?.id || allocation?.job_id || transfer.job_id),
    jobNumber: asTrimmedString(selectedJob?.job_number || allocation?.job_number || transfer.job_number),
    caulkAllocationId: asTrimmedString(allocation?.caulk_allocation_id),
    productId: asTrimmedString(transfer.product_id),
    sourceWarehouse: asTrimmedString(transfer.source_warehouse).toUpperCase(),
    destinationWarehouse: asTrimmedString(transfer.destination_warehouse).toUpperCase(),
    warnings: pendingTubes
      ? [
          `Cancelled transfer ${asTrimmedString(transfer.transfer_id)} and returned ${formatTubeCount(pendingTubes)} to ${asTrimmedString(transfer.source_warehouse).toUpperCase()}.`,
        ]
      : [],
  };
}

async function receivePendingCaulkTransferInternal(client, orgId, actor, transfer, allocation, selectedJob) {
  if (asTrimmedString(transfer.status).toUpperCase() !== 'PENDING') {
    throw new HttpError(400, `Caulk transfer ${transfer.transfer_id} is already ${transfer.status}.`);
  }
  if (asTrimmedString(allocation.status).toUpperCase() !== 'ACTIVE') {
    throw new HttpError(400, 'Parent caulk allocation is no longer active.');
  }

  const normalizedActor = asTrimmedString(actor);
  const destinationWarehouse = await seedCaulkStockRow(
    client,
    orgId,
    normalizedActor,
    transfer.product_id,
    transfer.destination_warehouse,
    transfer.owner_company_id
  );
  const pendingTubes = integerOrZero(transfer.pending_tubes);

  if (pendingTubes > 0) {
    await applyCaulkDelta(
      client,
      orgId,
      normalizedActor,
      transfer.product_id,
      destinationWarehouse,
      transfer.owner_company_id,
      'TRANSFER_IN',
      pendingTubes,
      `Received caulk transfer into ${destinationWarehouse} for job ${asTrimmedString(selectedJob?.job_number || allocation.job_number)}.`,
      asTrimmedString(transfer.transfer_id),
      asTrimmedString(allocation.caulk_allocation_id),
      asTrimmedString(transfer.notes)
    );
    await applyCaulkDelta(
      client,
      orgId,
      normalizedActor,
      transfer.product_id,
      destinationWarehouse,
      transfer.owner_company_id,
      'JOB_ALLOCATE_EDIT_INC',
      -pendingTubes,
      `Received pending caulk transfer for allocation ${asTrimmedString(allocation.caulk_allocation_id)}.`,
      '',
      asTrimmedString(allocation.caulk_allocation_id),
      asTrimmedString(transfer.notes)
    );
  }

  await client.query(
    `
      update app.caulk_job_allocations
      set
        reserved_tubes_remaining = reserved_tubes_remaining + $3::integer,
        updated_at = now(),
        updated_by = $4::text
      where id = $1::uuid
        and org_id = $2::uuid
    `,
    [allocation.id, orgId, pendingTubes, normalizedActor]
  );

  await saveCaulkTransferRecord(client, orgId, {
    transferId: transfer.transfer_id,
    caulkAllocationId: transfer.caulk_allocation_id,
    jobId: selectedJob?.id || transfer.job_id,
    jobNumber: selectedJob?.job_number || transfer.job_number,
    productId: transfer.product_id,
    ownerCompanyId: transfer.owner_company_id,
    sourceWarehouse: transfer.source_warehouse,
    destinationWarehouse: transfer.destination_warehouse,
    pendingTubes,
    status: 'RECEIVED',
    notes: asTrimmedString(transfer.notes),
    createdAt: transfer.created_at,
    createdBy: transfer.created_by,
    receivedAt: new Date().toISOString(),
    receivedBy: normalizedActor,
    cancelledAt: transfer.cancelled_at,
    cancelledBy: transfer.cancelled_by,
    updatedAt: new Date().toISOString(),
    updatedBy: normalizedActor,
  });

  return {
    transferId: asTrimmedString(transfer.transfer_id),
    jobId: asTrimmedString(selectedJob?.id || allocation?.job_id || transfer.job_id),
    jobNumber: asTrimmedString(selectedJob?.job_number || allocation?.job_number || transfer.job_number),
    caulkAllocationId: asTrimmedString(allocation?.caulk_allocation_id),
    productId: asTrimmedString(transfer.product_id),
    sourceWarehouse: asTrimmedString(transfer.source_warehouse).toUpperCase(),
    destinationWarehouse,
    warnings: [
      `Received ${formatTubeCount(pendingTubes)} into ${destinationWarehouse} and reserved it for allocation ${asTrimmedString(allocation.caulk_allocation_id)}.`,
    ],
  };
}

export async function addCaulkAllocation(client, orgId, actor, payload) {
  await requireAllocationWriteAccess(client, orgId);

  const productIdRaw = asTrimmedString(payload?.productId);
  if (!productIdRaw) {
    throw new HttpError(400, 'productId is required.');
  }

  const productId = requireUuid(productIdRaw, 'productId');
  const allocatedTubes = parseIntegerInput(payload?.allocatedTubes, 'allocatedTubes');
  if (allocatedTubes <= 0) {
    throw new HttpError(400, 'allocatedTubes must be greater than zero.');
  }

  const jobIdRaw = asTrimmedString(payload?.jobId);
  const payloadJobNumber = requireString(payload?.jobNumber, 'Job ID number');
  let job;
  if (jobIdRaw) {
    job = await requireCaulkAllocationJobById(client, orgId, requireUuid(jobIdRaw, 'jobId'), 'Job was not found.');
    if (asTrimmedString(job.job_number) !== payloadJobNumber) {
      throw new HttpError(400, 'Job identity mismatch: selected job does not match jobNumber.');
    }
    assertActiveCaulkJob(job);
  } else {
    job = await requireActiveJobForCaulk(client, orgId, payloadJobNumber);
  }
  await requireCaulkProduct(client, orgId, productId);

  const requirementIdRaw = asTrimmedString(payload?.requirementId);
  if (requirementIdRaw) {
    await requireCaulkRequirementForJob(client, orgId, requireUuid(requirementIdRaw, 'requirementId'), job.id);
  }

  const allocationId = await createLogId(client);
  const allocationRowId = crypto.randomUUID();
  const warehouse = await requireCaulkWarehouse(client, orgId, payload?.warehouse);
  const ownerCompanyId = await resolveCaulkStockOwner(client, orgId, productId, warehouse, {
    ownerCompanyId: payload?.ownerCompanyId || payload?.sourceOwnerCompanyId,
    stockId: payload?.stockId,
  });
  const normalizedActor = asTrimmedString(actor);
  const localReservation = await reserveLocalCaulkTubes(
    client,
    orgId,
    normalizedActor,
    productId,
    warehouse,
    ownerCompanyId,
    allocatedTubes,
    'JOB_ALLOCATE',
    `Allocated caulk to job ${asTrimmedString(job.job_number)}.`,
    allocationId,
    payload?.notes
  );

  await client.query(
    `
      insert into app.caulk_job_allocations (
        id,
        org_id,
        caulk_allocation_id,
        job_id,
        job_number,
        requirement_id,
        product_id,
        owner_company_id,
        warehouse,
        allocated_tubes,
        reserved_tubes_remaining,
        checked_out_tubes_total,
        returned_unused_tubes_total,
        used_tubes_total,
        overage_tubes_total,
        status,
        created_at,
        created_by,
        updated_at,
        updated_by,
        allocation_source,
        notes
      )
      values (
        $12::uuid,
        $1::uuid,
        $2::text,
        $3::uuid,
        $4::text,
        nullif($5::text, '')::uuid,
        $6::uuid,
        $7::uuid,
        $8::text,
        $9::integer,
        $10::integer,
        0,
        0,
        0,
        0,
        'ACTIVE',
        now(),
        $11::text,
        now(),
        $11::text,
        'MANUAL',
        $13::text
      )
    `,
    [
      orgId,
      allocationId,
      job.id,
      asTrimmedString(job.job_number),
      requirementIdRaw,
      productId,
      ownerCompanyId,
      warehouse,
      allocatedTubes,
      localReservation.reservedTubes,
      normalizedActor,
      allocationRowId,
      asTrimmedString(payload?.notes),
    ]
  );

  const transferStart = await startPendingCaulkTransfer(client, orgId, normalizedActor, {
    allocationRowId,
    allocationPublicId: allocationId,
    jobId: job.id,
    jobNumber: asTrimmedString(job.job_number),
    productId,
    ownerCompanyId,
    fromWarehouse: payload?.transferFromWarehouse,
    toWarehouse: warehouse,
    pendingTubes: localReservation.shortageTubes,
    notes: payload?.notes,
  });

  const stagedWarnings = await clearStagedPickupForActiveCaulkRequirement(
    client,
    orgId,
    normalizedActor,
    job.id,
    requirementIdRaw
  );
  const warnings = [...transferStart.warnings, ...stagedWarnings];

  return buildMutationResponse(job.job_number, allocationId, warnings, {
    jobId: asTrimmedString(job.id),
  });
}

export async function updateCaulkAllocation(client, orgId, actor, payload) {
  await requireAllocationWriteAccess(client, orgId);

  const caulkAllocationId = asTrimmedString(payload?.caulkAllocationId);
  if (!caulkAllocationId) {
    throw new HttpError(400, 'CaulkAllocationId is required.');
  }

  const allocation = await requireLockedAllocation(client, orgId, caulkAllocationId);
  if (asTrimmedString(allocation.status).toUpperCase() !== 'ACTIVE') {
    throw new HttpError(400, `Caulk allocation ${caulkAllocationId} is not active.`);
  }

  const selectedJob = await requireCaulkAllocationJobById(
    client,
    orgId,
    allocation.job_id,
    `Job for caulk allocation ${caulkAllocationId} was not found.`
  );
  assertActiveCaulkJob(selectedJob);

  const pendingTransfer = await findLockedPendingTransferByAllocationRowId(client, orgId, allocation.id);

  const hasProductId = Object.prototype.hasOwnProperty.call(payload || {}, 'productId');
  const hasWarehouse = Object.prototype.hasOwnProperty.call(payload || {}, 'warehouse');
  const hasAllocatedTubes = Object.prototype.hasOwnProperty.call(payload || {}, 'allocatedTubes');
  const hasNotes = Object.prototype.hasOwnProperty.call(payload || {}, 'notes');
  const hasOwnerCompany = Boolean(asTrimmedString(payload?.ownerCompanyId || payload?.sourceOwnerCompanyId));
  const hasTransferSelection = asTrimmedString(payload?.transferFromWarehouse).length > 0;
  const hasMaterialEdit = hasProductId || hasWarehouse || hasAllocatedTubes || hasTransferSelection || hasOwnerCompany;

  if (pendingTransfer && hasMaterialEdit) {
    assertNoPendingTransferForEditOrCheckout(pendingTransfer, 'editing');
  }

  const nextProductId = hasProductId
    ? asTrimmedString(payload?.productId)
      ? requireUuid(payload?.productId, 'productId')
      : allocation.product_id
    : allocation.product_id;
  const nextWarehouse = hasWarehouse
    ? await requireCaulkWarehouse(client, orgId, payload?.warehouse)
    : asTrimmedString(allocation.warehouse).toUpperCase();
  const nextOwnerCompanyId =
    hasProductId || hasWarehouse || hasOwnerCompany
      ? await resolveCaulkStockOwner(client, orgId, nextProductId, nextWarehouse, {
          ownerCompanyId: payload?.ownerCompanyId || payload?.sourceOwnerCompanyId,
          stockId: payload?.stockId,
        })
      : allocation.owner_company_id;
  const nextAllocatedTubes = hasAllocatedTubes
    ? parseIntegerInput(payload?.allocatedTubes, 'allocatedTubes')
    : integerOrZero(allocation.allocated_tubes);
  const nextNotes = hasNotes ? asTrimmedString(payload?.notes) : asTrimmedString(allocation.notes);

  if (nextAllocatedTubes <= 0) {
    throw new HttpError(400, 'allocatedTubes must be greater than zero.');
  }

  if (nextProductId !== allocation.product_id) {
    await requireCaulkProduct(client, orgId, nextProductId);
  }

  const currentWarehouse = asTrimmedString(allocation.warehouse).toUpperCase();
  const checkedOutTubesTotal = integerOrZero(allocation.checked_out_tubes_total);
  const reservedTubesRemaining = integerOrZero(allocation.reserved_tubes_remaining);
  const allocatedTubes = integerOrZero(allocation.allocated_tubes);
  const normalizedActor = asTrimmedString(actor);

  if (checkedOutTubesTotal > 0) {
    if (
      nextProductId !== allocation.product_id ||
      nextWarehouse !== currentWarehouse ||
      nextOwnerCompanyId !== allocation.owner_company_id
    ) {
      throw new HttpError(400, 'Product and warehouse cannot be changed after checkout starts.');
    }
    if (nextAllocatedTubes < allocatedTubes) {
      throw new HttpError(400, 'allocatedTubes can only increase after checkout starts.');
    }
  }

  let warnings = [];

  if (nextProductId !== allocation.product_id || nextWarehouse !== currentWarehouse || nextOwnerCompanyId !== allocation.owner_company_id) {
    if (checkedOutTubesTotal > 0) {
      throw new HttpError(400, 'Product and warehouse cannot be changed after checkout starts.');
    }

    if (reservedTubesRemaining > 0) {
      await applyCaulkDelta(
        client,
        orgId,
        normalizedActor,
        allocation.product_id,
        currentWarehouse,
        allocation.owner_company_id,
        'JOB_ALLOCATE_EDIT_DEC',
        reservedTubesRemaining,
        `Edited caulk allocation ${caulkAllocationId}.`,
        '',
        caulkAllocationId,
        'Released prior reserved tubes during edit.'
      );
    }

    const localReservation = await reserveLocalCaulkTubes(
      client,
      orgId,
      normalizedActor,
      nextProductId,
      nextWarehouse,
      nextOwnerCompanyId,
      nextAllocatedTubes,
      'JOB_ALLOCATE_EDIT_INC',
      `Edited caulk allocation ${caulkAllocationId}.`,
      caulkAllocationId,
      nextNotes
    );
    const transferStart = await startPendingCaulkTransfer(client, orgId, normalizedActor, {
      allocationRowId: allocation.id,
      allocationPublicId: caulkAllocationId,
      jobId: selectedJob.id,
      jobNumber: asTrimmedString(selectedJob.job_number),
      productId: nextProductId,
      ownerCompanyId: nextOwnerCompanyId,
      fromWarehouse: payload?.transferFromWarehouse,
      toWarehouse: nextWarehouse,
      pendingTubes: localReservation.shortageTubes,
      notes: nextNotes,
    });
    warnings = transferStart.warnings;

    await client.query(
      `
        update app.caulk_job_allocations
        set
          product_id = $3::uuid,
          owner_company_id = $4::uuid,
          warehouse = $5::text,
          allocated_tubes = $6::integer,
          reserved_tubes_remaining = $7::integer,
          notes = $8::text,
          updated_at = now(),
          updated_by = $9::text
        where id = $1::uuid
          and org_id = $2::uuid
      `,
      [
        allocation.id,
        orgId,
        nextProductId,
        nextOwnerCompanyId,
        nextWarehouse,
        nextAllocatedTubes,
        localReservation.reservedTubes,
        nextNotes,
        normalizedActor,
      ]
    );
  } else {
    const currentlyCovered = getCoveredAllocationTubes(allocation);
    let nextReservedTubesRemaining = reservedTubesRemaining;

    if (nextAllocatedTubes < checkedOutTubesTotal) {
      throw new HttpError(400, 'allocatedTubes cannot drop below already checked-out amount.');
    }

    if (nextAllocatedTubes > currentlyCovered) {
      const additionalCoverageNeeded = nextAllocatedTubes - currentlyCovered;
      const localReservation = await reserveLocalCaulkTubes(
        client,
        orgId,
        normalizedActor,
        allocation.product_id,
        currentWarehouse,
        allocation.owner_company_id,
        additionalCoverageNeeded,
        'JOB_ALLOCATE_EDIT_INC',
        `Increased caulk allocation ${caulkAllocationId}.`,
        caulkAllocationId,
        nextNotes
      );
      nextReservedTubesRemaining += localReservation.reservedTubes;
      const transferStart = await startPendingCaulkTransfer(client, orgId, normalizedActor, {
        allocationRowId: allocation.id,
        allocationPublicId: caulkAllocationId,
        jobId: selectedJob.id,
        jobNumber: asTrimmedString(selectedJob.job_number),
        productId: allocation.product_id,
        ownerCompanyId: allocation.owner_company_id,
        fromWarehouse: payload?.transferFromWarehouse,
        toWarehouse: currentWarehouse,
        pendingTubes: localReservation.shortageTubes,
        notes: nextNotes,
      });
      warnings = transferStart.warnings;
    } else if (nextAllocatedTubes < currentlyCovered) {
      const releaseTubes = Math.min(reservedTubesRemaining, currentlyCovered - nextAllocatedTubes);
      if (releaseTubes > 0) {
        await applyCaulkDelta(
          client,
          orgId,
          normalizedActor,
          allocation.product_id,
          currentWarehouse,
          allocation.owner_company_id,
          'JOB_ALLOCATE_EDIT_DEC',
          releaseTubes,
          `Reduced caulk allocation ${caulkAllocationId}.`,
          '',
          caulkAllocationId,
          nextNotes
        );
        nextReservedTubesRemaining = Math.max(reservedTubesRemaining - releaseTubes, 0);
      }
    }

    await client.query(
      `
        update app.caulk_job_allocations
        set
          allocated_tubes = $3::integer,
          reserved_tubes_remaining = $4::integer,
          notes = $5::text,
          updated_at = now(),
          updated_by = $6::text
        where id = $1::uuid
          and org_id = $2::uuid
      `,
      [allocation.id, orgId, nextAllocatedTubes, nextReservedTubesRemaining, nextNotes, normalizedActor]
    );
  }

  return buildMutationResponse(selectedJob.job_number, caulkAllocationId, warnings, {
    jobId: asTrimmedString(selectedJob.id),
  });
}

export async function checkoutCaulkAllocation(client, orgId, actor, payload) {
  await requireAllocationWriteAccess(client, orgId);

  const caulkAllocationId = asTrimmedString(payload?.caulkAllocationId);
  if (!caulkAllocationId) {
    throw new HttpError(400, 'CaulkAllocationId is required.');
  }

  const checkoutTubes = parseIntegerInput(payload?.checkoutTubes, 'checkoutTubes');
  if (checkoutTubes <= 0) {
    throw new HttpError(400, 'checkoutTubes must be greater than zero.');
  }

  const allocation = await requireLockedAllocation(client, orgId, caulkAllocationId);
  if (asTrimmedString(allocation.status).toUpperCase() !== 'ACTIVE') {
    throw new HttpError(400, `Caulk allocation ${caulkAllocationId} is not active.`);
  }

  const selectedJob = await requireCaulkAllocationJobById(
    client,
    orgId,
    allocation.job_id,
    `Job for caulk allocation ${caulkAllocationId} was not found.`
  );
  assertActiveCaulkJob(selectedJob);

  const pendingTransfer = await findLockedPendingTransferByAllocationRowId(client, orgId, allocation.id);
  assertNoPendingTransferForEditOrCheckout(pendingTransfer, 'checking out');

  const shortage = getTransferShortageForAllocation(allocation);
  if (shortage > 0) {
    throw new HttpError(
      400,
      `${asTrimmedString(allocation.warehouse).toUpperCase()} still needs ${formatTubeCount(shortage)} transferred in before this allocation can be checked out.`
    );
  }

  const openCheckoutCount = await countOpenCheckoutsForAllocationRow(client, orgId, allocation.id);
  if (openCheckoutCount > 0) {
    throw new HttpError(
      400,
      `Caulk allocation ${caulkAllocationId} already has ${openCheckoutCount} open checkout${openCheckoutCount === 1 ? '' : 's'} and cannot be checked out again until that cycle is closed.`
    );
  }

  const normalizedActor = asTrimmedString(actor);
  const currentWarehouse = asTrimmedString(allocation.warehouse).toUpperCase();
  const reservedTubesRemaining = integerOrZero(allocation.reserved_tubes_remaining);
  const checkoutId = await createLogId(client);
  const consumeReserved = Math.min(checkoutTubes, reservedTubesRemaining);
  const overageTubes = Math.max(checkoutTubes - consumeReserved, 0);
  const notes = asTrimmedString(payload?.notes);

  if (overageTubes > 0) {
    await applyCaulkDelta(
      client,
      orgId,
      normalizedActor,
      allocation.product_id,
      currentWarehouse,
      allocation.owner_company_id,
      'JOB_CHECKOUT_OVERAGE',
      -overageTubes,
      `Over-checkout on caulk allocation ${caulkAllocationId}.`,
      '',
      caulkAllocationId,
      notes
    );
  }

  await client.query(
    `
      insert into app.caulk_job_checkouts (
        id,
        org_id,
        caulk_checkout_id,
        caulk_allocation_id,
        job_number,
        product_id,
        owner_company_id,
        warehouse,
        checkout_tubes,
        overage_tubes,
        status,
        checked_out_at,
        checked_out_by,
        notes
      )
      values (
        gen_random_uuid(),
        $1::uuid,
        $2::text,
        $3::uuid,
        $4::text,
        $5::uuid,
        $6::uuid,
        $7::text,
        $8::integer,
        $9::integer,
        'OPEN',
        now(),
        $10::text,
        $11::text
      )
    `,
    [
      orgId,
      checkoutId,
      allocation.id,
      asTrimmedString(selectedJob.job_number),
      allocation.product_id,
      allocation.owner_company_id,
      currentWarehouse,
      checkoutTubes,
      overageTubes,
      normalizedActor,
      notes,
    ]
  );

  await client.query(
    `
      update app.caulk_job_allocations
      set
        reserved_tubes_remaining = greatest(reserved_tubes_remaining - $3::integer, 0),
        checked_out_tubes_total = checked_out_tubes_total + $4::integer,
        overage_tubes_total = overage_tubes_total + $5::integer,
        updated_at = now(),
        updated_by = $6::text
      where id = $1::uuid
        and org_id = $2::uuid
    `,
    [allocation.id, orgId, consumeReserved, checkoutTubes, overageTubes, normalizedActor]
  );

  return {
    result: {
      jobId: asTrimmedString(selectedJob.id),
      jobNumber: asTrimmedString(selectedJob.job_number),
      caulkAllocationId,
      caulkCheckoutId: checkoutId,
      productId: asTrimmedString(allocation.product_id),
      warehouse: currentWarehouse,
      warnings: [],
    },
    warnings: [],
  };
}

export function checkinCaulkAllocation(client, orgId, actor, payload) {
  return callCaulkAllocationMutation(client, 'public.api_acl_allocations_caulk_checkin', orgId, actor, payload);
}

export function removeCaulkAllocation(client, orgId, actor, payload) {
  return callCaulkAllocationMutation(client, 'public.api_acl_allocations_caulk_remove', orgId, actor, payload);
}

export async function receiveCaulkTransfer(client, orgId, actor, payload) {
  await requireInventoryWriteAccess(client, orgId);

  const transferId = asTrimmedString(payload?.transferId);
  if (!transferId) {
    throw new HttpError(400, 'transferId is required.');
  }

  const transfer = await requireLockedTransfer(client, orgId, transferId);
  const allocation = await requireLockedAllocationByRowId(client, orgId, transfer.caulk_allocation_id);
  const selectedJob = await requireCaulkAllocationJobById(
    client,
    orgId,
    allocation.job_id,
    `Job for caulk transfer ${transfer.transfer_id} was not found.`
  );
  const result = await receivePendingCaulkTransferInternal(client, orgId, actor, transfer, allocation, selectedJob);
  return buildTransferMutationResponse(
    result.jobNumber || allocation.job_number,
    result.caulkAllocationId || allocation.caulk_allocation_id,
    result.transferId,
    result.warnings,
    {
      jobId: result.jobId,
      productId: result.productId,
      sourceWarehouse: result.sourceWarehouse,
      destinationWarehouse: result.destinationWarehouse,
    }
  );
}

export async function cancelCaulkTransfer(client, orgId, actor, payload) {
  await requireInventoryWriteAccess(client, orgId);

  const transferId = asTrimmedString(payload?.transferId);
  if (!transferId) {
    throw new HttpError(400, 'transferId is required.');
  }

  const transfer = await requireLockedTransfer(client, orgId, transferId);
  const allocation = await requireLockedAllocationByRowId(client, orgId, transfer.caulk_allocation_id);
  const selectedJob = await requireCaulkAllocationJobById(
    client,
    orgId,
    allocation.job_id,
    `Job for caulk transfer ${transfer.transfer_id} was not found.`
  );
  const result = await cancelPendingCaulkTransferInternal(
    client,
    orgId,
    actor,
    transfer,
    allocation,
    selectedJob,
    asTrimmedString(payload?.reason)
  );
  return buildTransferMutationResponse(
    result.jobNumber || allocation.job_number,
    result.caulkAllocationId || allocation.caulk_allocation_id,
    result.transferId,
    result.warnings,
    {
      jobId: result.jobId,
      productId: result.productId,
      sourceWarehouse: result.sourceWarehouse,
      destinationWarehouse: result.destinationWarehouse,
    }
  );
}
