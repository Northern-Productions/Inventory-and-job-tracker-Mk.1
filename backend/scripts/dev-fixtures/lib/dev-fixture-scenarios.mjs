import { createHash } from 'node:crypto';
import { withMutation, withReadClient, queryRow, queryRows } from '../../../src/db/client.mjs';
import { createJob, buildJobDetailById } from '../../../src/app/services/jobs.mjs';
import {
  addBox,
  updateBox,
  setBoxStatus,
  startBoxTransfer,
} from '../../../src/app/services/boxes.mjs';
import {
  applyAllocationPlan,
  removeAllocationFromJob,
} from '../../../src/app/services/allocations.mjs';
import { mutateCaulkStock } from '../../../src/app/services/caulk.mjs';
import { addCaulkAllocation } from '../../../src/app/services/caulkAllocations.mjs';
import {
  FixtureSafetyError,
  PENDING_TRANSFER_CHECKOUT_SCENARIO,
  asText,
  assertFixtureDealerAvailable,
  buildFixtureDealerIdentity,
  isUuidLike,
  normalizeFixtureTag,
} from './dev-fixture-guard.mjs';
import {
  PENDING_TRANSFER_STAGE_BUDGETS,
  assertPendingTransferManifestIdBudget,
  assertPendingTransferStageBudget,
  dealerTableIntegrityMatches,
  normalizePendingTransferCleanupIdentity,
  normalizeFixtureIdentity,
  assertSafeFixtureIdentity,
} from './dev-fixture-cleanup-safety.mjs';
import {
  V3_BASELINE_CANONICALIZATION_VERSION,
  V3_BASELINE_EVIDENCE_TYPE,
  V3_BASELINE_HASH_ALGORITHM,
  V3_BASELINE_SCOPE,
  V3_BASELINE_SERIALIZATION_POLICY,
  acquireV3LifecycleLock,
  assertBaselineEvidenceEqual,
  buildV3Transition,
  createCleanupAttemptMarker,
  createCommitAmbiguityMarker,
  createRecoveryMarker,
  normalizeBaselineEvidence,
  normalizeV3Manifest,
  publishInitialV3Manifest,
  readV3ManifestInternal,
  releaseV3LifecycleLock,
  replaceV3Manifest,
} from './dev-fixture-manifest.mjs';
import {
  buildCanonicalRowExpression,
  buildTableAggregateSql,
  normalizeAggregateResult,
  quoteIdentifier,
  resolveDigestFunction,
} from '../../lib/release-integrity.mjs';

const WAREHOUSE_FALLBACK = 'IL1';
const CORE_TYPE = 'White plastic';
const DEALER_TABLE = Object.freeze({ schema: 'app', table: 'box_dealers' });
const PENDING_BASELINE_TABLES = Object.freeze([
  { name: 'nonfixture.app.caulk_manufacturers', table: 'caulk_manufacturers', exclusions: [['id', 'manufacturerIds', 'uuid']] },
  { name: 'nonfixture.app.caulk_products', table: 'caulk_products', exclusions: [['id', 'productIds', 'uuid']] },
  { name: 'nonfixture.app.caulk_stock', table: 'caulk_stock', exclusions: [['id', 'caulkStockIds', 'uuid']] },
  { name: 'nonfixture.app.caulk_transactions', table: 'caulk_transactions', exclusions: [['id', 'caulkTransactionIds', 'uuid']] },
  { name: 'nonfixture.app.caulk_transfers', table: 'caulk_transfers', exclusions: [['id', 'caulkTransferRowIds', 'uuid']] },
  { name: 'nonfixture.app.job_caulk_requirements', table: 'job_caulk_requirements', exclusions: [['id', 'caulkRequirementIds', 'uuid']] },
  { name: 'nonfixture.app.caulk_job_allocations', table: 'caulk_job_allocations', exclusions: [['id', 'caulkAllocationRowIds', 'uuid']] },
  { name: 'nonfixture.app.caulk_job_checkouts', table: 'caulk_job_checkouts', exclusions: [['caulk_allocation_id', 'caulkAllocationRowIds', 'uuid']] },
  { name: 'nonfixture.app.box_dealers', table: 'box_dealers', exclusions: [['id', 'dealerIds', 'uuid']] },
  { name: 'nonfixture.app.film_catalog', table: 'film_catalog', exclusions: [['id', 'filmCatalogIds', 'uuid']] },
  { name: 'nonfixture.app.boxes', table: 'boxes', exclusions: [['id', 'boxRecordIds', 'uuid'], ['box_id', 'boxIds', 'text']] },
  { name: 'nonfixture.app.jobs', table: 'jobs', exclusions: [['id', 'jobIds', 'uuid']] },
  { name: 'nonfixture.app.job_phases', table: 'job_phases', exclusions: [['id', 'phaseIds', 'uuid']] },
  { name: 'nonfixture.app.job_requirements', table: 'job_requirements', exclusions: [['id', 'requirementIds', 'uuid']] },
  { name: 'nonfixture.app.allocations', table: 'allocations', exclusions: [['allocation_id', 'allocationIds', 'text']] },
  { name: 'nonfixture.app.audit_log', table: 'audit_log', exclusions: [['id', 'auditLogIds', 'uuid']] },
  { name: 'nonfixture.app.allocation_planner_suppressions', table: 'allocation_planner_suppressions', exclusions: [['job_id', 'jobIds', 'uuid'], ['requirement_id', 'requirementIds', 'uuid'], ['source_allocation_id', 'allocationIds', 'text']] },
  { name: 'nonfixture.app.roll_weight_log', table: 'roll_weight_log', exclusions: [['box_id', 'boxIds', 'text'], ['job_id', 'jobIds', 'uuid']] },
  { name: 'nonfixture.app.box_id_aliases', table: 'box_id_aliases', exclusions: [['old_box_id', 'boxIds', 'text'], ['canonical_box_id', 'boxIds', 'text']] },
  { name: 'nonfixture.app.box_transfers', table: 'box_transfers', exclusions: [['box_record_id', 'boxRecordIds', 'uuid'], ['source_box_id', 'boxIds', 'text'], ['destination_box_id', 'boxIds', 'text']] },
  { name: 'nonfixture.app.film_orders', table: 'film_orders', exclusions: [['job_id', 'jobIds', 'uuid'], ['job_number', 'jobNumbers', 'text']] },
  { name: 'nonfixture.app.film_order_box_links', table: 'film_order_box_links', exclusions: [['box_id', 'boxIds', 'text']] },
  { name: 'nonfixture.app.film_order_events', table: 'film_order_events', exclusions: [['related_box_id', 'boxIds', 'text'], ['related_requirement_id', 'requirementIds', 'uuid']] },
  { name: 'reference.app.warehouses', table: 'warehouses', exclusions: [] },
  { name: 'reference.app.owner_companies', table: 'owner_companies', exclusions: [] },
]);

const EMPTY_PENDING_IDS = Object.freeze({
  manufacturerIds: [],
  productIds: [],
  caulkStockIds: [],
  caulkTransactionIds: [],
  caulkTransferRowIds: [],
  caulkTransferIds: [],
  caulkRequirementIds: [],
  caulkAllocationRowIds: [],
  caulkAllocationIds: [],
  dealerIds: [],
  filmCatalogIds: [],
  boxRecordIds: [],
  boxIds: [],
  jobIds: [],
  jobNumbers: [],
  phaseIds: [],
  requirementIds: [],
  allocationIds: [],
  auditLogIds: [],
});

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function safeSha256(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function safeProjection(name, rows) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  return {
    name,
    count: normalizedRows.length,
    digest: safeSha256(normalizedRows),
  };
}

function assertPendingEdgeMetadata(config) {
  const metadata = config.edgeMetadata || {};
  if (
    !/^v?\d+$/.test(asText(metadata.version)) ||
    asText(metadata.status).toUpperCase() !== 'ACTIVE' ||
    asText(metadata.verifyJwt).toLowerCase() !== 'false' ||
    !/^(?:sha256:)?[a-f0-9]{64}$/.test(asText(metadata.bodyDigest).toLowerCase())
  ) {
    throw new FixtureSafetyError(
      'DEV_EDGE_METADATA_INVALID',
      'Guarded DEV Edge metadata is incomplete or invalid.'
    );
  }
  return {
    version: asText(metadata.version).replace(/^v/i, ''),
    status: 'ACTIVE',
    verifyJwt: 'false',
    bodyDigest: asText(metadata.bodyDigest).toLowerCase().replace(/^sha256:/, ''),
  };
}

async function listProjectionColumns(client, table) {
  const rows = await queryRows(
    client,
    `
      select column_name::text as column_name
      from information_schema.columns
      where table_schema = 'app'
        and table_name = $1::text
      order by ordinal_position
    `,
    [table]
  );
  const columns = rows.map((row) => asText(row.column_name)).filter(Boolean);
  if (!columns.length) {
    throw new FixtureSafetyError('BASELINE_TABLE_UNAVAILABLE', 'A baseline table is unavailable.');
  }
  return columns;
}

function buildPendingBaselineExclusion(spec, ids, params) {
  const matchClauses = [];
  for (const [column, group, cast] of spec.exclusions) {
    const values = Array.isArray(ids[group]) ? ids[group] : [];
    params.push(values);
    matchClauses.push(`source_row.${quoteIdentifier(column)} = any($${params.length}::${cast}[])`);
  }
  const matchExpression = matchClauses.length ? `(${matchClauses.join(' or ')})` : 'false';
  return `and ${matchExpression} is not true`;
}

async function captureTableProjection(client, orgId, ids, spec, digestFunction) {
  const columns = await listProjectionColumns(client, spec.table);
  const canonicalExpression = buildCanonicalRowExpression(
    { schema: 'app', table: spec.table },
    columns
  );
  const params = [orgId];
  const exclusion = buildPendingBaselineExclusion(spec, ids, params);
  const result = await client.query(
    `
      with canonical_rows as (
        select pg_catalog.encode(
          ${digestFunction}(
            pg_catalog.convert_to((${canonicalExpression})::text, 'UTF8'),
            'sha256'
          ),
          'hex'
        ) as row_digest
        from ${quoteIdentifier('app')}.${quoteIdentifier(spec.table)} as source_row
        where source_row.org_id = $1::uuid
          ${exclusion}
      ), aggregate_payload as (
        select
          pg_catalog.count(*)::text as row_count,
          coalesce(pg_catalog.string_agg(row_digest, '' order by row_digest), '') as digest_payload
        from canonical_rows
      )
      select
        row_count,
        pg_catalog.encode(
          ${digestFunction}(pg_catalog.convert_to(digest_payload, 'UTF8'), 'sha256'),
          'hex'
        ) as fingerprint
      from aggregate_payload
    `,
    params
  );
  const normalized = normalizeAggregateResult(result, { schema: 'app', table: spec.table });
  return {
    name: spec.name,
    count: normalized.rowCount,
    digest: normalized.fingerprint,
  };
}

async function capturePendingFixtureBaseline(client, config, ids = EMPTY_PENDING_IDS) {
  const digestFunction = await resolveDigestFunction(client);
  const projections = [];
  for (const spec of PENDING_BASELINE_TABLES) {
    projections.push(await captureTableProjection(client, config.orgId, ids, spec, digestFunction));
  }

  const schemaRows = await queryRows(
    client,
    `
      select table_schema::text, table_name::text, ordinal_position::integer,
             column_name::text, data_type::text, is_nullable::text
      from information_schema.columns
      where table_schema = 'app'
        and table_name = any($1::text[])
      order by table_schema, table_name, ordinal_position
    `,
    [PENDING_BASELINE_TABLES.map((entry) => entry.table)]
  );
  projections.push(safeProjection('state.schema', schemaRows));

  const migrationRows = await queryRows(
    client,
    `
      select version::text as version
      from supabase_migrations.schema_migrations
      order by version
    `
  );
  projections.push(safeProjection('state.migrations', migrationRows));
  projections.push(safeProjection('state.dev_target', [{ projectRef: config.projectRef }]));
  projections.push(safeProjection('state.dev_edge', [assertPendingEdgeMetadata(config)]));

  const quarantineRows = await queryRows(
    client,
    `
      select b.box_id::text as identity
      from app.boxes b
      where b.org_id = $1::uuid
        and not (b.box_id = any($2::text[]))
        and exists (
          select 1
          from app.box_transfers t
          where t.org_id = b.org_id
            and t.box_record_id = b.id
            and t.status = 'PENDING'
        )
      order by b.box_id
    `,
    [config.orgId, ids.boxIds || []]
  );
  projections.push(safeProjection('risk.atomic_transfer_quarantine', quarantineRows));

  return normalizeBaselineEvidence({
    evidenceType: V3_BASELINE_EVIDENCE_TYPE,
    canonicalizationVersion: V3_BASELINE_CANONICALIZATION_VERSION,
    serializationPolicy: V3_BASELINE_SERIALIZATION_POLICY,
    hashAlgorithm: V3_BASELINE_HASH_ALGORITHM,
    projections,
  });
}

async function countPendingTransferFixture(client, manifest) {
  const ids = manifest.ids;
  const row = await queryRow(
    client,
    `
      select jsonb_build_object(
        'manufacturers', (select count(*)::integer from app.caulk_manufacturers where org_id = $1::uuid and id = any($2::uuid[])),
        'products', (select count(*)::integer from app.caulk_products where org_id = $1::uuid and id = any($3::uuid[])),
        'caulkStock', (select count(*)::integer from app.caulk_stock where org_id = $1::uuid and id = any($4::uuid[])),
        'caulkRequirements', (select count(*)::integer from app.job_caulk_requirements where org_id = $1::uuid and id = any($5::uuid[])),
        'caulkAllocations', (select count(*)::integer from app.caulk_job_allocations where org_id = $1::uuid and id = any($6::uuid[])),
        'pendingCaulkTransfers', (select count(*)::integer from app.caulk_transfers where org_id = $1::uuid and id = any($7::uuid[]) and status = 'PENDING'),
        'dealers', (select count(*)::integer from app.box_dealers where org_id = $1::uuid and id = any($8::uuid[])),
        'filmCatalog', (select count(*)::integer from app.film_catalog where org_id = $1::uuid and id = any($9::uuid[])),
        'boxes', (select count(*)::integer from app.boxes where org_id = $1::uuid and id = any($10::uuid[])),
        'jobs', (select count(*)::integer from app.jobs where org_id = $1::uuid and id = any($11::uuid[])),
        'phases', (select count(*)::integer from app.job_phases where org_id = $1::uuid and id = any($12::uuid[])),
        'filmRequirements', (select count(*)::integer from app.job_requirements where org_id = $1::uuid and id = any($13::uuid[])),
        'filmAllocations', (select count(*)::integer from app.allocations where org_id = $1::uuid and job_id = any($11::uuid[]) and box_id = any($14::text[]) and requirement_id = any($13::uuid[])),
        'receiveTransactions', (select count(*)::integer from app.caulk_transactions where org_id = $1::uuid and product_id = any($3::uuid[]) and action = 'RECEIVE'),
        'jobAllocateTransactions', (select count(*)::integer from app.caulk_transactions where org_id = $1::uuid and product_id = any($3::uuid[]) and action = 'JOB_ALLOCATE'),
        'transferOutTransactions', (select count(*)::integer from app.caulk_transactions where org_id = $1::uuid and product_id = any($3::uuid[]) and action = 'TRANSFER_OUT'),
        'addBoxAudit', (select count(*)::integer from app.audit_log where org_id = $1::uuid and box_id = any($14::text[]) and action = 'ADD_BOX'),
        'setStatusAudit', (select count(*)::integer from app.audit_log where org_id = $1::uuid and box_id = any($14::text[]) and action = 'SET_STATUS'),
        'unexpectedAudit', (select count(*)::integer from app.audit_log where org_id = $1::uuid and (box_id = any($14::text[]) or actor = $17::text or notes = $17::text) and not (id = any($18::uuid[]))),
        'caulkCheckouts', (select count(*)::integer from app.caulk_job_checkouts where org_id = $1::uuid and caulk_allocation_id = any($6::uuid[])),
        'plannerSuppressions', (select count(*)::integer from app.allocation_planner_suppressions where org_id = $1::uuid and (job_id = any($11::uuid[]) or requirement_id = any($13::uuid[]) or source_allocation_id = any($15::text[]))),
        'rollHistory', (select count(*)::integer from app.roll_weight_log where org_id = $1::uuid and (box_id = any($14::text[]) or job_id = any($11::uuid[]))),
        'aliases', (select count(*)::integer from app.box_id_aliases where org_id = $1::uuid and (old_box_id = any($14::text[]) or canonical_box_id = any($14::text[]))),
        'boxTransfers', (select count(*)::integer from app.box_transfers where org_id = $1::uuid and (source_box_id = any($14::text[]) or destination_box_id = any($14::text[]))),
        'filmOrders', (select count(*)::integer from app.film_orders where org_id = $1::uuid and (job_id = any($11::uuid[]) or job_number = any($16::text[]))),
        'filmOrderLinks', (select count(*)::integer from app.film_order_box_links where org_id = $1::uuid and box_id = any($14::text[])),
        'filmOrderEvents', (select count(*)::integer from app.film_order_events where org_id = $1::uuid and (related_box_id = any($14::text[]) or related_requirement_id = any($13::uuid[])))
      ) as counts
    `,
    [
      manifest.orgId,
      ids.manufacturerIds,
      ids.productIds,
      ids.caulkStockIds,
      ids.caulkRequirementIds,
      ids.caulkAllocationRowIds,
      ids.caulkTransferRowIds,
      ids.dealerIds,
      ids.filmCatalogIds,
      ids.boxRecordIds,
      ids.jobIds,
      ids.phaseIds,
      ids.requirementIds,
      ids.boxIds,
      ids.allocationIds,
      ids.jobNumbers,
      manifest.tag,
      ids.auditLogIds,
    ]
  );
  return Object.fromEntries(
    Object.entries(row?.counts || {}).map(([key, value]) => [key, integer(value)])
  );
}

async function assertPendingFilmBoxTopology(client, manifest) {
  const row = await queryRow(
    client,
    `
      select
        b.status::text as status,
        b.warehouse::text as box_warehouse,
        j.warehouse::text as job_warehouse,
        b.width_in::numeric as width_in,
        b.initial_feet::integer as initial_feet,
        count(a.id)::integer as allocation_count,
        count(t.id)::integer as transfer_count
      from app.boxes b
      join app.jobs j on j.org_id = b.org_id and j.id = $3::uuid
      left join app.allocations a on a.org_id = b.org_id and a.box_id = b.box_id and a.status = 'ACTIVE'
      left join app.box_transfers t on t.org_id = b.org_id and t.box_record_id = b.id and t.status = 'PENDING'
      where b.org_id = $1::uuid and b.box_id = $2::text
      group by b.status, b.warehouse, j.warehouse, b.width_in, b.initial_feet
    `,
    [manifest.orgId, manifest.ids.boxIds[0], manifest.ids.jobIds[0]]
  );
  if (
    asText(row?.status).toUpperCase() !== 'IN_STOCK' ||
    asText(row?.box_warehouse).toUpperCase() !== asText(row?.job_warehouse).toUpperCase() ||
    Number(row?.width_in) !== 60 ||
    integer(row?.initial_feet) !== 80 ||
    integer(row?.allocation_count) !== 0 ||
    integer(row?.transfer_count) !== 0
  ) {
    throw new FixtureSafetyError('FILM_TOPOLOGY_INVALID', 'Synthetic film topology is invalid.');
  }
  return true;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shortTag(tag) {
  return asText(tag).replace(/[^A-Z0-9]/gi, '').slice(-10);
}

function numericSuffix(tag) {
  return shortTag(tag).replace(/\D/g, '').slice(-7).padStart(7, '0');
}

function buildJobNumber(tag, offset = 0) {
  const base = Number(numericSuffix(tag).slice(-6)) || Math.floor(Math.random() * 900000) + 100000;
  return String(70_000_000 + ((base + offset) % 9_000_000));
}

function buildBoxId(warehouse, code, tag) {
  return `${warehouse}-${code}-${shortTag(tag).slice(-7)}`.toUpperCase();
}

function buildJobRoute(jobId) {
  return `/#/allocations/jobs/${jobId}`;
}

function buildBoxRoute(boxId) {
  return `/#/inventory/${encodeURIComponent(boxId)}`;
}

async function chooseWarehouse(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select code::text as code
      from app.warehouses
      where org_id = $1::uuid
      order by case when upper(code::text) = $2 then 0 else 1 end, code
    `,
    [orgId, WAREHOUSE_FALLBACK]
  );
  const warehouse = asText(rows[0]?.code).toUpperCase();
  if (!warehouse) {
    throw new Error('No configured DEV warehouse was found.');
  }
  return warehouse;
}

async function chooseWarehousePair(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select code::text as code
      from app.warehouses
      where org_id = $1::uuid
      order by case when upper(code::text) = $2 then 0 else 1 end, code
    `,
    [orgId, WAREHOUSE_FALLBACK]
  );
  const warehouses = rows.map((row) => asText(row.code).toUpperCase()).filter(Boolean);
  if (warehouses.length < 2) {
    throw new Error('The atomic transfer fixture requires two configured DEV warehouses.');
  }
  return {
    sourceWarehouse: warehouses[0],
    destinationWarehouse: warehouses[1],
  };
}

async function chooseOwnerCompanyId(client, orgId, warehouse) {
  const row = await queryRow(
    client,
    `
      select owner.id::text as owner_company_id
      from app.owner_companies owner
      where owner.org_id = $1::uuid
        and owner.id = app_api.default_owner_company_id_for_warehouse($1::uuid, $2::text)
        and owner.is_active = true
      limit 1
    `,
    [orgId, warehouse]
  );
  const ownerCompanyId = asText(row?.owner_company_id);
  if (!ownerCompanyId) {
    throw new Error('No active default owner company is configured for the DEV fixture warehouse.');
  }
  return ownerCompanyId;
}

async function captureDealerTableIntegrity(client) {
  const columns = await queryRows(
    client,
    `
      select column_name::text as column_name
      from information_schema.columns
      where table_schema = 'app'
        and table_name = 'box_dealers'
      order by ordinal_position
    `
  );
  const columnNames = columns.map((row) => asText(row.column_name)).filter(Boolean);
  const digestFunction = await resolveDigestFunction(client);
  const result = await client.query(
    buildTableAggregateSql(DEALER_TABLE, columnNames, digestFunction)
  );
  return normalizeAggregateResult(result, DEALER_TABLE);
}

async function prepareFixtureDealer(config, tag) {
  const fixtureDealer = buildFixtureDealerIdentity(tag);
  return withReadClient(async (client) => {
    await client.query('begin transaction isolation level repeatable read read only');
    try {
      await client.query("set local timezone = 'UTC'");
      await client.query("set local statement_timeout = '30s'");
      await client.query("set local lock_timeout = '3s'");
      const collision = await queryRow(
        client,
        `
          select
            count(*) filter (where lookup_key = $2::text)::integer as code_matches,
            count(*) filter (where name = $3::text)::integer as name_matches
          from app.box_dealers
          where org_id = $1::uuid
        `,
        [config.orgId, fixtureDealer.code, fixtureDealer.name]
      );
      assertFixtureDealerAvailable({
        codeMatches: collision?.code_matches,
        nameMatches: collision?.name_matches,
      });
      return {
        fixtureDealer,
        dealerTableBefore: await captureDealerTableIntegrity(client),
      };
    } finally {
      await client.query('rollback');
    }
  });
}

async function createFixtureDealer(client, orgId, fixtureDealer) {
  const row = await queryRow(
    client,
    `
      insert into app.box_dealers (org_id, name, lookup_key)
      values ($1::uuid, $2::text, $3::text)
      returning id::text as id, name::text as name, lookup_key::text as code
    `,
    [orgId, fixtureDealer.name, fixtureDealer.code]
  );
  if (!row?.id || row.name !== fixtureDealer.name || row.code !== fixtureDealer.code) {
    throw new Error('Tagged fixture dealer was not created exactly as requested.');
  }
  return row;
}

async function applyFixtureSessionContext(client, config) {
  const smokeUserEmail = asText(config.smokeUserEmail);
  const identity = await queryRow(
    client,
    `
      select
        u.id::text as user_id,
        ($2::text <> '' and lower(u.email) = lower($2::text)) as matched_smoke_user
      from auth.users u
      join app.organization_members member
        on member.user_id = u.id
       and member.org_id = $1::uuid
       and member.status = 'active'
      order by
        case when $2::text <> '' and lower(u.email) = lower($2::text) then 0 else 1 end,
        case lower(member.role::text) when 'owner' then 0 when 'admin' then 1 else 2 end,
        u.id
      limit 1
    `,
    [config.orgId, smokeUserEmail]
  );
  const userId = asText(identity?.user_id);
  if (!userId) {
    throw new Error('No active authenticated member is available for the DEV fixture organization.');
  }

  const claimEmail = identity?.matched_smoke_user ? smokeUserEmail : '';
  const claimsPayload = {
    sub: userId,
    role: 'authenticated',
  };
  if (claimEmail) {
    claimsPayload.email = claimEmail;
  }
  const claims = JSON.stringify(claimsPayload);
  await client.query(
    `
      select
        set_config('request.jwt.claim.sub', $1::text, true),
        set_config('request.jwt.claim.role', 'authenticated', true),
        set_config('request.jwt.claim.email', $2::text, true),
        set_config('request.jwt.claims', $3::text, true),
        set_config('app.actor', $4::text, true)
    `,
    [userId, claimEmail, claims, 'codex-dev-fixture']
  );
}

async function withFixtureMutation(config, callback) {
  return withMutation(async (client) => {
    await applyFixtureSessionContext(client, config);
    return callback(client);
  });
}

function boxPayload({
  boxId,
  warehouse,
  ownerCompanyId,
  dealerName,
  tag,
  manufacturer,
  filmName,
  widthIn = 60,
  initialFeet = 80,
}) {
  const currentDate = today();
  return {
    boxId,
    warehouse,
    ownerCompanyId,
    dealer: dealerName,
    manufacturer,
    filmName,
    widthIn,
    initialFeet,
    orderDate: currentDate,
    receivedDate: currentDate,
    coreType: CORE_TYPE,
    initialWeightLbs: 18,
    lastRollWeightLbs: 18,
    lastWeighedDate: currentDate,
    lotRun: tag,
    notes: tag,
    auditNote: tag,
  };
}

function jobPayload({
  jobNumber,
  warehouse,
  tag,
  manufacturer,
  filmName,
  requiredFeet,
  installOffset = 3,
  installDate: installDateInput,
  crewLeader: crewLeaderInput,
  workflowStatus = 'ACTIVE',
  caulkProductId = '',
  caulkRequiredTubes = 0,
}) {
  const installDate =
    installDateInput === undefined ? addDays(today(), installOffset) : asText(installDateInput);
  const crewLeader =
    crewLeaderInput === undefined
      ? installDate
        ? `Codex Fixture ${shortTag(tag)}`
        : ''
      : asText(crewLeaderInput);
  return {
    jobNumber,
    warehouse,
    installDate,
    crewLeader,
    workScope: tag,
    notes: tag,
    phases: [
      {
        phaseNumber: 1,
        workScope: tag,
        installDate,
        crewLeader,
        workflowStatus,
        requirements: [
          {
            manufacturer,
            filmName,
            widthIn: 60,
            requiredFeet,
            notes: tag,
          },
        ],
        ...(caulkProductId && caulkRequiredTubes > 0
          ? {
              caulkRequirements: [
                {
                  productId: caulkProductId,
                  requiredTubes: caulkRequiredTubes,
                  notes: tag,
                },
              ],
            }
          : {}),
      },
    ],
  };
}

function firstRequirement(jobDetail) {
  const requirement = (jobDetail?.requirements || [])[0];
  if (!requirement?.requirementId) {
    throw new Error('Created fixture job did not return a film requirement.');
  }
  return requirement;
}

function firstPhaseId(jobDetail) {
  return asText((jobDetail?.phases || [])[0]?.phaseId);
}

async function addFixtureBox(client, orgId, payload, tag) {
  const response = await addBox(client, orgId, payload, tag);
  return response.data?.box || response.box || response.data;
}

async function createFixtureJob(client, orgId, payload, tag) {
  const response = await createJob(client, orgId, payload, tag);
  return response.data;
}

async function allocateFixtureBox(
  client,
  orgId,
  { jobDetail, boxId, requestedFeet, tag, crossWarehouse = false, jobWarehouse = '' }
) {
  const requirement = firstRequirement(jobDetail);
  const response = await applyAllocationPlan(
    client,
    orgId,
    {
      jobId: jobDetail.summary.jobId,
      jobNumber: jobDetail.summary.jobNumber,
      boxId,
      requestedFeet,
      requestedWidthIn: requirement.widthIn,
      requirementId: requirement.requirementId,
      selectedSuggestionBoxIds: [],
      extraAllocations: [],
      crossWarehouse,
      ...(jobWarehouse ? { jobWarehouse } : {}),
      autoAllocate: false,
    },
    tag
  );
  return response.data?.allocations || [];
}

async function checkoutFixtureBox(client, orgId, { boxId, jobId, tag }) {
  const response = await setBoxStatus(
    client,
    orgId,
    {
      boxId,
      status: 'CHECKED_OUT',
      jobId,
      auditNote: `${tag} checked out for fixture job`,
    },
    tag
  );
  return response.data?.box || response.data;
}

async function fetchCanonicalAllocationState(client, orgId, boxIds) {
  const rows = await queryRows(
    client,
    `
      select
        state.box_id,
        state.status,
        state.warehouse,
        state.physical_feet,
        state.reserved_feet,
        state.reservation_count,
        state.planning_feet,
        state.pending_transfer
      from app_api.allocation_apply_box_states_0192($1::uuid, $2::text[]) state
      order by state.box_id
    `,
    [orgId, boxIds]
  );
  return Object.fromEntries(rows.map((row) => [asText(row.box_id), row]));
}

async function zeroFixtureBox(client, orgId, { existingBoxPayload, tag }) {
  const response = await updateBox(
    client,
    orgId,
    {
      ...existingBoxPayload,
      currentFeetOnRoll: 0,
      lastRollWeightLbs: 0,
      lastWeighedDate: today(),
      moveToZeroed: true,
      auditNote: `${tag} zeroed exclusion fixture`,
    },
    tag
  );
  return response.data?.box || response.data;
}

async function createCheckedOutBoxJob(config, tag, dealerPreflight) {
  return withFixtureMutation(config, async (client) => {
    const fixtureDealer = await createFixtureDealer(
      client,
      config.orgId,
      dealerPreflight.fixtureDealer
    );
    const warehouse = await chooseWarehouse(client, config.orgId);
    const ownerCompanyId = await chooseOwnerCompanyId(client, config.orgId, warehouse);
    const manufacturer = 'Codex Fixture';
    const filmName = `Checked Out Job ${shortTag(tag)}`;
    const boxId = buildBoxId(warehouse, 'CDF', tag);
    const jobNumber = buildJobNumber(tag, 1);

    await addFixtureBox(
      client,
      config.orgId,
      boxPayload({
        boxId,
        warehouse,
        ownerCompanyId,
        dealerName: fixtureDealer.name,
        tag,
        manufacturer,
        filmName,
        initialFeet: 45,
      }),
      tag
    );
    let jobDetail = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({ jobNumber, warehouse, tag, manufacturer, filmName, requiredFeet: 35 }),
      tag
    );
    const requirement = firstRequirement(jobDetail);
    const allocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail,
      boxId,
      requestedFeet: 35,
      tag,
    });
    const checkedOutBox = await checkoutFixtureBox(client, config.orgId, {
      boxId,
      jobId: jobDetail.summary.jobId,
      tag,
    });
    jobDetail = await buildJobDetailById(client, config.orgId, jobDetail.summary.jobId);

    return buildManifest({
      config,
      tag,
      scenario: 'checked-out-box-job',
      jobDetail,
      phaseId: firstPhaseId(jobDetail),
      requirementIds: [requirement.requirementId],
      allocationIds: allocations.map((entry) => entry.allocationId),
      boxIds: [boxId],
      fixtureDealer,
      dealerTableBefore: dealerPreflight.dealerTableBefore,
      summary: {
        jobId: jobDetail.summary.jobId,
        jobNumber,
        boxId,
        boxStatus: checkedOutBox?.status || 'CHECKED_OUT',
        lastCheckoutJobId: checkedOutBox?.lastCheckoutJobId || jobDetail.summary.jobId,
        lastCheckoutJob: checkedOutBox?.lastCheckoutJob || jobNumber,
      },
    });
  });
}

async function createAllocationEligibility(config, tag, dealerPreflight) {
  return withFixtureMutation(config, async (client) => {
    const fixtureDealer = await createFixtureDealer(
      client,
      config.orgId,
      dealerPreflight.fixtureDealer
    );
    const warehouse = await chooseWarehouse(client, config.orgId);
    const ownerCompanyId = await chooseOwnerCompanyId(client, config.orgId, warehouse);
    const manufacturer = 'Codex Fixture';
    const filmName = `Allocation Eligibility ${shortTag(tag)}`;
    const checkedOutBoxId = buildBoxId(warehouse, 'CDE', tag);
    const zeroedBoxId = buildBoxId(warehouse, 'CDZ', tag);
    const checkoutJobNumber = buildJobNumber(tag, 11);
    const targetJobNumber = buildJobNumber(tag, 12);

    await addFixtureBox(
      client,
      config.orgId,
      boxPayload({
        boxId: checkedOutBoxId,
        warehouse,
        ownerCompanyId,
        dealerName: fixtureDealer.name,
        tag,
        manufacturer,
        filmName,
        initialFeet: 80,
      }),
      tag
    );
    let checkoutJobDetail = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: checkoutJobNumber,
        warehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 25,
        installOffset: 2,
      }),
      tag
    );
    const checkoutRequirement = firstRequirement(checkoutJobDetail);
    const checkoutAllocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail: checkoutJobDetail,
      boxId: checkedOutBoxId,
      requestedFeet: 25,
      tag,
    });
    await checkoutFixtureBox(client, config.orgId, {
      boxId: checkedOutBoxId,
      jobId: checkoutJobDetail.summary.jobId,
      tag,
    });
    checkoutJobDetail = await buildJobDetailById(client, config.orgId, checkoutJobDetail.summary.jobId);

    const targetJobDetail = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: targetJobNumber,
        warehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 30,
        installOffset: 5,
      }),
      tag
    );
    const targetRequirement = firstRequirement(targetJobDetail);

    const zeroedPayload = boxPayload({
      boxId: zeroedBoxId,
      warehouse,
      ownerCompanyId,
      dealerName: fixtureDealer.name,
      tag,
      manufacturer,
      filmName,
      initialFeet: 50,
    });
    await addFixtureBox(client, config.orgId, zeroedPayload, tag);
    const zeroedBox = await zeroFixtureBox(client, config.orgId, {
      existingBoxPayload: zeroedPayload,
      tag,
    });

    const checkedOutState = await fetchBoxPlanningState(client, config.orgId, checkedOutBoxId);
    const zeroedState = await fetchBoxPlanningState(client, config.orgId, zeroedBoxId);

    return buildManifest({
      config,
      tag,
      scenario: 'allocation-eligibility',
      jobDetail: targetJobDetail,
      extraJobDetails: [checkoutJobDetail],
      phaseId: firstPhaseId(targetJobDetail),
      requirementIds: [
        checkoutRequirement.requirementId,
        targetRequirement.requirementId,
      ],
      allocationIds: checkoutAllocations.map((entry) => entry.allocationId),
      boxIds: [checkedOutBoxId, zeroedBoxId],
      fixtureDealer,
      dealerTableBefore: dealerPreflight.dealerTableBefore,
      summary: {
        targetJobId: targetJobDetail.summary.jobId,
        targetJobNumber,
        checkoutJobId: checkoutJobDetail.summary.jobId,
        checkoutJobNumber,
        checkedOutBoxId,
        checkedOutBoxStatus: checkedOutState.status,
        checkedOutBoxAllocatableNowFeet: checkedOutState.allocatableNowFeet,
        zeroedBoxId,
        zeroedBoxStatus: zeroedBox?.status || zeroedState.status,
        zeroedBoxAllocatableNowFeet: zeroedState.allocatableNowFeet,
      },
    });
  });
}

async function createAtomicTransferAssistedAllocation(config, tag, dealerPreflight) {
  return withFixtureMutation(config, async (client) => {
    const fixtureDealer = await createFixtureDealer(
      client,
      config.orgId,
      dealerPreflight.fixtureDealer
    );
    const { sourceWarehouse, destinationWarehouse } = await chooseWarehousePair(client, config.orgId);
    const ownerCompanyId = await chooseOwnerCompanyId(client, config.orgId, sourceWarehouse);
    const manufacturer = 'Codex Fixture';
    const filmName = `Atomic Transfer ${shortTag(tag)}`;
    const boxId = buildBoxId(sourceWarehouse, 'CDT', tag);
    const jobNumber = buildJobNumber(tag, 21);

    await addFixtureBox(
      client,
      config.orgId,
      boxPayload({
        boxId,
        warehouse: sourceWarehouse,
        ownerCompanyId,
        dealerName: fixtureDealer.name,
        tag,
        manufacturer,
        filmName,
        initialFeet: 90,
      }),
      tag
    );
    let jobDetail = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber,
        warehouse: destinationWarehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 40,
        installOffset: 4,
      }),
      tag
    );
    const requirement = firstRequirement(jobDetail);
    const allocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail,
      boxId,
      requestedFeet: 40,
      tag,
      crossWarehouse: true,
      jobWarehouse: destinationWarehouse,
    });
    const allocationIds = allocations.map((entry) => entry.allocationId).filter(Boolean);
    const transferState = await queryRow(
      client,
      `
        select
          t.status::text as status,
          t.destination_warehouse::text as destination_warehouse,
          (t.transfer_created_allocation_id = any($3::text[])) as linked_to_fixture_allocation
        from app.box_transfers t
        where t.org_id = $1::uuid
          and t.source_box_id = $2::text
          and t.status = 'PENDING'
        order by t.created_at desc, t.id desc
        limit 1
      `,
      [config.orgId, boxId, allocationIds]
    );
    if (!transferState?.linked_to_fixture_allocation) {
      throw new Error('Atomic transfer fixture did not create its linked pending transfer.');
    }

    jobDetail = await buildJobDetailById(client, config.orgId, jobDetail.summary.jobId);
    return buildManifest({
      config,
      tag,
      scenario: 'atomic-transfer-assisted-allocation',
      jobDetail,
      phaseId: firstPhaseId(jobDetail),
      requirementIds: [requirement.requirementId],
      allocationIds,
      boxIds: [boxId],
      fixtureDealer,
      dealerTableBefore: dealerPreflight.dealerTableBefore,
      summary: {
        sourceWarehouse,
        destinationWarehouse,
        transferStatus: asText(transferState.status).toUpperCase(),
        transferLinked: Boolean(transferState.linked_to_fixture_allocation),
      },
    });
  });
}

async function createAllocationTimeoutRemediation(config, tag, dealerPreflight) {
  return withFixtureMutation(config, async (client) => {
    const fixtureDealer = await createFixtureDealer(
      client,
      config.orgId,
      dealerPreflight.fixtureDealer
    );
    const { sourceWarehouse, destinationWarehouse } = await chooseWarehousePair(
      client,
      config.orgId
    );
    const sourceOwnerCompanyId = await chooseOwnerCompanyId(
      client,
      config.orgId,
      sourceWarehouse
    );
    const destinationOwnerCompanyId = await chooseOwnerCompanyId(
      client,
      config.orgId,
      destinationWarehouse
    );
    const manufacturer = 'Codex Fixture';
    const filmName = `Allocation Timeout ${shortTag(tag)}`;
    const oneBoxId = buildBoxId(destinationWarehouse, 'T01', tag);
    const sourceBoxId = buildBoxId(destinationWarehouse, 'T30', tag);
    const candidateBoxIds = [
      buildBoxId(destinationWarehouse, 'T31', tag),
      buildBoxId(destinationWarehouse, 'T32', tag),
    ];
    const extraBoxId = buildBoxId(destinationWarehouse, 'TEX', tag);
    const sameWarehousePartialBoxId = buildBoxId(destinationWarehouse, 'TSW', tag);
    const checkedOutBoxId = buildBoxId(sourceWarehouse, 'TCO', tag);
    const crossWarehouseZeroReservationBoxId = buildBoxId(sourceWarehouse, 'TCZ', tag);
    const scheduledReservedBoxId = buildBoxId(sourceWarehouse, 'TSR', tag);
    const placeholderReservedBoxId = buildBoxId(sourceWarehouse, 'TPR', tag);
    const historicalOnlyBoxId = buildBoxId(sourceWarehouse, 'THI', tag);
    const pendingTransferBoxId = buildBoxId(sourceWarehouse, 'TPT', tag);
    const staleRevalidationBoxId = buildBoxId(sourceWarehouse, 'TST', tag);
    const boxSpecs = [
      { boxId: oneBoxId, warehouse: destinationWarehouse, ownerCompanyId: destinationOwnerCompanyId, initialFeet: 40 },
      { boxId: sourceBoxId, warehouse: destinationWarehouse, ownerCompanyId: destinationOwnerCompanyId, initialFeet: 30 },
      { boxId: candidateBoxIds[0], warehouse: destinationWarehouse, ownerCompanyId: destinationOwnerCompanyId, initialFeet: 30 },
      { boxId: candidateBoxIds[1], warehouse: destinationWarehouse, ownerCompanyId: destinationOwnerCompanyId, initialFeet: 30 },
      { boxId: extraBoxId, warehouse: destinationWarehouse, ownerCompanyId: destinationOwnerCompanyId, initialFeet: 20 },
      { boxId: sameWarehousePartialBoxId, warehouse: destinationWarehouse, ownerCompanyId: destinationOwnerCompanyId, initialFeet: 50 },
      { boxId: checkedOutBoxId, warehouse: sourceWarehouse, ownerCompanyId: sourceOwnerCompanyId, initialFeet: 45 },
      { boxId: crossWarehouseZeroReservationBoxId, warehouse: sourceWarehouse, ownerCompanyId: sourceOwnerCompanyId, initialFeet: 45 },
      { boxId: scheduledReservedBoxId, warehouse: sourceWarehouse, ownerCompanyId: sourceOwnerCompanyId, initialFeet: 45 },
      { boxId: placeholderReservedBoxId, warehouse: sourceWarehouse, ownerCompanyId: sourceOwnerCompanyId, initialFeet: 45 },
      { boxId: historicalOnlyBoxId, warehouse: sourceWarehouse, ownerCompanyId: sourceOwnerCompanyId, initialFeet: 45 },
      { boxId: pendingTransferBoxId, warehouse: sourceWarehouse, ownerCompanyId: sourceOwnerCompanyId, initialFeet: 45 },
      { boxId: staleRevalidationBoxId, warehouse: sourceWarehouse, ownerCompanyId: sourceOwnerCompanyId, initialFeet: 45 },
    ];

    for (const spec of boxSpecs) {
      await addFixtureBox(
        client,
        config.orgId,
        boxPayload({
          ...spec,
          dealerName: fixtureDealer.name,
          tag,
          manufacturer,
          filmName,
        }),
        tag
      );
    }

    const oneBoxJob = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: buildJobNumber(tag, 31),
        warehouse: destinationWarehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 20,
        installOffset: 5,
      }),
      tag
    );
    const threeBoxJob = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: buildJobNumber(tag, 32),
        warehouse: destinationWarehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 75,
        installOffset: 6,
      }),
      tag
    );
    const previewTargetJob = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: buildJobNumber(tag, 33),
        warehouse: destinationWarehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 180,
        installOffset: 7,
      }),
      tag
    );
    const sourceReservationJob = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: buildJobNumber(tag, 34),
        warehouse: sourceWarehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 100,
        installOffset: 8,
      }),
      tag
    );
    const destinationReservationJob = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: buildJobNumber(tag, 35),
        warehouse: destinationWarehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 100,
        installOffset: 9,
      }),
      tag
    );
    const placeholderReservationJob = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: buildJobNumber(tag, 36),
        warehouse: sourceWarehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 50,
        installDate: '',
        crewLeader: '',
        workflowStatus: 'PLACEHOLDER',
      }),
      tag
    );
    const oneRequirement = firstRequirement(oneBoxJob);
    const threeRequirement = firstRequirement(threeBoxJob);
    const previewRequirement = firstRequirement(previewTargetJob);
    const sourceReservationRequirement = firstRequirement(sourceReservationJob);
    const destinationReservationRequirement = firstRequirement(destinationReservationJob);
    const placeholderReservationRequirement = firstRequirement(placeholderReservationJob);

    const sameWarehouseAllocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail: destinationReservationJob,
      boxId: sameWarehousePartialBoxId,
      requestedFeet: 15,
      tag,
    });
    const checkedOutAllocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail: sourceReservationJob,
      boxId: checkedOutBoxId,
      requestedFeet: 20,
      tag,
    });
    await checkoutFixtureBox(client, config.orgId, {
      boxId: checkedOutBoxId,
      jobId: sourceReservationJob.summary.jobId,
      tag,
    });
    const scheduledAllocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail: sourceReservationJob,
      boxId: scheduledReservedBoxId,
      requestedFeet: 15,
      tag,
    });
    const placeholderAllocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail: placeholderReservationJob,
      boxId: placeholderReservedBoxId,
      requestedFeet: 15,
      tag,
    });
    const historicalAllocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail: sourceReservationJob,
      boxId: historicalOnlyBoxId,
      requestedFeet: 15,
      tag,
    });
    const historicalAllocationId = asText(historicalAllocations[0]?.allocationId);
    if (!historicalAllocationId) {
      throw new Error('Historical allocation fixture did not create its tagged allocation.');
    }
    await removeAllocationFromJob(
      client,
      config.orgId,
      sourceReservationJob.summary.jobNumber,
      historicalAllocationId,
      tag,
      tag
    );
    await startBoxTransfer(
      client,
      config.orgId,
      {
        boxId: pendingTransferBoxId,
        toWarehouse: destinationWarehouse,
        notes: tag,
      },
      tag
    );

    const canonicalStateByBoxId = await fetchCanonicalAllocationState(client, config.orgId, [
      sameWarehousePartialBoxId,
      checkedOutBoxId,
      crossWarehouseZeroReservationBoxId,
      scheduledReservedBoxId,
      placeholderReservedBoxId,
      historicalOnlyBoxId,
      pendingTransferBoxId,
      staleRevalidationBoxId,
    ]);
    const partialState = canonicalStateByBoxId[sameWarehousePartialBoxId];
    const checkedOutState = canonicalStateByBoxId[checkedOutBoxId];
    const crossWarehouseState = canonicalStateByBoxId[crossWarehouseZeroReservationBoxId];
    const scheduledState = canonicalStateByBoxId[scheduledReservedBoxId];
    const placeholderState = canonicalStateByBoxId[placeholderReservedBoxId];
    const historicalState = canonicalStateByBoxId[historicalOnlyBoxId];
    const pendingState = canonicalStateByBoxId[pendingTransferBoxId];
    const staleState = canonicalStateByBoxId[staleRevalidationBoxId];
    if (
      !partialState ||
      integer(partialState.reservation_count) !== 1 ||
      integer(partialState.planning_feet) <= 0 ||
      !checkedOutState ||
      asText(checkedOutState.status).toUpperCase() !== 'CHECKED_OUT' ||
      integer(checkedOutState.reservation_count) !== 1 ||
      !crossWarehouseState ||
      integer(crossWarehouseState.reservation_count) !== 0 ||
      !scheduledState ||
      integer(scheduledState.reservation_count) !== 1 ||
      !placeholderState ||
      integer(placeholderState.reservation_count) !== 1 ||
      !historicalState ||
      integer(historicalState.reservation_count) !== 0 ||
      !pendingState ||
      pendingState.pending_transfer !== true ||
      !staleState ||
      integer(staleState.reservation_count) !== 0
    ) {
      throw new Error('Allocation preview fixture canonical state did not match the requested matrix.');
    }

    const setupAllocationIds = [
      ...sameWarehouseAllocations,
      ...checkedOutAllocations,
      ...scheduledAllocations,
      ...placeholderAllocations,
      ...historicalAllocations,
    ].map((entry) => entry.allocationId).filter(Boolean);
    const allBoxIds = [
      oneBoxId,
      sourceBoxId,
      ...candidateBoxIds,
      extraBoxId,
      sameWarehousePartialBoxId,
      checkedOutBoxId,
      crossWarehouseZeroReservationBoxId,
      scheduledReservedBoxId,
      placeholderReservedBoxId,
      historicalOnlyBoxId,
      pendingTransferBoxId,
      staleRevalidationBoxId,
    ];

    return buildManifest({
      config,
      tag,
      scenario: 'allocation-timeout-remediation',
      jobDetail: previewTargetJob,
      extraJobDetails: [
        oneBoxJob,
        threeBoxJob,
        sourceReservationJob,
        destinationReservationJob,
        placeholderReservationJob,
      ],
      phaseId: firstPhaseId(previewTargetJob),
      requirementIds: [
        previewRequirement.requirementId,
        threeRequirement.requirementId,
        oneRequirement.requirementId,
        sourceReservationRequirement.requirementId,
        destinationReservationRequirement.requirementId,
        placeholderReservationRequirement.requirementId,
      ],
      allocationIds: setupAllocationIds,
      boxIds: allBoxIds,
      fixtureDealer,
      dealerTableBefore: dealerPreflight.dealerTableBefore,
      summary: {
        warehouse: destinationWarehouse,
        sourceWarehouse,
        destinationWarehouse,
        oneBox: {
          jobId: oneBoxJob.summary.jobId,
          jobNumber: oneBoxJob.summary.jobNumber,
          requirementId: oneRequirement.requirementId,
          widthIn: oneRequirement.widthIn,
          boxId: oneBoxId,
          requestedFeet: 20,
          installDate: asText(oneRequirement.phaseInstallDate || oneBoxJob.summary.installDate),
          crewLeader: asText(oneRequirement.phaseCrewLeader || oneBoxJob.summary.crewLeader),
        },
        threeBox: {
          jobId: threeBoxJob.summary.jobId,
          jobNumber: threeBoxJob.summary.jobNumber,
          requirementId: threeRequirement.requirementId,
          widthIn: threeRequirement.widthIn,
          sourceBoxId,
          candidateBoxIds,
          extraBoxId,
          requestedFeet: 75,
          extraFeet: 5,
          installDate: asText(threeRequirement.phaseInstallDate || threeBoxJob.summary.installDate),
          crewLeader: asText(threeRequirement.phaseCrewLeader || threeBoxJob.summary.crewLeader),
        },
        previewTarget: {
          jobId: previewTargetJob.summary.jobId,
          jobNumber: previewTargetJob.summary.jobNumber,
          requirementId: previewRequirement.requirementId,
          widthIn: previewRequirement.widthIn,
          installDate: asText(previewRequirement.phaseInstallDate || previewTargetJob.summary.installDate),
          crewLeader: asText(previewRequirement.phaseCrewLeader || previewTargetJob.summary.crewLeader),
          warehouse: destinationWarehouse,
        },
        sourceReservation: {
          jobId: sourceReservationJob.summary.jobId,
          jobNumber: sourceReservationJob.summary.jobNumber,
          requirementId: sourceReservationRequirement.requirementId,
          widthIn: sourceReservationRequirement.widthIn,
          installDate: asText(
            sourceReservationRequirement.phaseInstallDate || sourceReservationJob.summary.installDate
          ),
          crewLeader: asText(
            sourceReservationRequirement.phaseCrewLeader || sourceReservationJob.summary.crewLeader
          ),
          warehouse: sourceWarehouse,
        },
        cases: {
          sameWarehousePartialBoxId,
          sameWarehousePartialPlanningFeet: integer(partialState.planning_feet),
          checkedOutBoxId,
          crossWarehouseZeroReservationBoxId,
          scheduledReservedBoxId,
          placeholderReservedBoxId,
          historicalOnlyBoxId,
          pendingTransferBoxId,
          staleRevalidationBoxId,
        },
      },
    });
  });
}

function requireExactRows(rows, expectedCount, category) {
  if (!Array.isArray(rows) || rows.length !== expectedCount) {
    throw new FixtureSafetyError(
      'FIXTURE_ROW_BUDGET_INVALID',
      `Synthetic ${category} row budget is invalid.`
    );
  }
  return rows;
}

function buildPendingFixtureCatalogIdentity(tag) {
  const suffix = shortTag(tag).toLowerCase();
  const manufacturerName = `Codex Fixture Caulk ${suffix}`;
  const manufacturerKey = manufacturerName.toLowerCase();
  const productName = `Pending Transfer ${suffix}`;
  const productKey = productName.toLowerCase();
  return {
    manufacturerName,
    manufacturerKey,
    productName,
    productKey,
    productCode: `CDF-${suffix}`,
  };
}

async function assertPendingFixtureRootsAvailable(client, config, {
  tag,
  fixtureDealer,
  catalogIdentity,
  boxId,
  jobNumber,
}) {
  const row = await queryRow(
    client,
    `
      select
        (select count(*)::integer from app.box_dealers
          where org_id = $1::uuid and (lookup_key = $2::text or name = $3::text)) as dealer_count,
        (select count(*)::integer from app.caulk_manufacturers
          where org_id = $1::uuid and (lookup_key = $4::text or created_by = $8::text or updated_by = $8::text)) as manufacturer_count,
        (select count(*)::integer from app.caulk_products
          where org_id = $1::uuid and (lookup_key = $5::text or code = $6::text or notes = $8::text or created_by = $8::text or updated_by = $8::text)) as product_count,
        (select count(*)::integer from app.boxes
          where org_id = $1::uuid and (box_id = $7::text or notes = $8::text or lot_run = $8::text)) as box_count,
        (select count(*)::integer from app.jobs
          where org_id = $1::uuid and (job_number = $9::text or notes = $8::text or sections = $8::text)) as job_count
    `,
    [
      config.orgId,
      fixtureDealer.code,
      fixtureDealer.name,
      catalogIdentity.manufacturerKey,
      catalogIdentity.productKey,
      catalogIdentity.productCode,
      boxId,
      tag,
      jobNumber,
    ]
  );
  const counts = [
    row?.dealer_count,
    row?.manufacturer_count,
    row?.product_count,
    row?.box_count,
    row?.job_count,
  ].map(integer);
  assertFixtureDealerAvailable({ codeMatches: counts[0], nameMatches: 0 });
  if (counts.some((count) => count !== 0)) {
    throw new FixtureSafetyError(
      'FIXTURE_NAMESPACE_COLLISION',
      'The synthetic fixture namespace is already in use.'
    );
  }
  return true;
}

async function insertPendingFixtureCatalog(client, config, tag, catalogIdentity) {
  const {
    manufacturerName,
    manufacturerKey,
    productName,
    productKey,
    productCode,
  } = catalogIdentity;
  const manufacturer = await queryRow(
    client,
    `
      insert into app.caulk_manufacturers (
        org_id, name, lookup_key, is_active, created_by, updated_by
      ) values ($1::uuid, $2::text, $3::text, true, $4::text, $4::text)
      returning id::text as id
    `,
    [config.orgId, manufacturerName, manufacturerKey, tag]
  );
  const product = await queryRow(
    client,
    `
      insert into app.caulk_products (
        org_id, manufacturer_id, name, code, lookup_key, tubes_per_case,
        is_active, notes, created_by, updated_by
      ) values (
        $1::uuid, $2::uuid, $3::text, $4::text, $5::text, 16,
        true, $6::text, $6::text, $6::text
      )
      returning id::text as id
    `,
    [config.orgId, manufacturer?.id, productName, productCode, productKey, tag]
  );
  if (!isUuidLike(manufacturer?.id) || !isUuidLike(product?.id)) {
    throw new FixtureSafetyError('FIXTURE_CATALOG_CREATE_FAILED', 'Synthetic caulk catalog creation failed.');
  }
  return { manufacturerId: manufacturer.id, productId: product.id };
}

async function collectPendingFixtureIds(client, {
  config,
  tag,
  fixtureDealer,
  manufacturerId,
  productId,
  jobDetail,
  boxId,
  caulkAllocationId,
}) {
  const jobId = asText(jobDetail.summary?.jobId);
  const jobNumber = asText(jobDetail.summary?.jobNumber);
  const phaseId = firstPhaseId(jobDetail);
  const filmRequirement = firstRequirement(jobDetail);
  const caulkRequirements = requireExactRows(await queryRows(
    client,
    `select id::text as id from app.job_caulk_requirements
     where org_id = $1::uuid and job_id = $2::uuid and product_id = $3::uuid
     order by id`,
    [config.orgId, jobId, productId]
  ), 1, 'caulk requirement');
  const caulkAllocations = requireExactRows(await queryRows(
    client,
    `select id::text as id, caulk_allocation_id::text as public_id
     from app.caulk_job_allocations
     where org_id = $1::uuid and job_id = $2::uuid and product_id = $3::uuid
       and caulk_allocation_id = $4::text
     order by id`,
    [config.orgId, jobId, productId, caulkAllocationId]
  ), 1, 'caulk allocation');
  const transfers = requireExactRows(await queryRows(
    client,
    `select id::text as id, transfer_id::text as public_id
     from app.caulk_transfers
     where org_id = $1::uuid and caulk_allocation_id = $2::uuid and status = 'PENDING'
     order by id`,
    [config.orgId, caulkAllocations[0].id]
  ), 1, 'pending caulk transfer');
  const stockRows = requireExactRows(await queryRows(
    client,
    `select id::text as id from app.caulk_stock
     where org_id = $1::uuid and product_id = $2::uuid
     order by warehouse, id`,
    [config.orgId, productId]
  ), 2, 'caulk stock');
  const transactions = requireExactRows(await queryRows(
    client,
    `select id::text as id, action::text as action from app.caulk_transactions
     where org_id = $1::uuid and product_id = $2::uuid
     order by created_at, id`,
    [config.orgId, productId]
  ), 4, 'caulk transaction');
  const actionCounts = Object.fromEntries(
    ['RECEIVE', 'JOB_ALLOCATE', 'TRANSFER_OUT'].map((action) => [
      action,
      transactions.filter((row) => asText(row.action).toUpperCase() === action).length,
    ])
  );
  if (
    actionCounts.RECEIVE !== 2 ||
    actionCounts.JOB_ALLOCATE !== 1 ||
    actionCounts.TRANSFER_OUT !== 1
  ) {
    throw new FixtureSafetyError('FIXTURE_HISTORY_BUDGET_INVALID', 'Synthetic caulk history is invalid.');
  }
  const boxRows = requireExactRows(await queryRows(
    client,
    `select id::text as id from app.boxes
     where org_id = $1::uuid and box_id = $2::text`,
    [config.orgId, boxId]
  ), 1, 'film box');
  const catalogRows = requireExactRows(await queryRows(
    client,
    `select id::text as id from app.film_catalog
     where org_id = $1::uuid and source_box_id = $2::text`,
    [config.orgId, boxId]
  ), 1, 'film catalog');
  const audits = requireExactRows(await queryRows(
    client,
    `select id::text as id from app.audit_log
     where org_id = $1::uuid and box_id = $2::text and action = 'ADD_BOX'
     order by created_at, id`,
    [config.orgId, boxId]
  ), 1, 'ADD_BOX audit');

  return {
    manufacturerIds: [manufacturerId],
    productIds: [productId],
    caulkStockIds: stockRows.map((row) => row.id),
    caulkTransactionIds: transactions.map((row) => row.id),
    caulkTransferRowIds: transfers.map((row) => row.id),
    caulkTransferIds: transfers.map((row) => row.public_id),
    caulkRequirementIds: caulkRequirements.map((row) => row.id),
    caulkAllocationRowIds: caulkAllocations.map((row) => row.id),
    caulkAllocationIds: caulkAllocations.map((row) => row.public_id),
    dealerIds: [fixtureDealer.id],
    filmCatalogIds: catalogRows.map((row) => row.id),
    boxRecordIds: boxRows.map((row) => row.id),
    boxIds: [boxId],
    jobIds: [jobId],
    jobNumbers: [jobNumber],
    phaseIds: [phaseId],
    requirementIds: [filmRequirement.requirementId],
    allocationIds: [],
    auditLogIds: audits.map((row) => row.id),
  };
}

async function createPendingTransferCheckoutDenial(config, tag) {
  const lock = acquireV3LifecycleLock(config, tag, 'create');
  let preparedManifest = null;
  let transactionBodyComplete = false;
  let commitKnown = false;
  try {
    preparedManifest = await withFixtureMutation(config, async (client) => {
      await client.query('lock table app.box_dealers in share row exclusive mode');
      const baseline = await capturePendingFixtureBaseline(client, config, EMPTY_PENDING_IDS);
      const dealerTableBefore = await captureDealerTableIntegrity(client);
      const fixtureDealerIdentity = buildFixtureDealerIdentity(tag);
      const { sourceWarehouse, destinationWarehouse } = await chooseWarehousePair(
        client,
        config.orgId
      );
      const ownerCompanyId = await chooseOwnerCompanyId(
        client,
        config.orgId,
        destinationWarehouse
      );
      const catalogIdentity = buildPendingFixtureCatalogIdentity(tag);
      const filmManufacturer = 'Codex Fixture';
      const filmName = `Pending Checkout ${shortTag(tag)}`;
      const boxId = buildBoxId(destinationWarehouse, 'PTC', tag);
      const jobNumber = buildJobNumber(tag, 41);
      await assertPendingFixtureRootsAvailable(client, config, {
        tag,
        fixtureDealer: fixtureDealerIdentity,
        catalogIdentity,
        boxId,
        jobNumber,
      });
      const fixtureDealer = await createFixtureDealer(
        client,
        config.orgId,
        fixtureDealerIdentity
      );
      const { manufacturerId, productId } = await insertPendingFixtureCatalog(
        client,
        config,
        tag,
        catalogIdentity
      );

      await mutateCaulkStock(client, config.orgId, tag, {
        action: 'RECEIVE',
        productId,
        warehouse: sourceWarehouse,
        ownerCompanyId,
        deltaTubes: 1,
        reason: tag,
        notes: tag,
      });
      await mutateCaulkStock(client, config.orgId, tag, {
        action: 'RECEIVE',
        productId,
        warehouse: destinationWarehouse,
        ownerCompanyId,
        deltaTubes: 1,
        reason: tag,
        notes: tag,
      });
      await addFixtureBox(
        client,
        config.orgId,
        boxPayload({
          boxId,
          warehouse: destinationWarehouse,
          ownerCompanyId,
          dealerName: fixtureDealer.name,
          tag,
          manufacturer: filmManufacturer,
          filmName,
          widthIn: 60,
          initialFeet: 80,
        }),
        tag
      );
      let jobDetail = await createFixtureJob(
        client,
        config.orgId,
        jobPayload({
          jobNumber,
          warehouse: destinationWarehouse,
          tag,
          manufacturer: filmManufacturer,
          filmName,
          requiredFeet: 40,
          installOffset: 4,
          caulkProductId: productId,
          caulkRequiredTubes: 2,
        }),
        tag
      );
      const filmRequirement = firstRequirement(jobDetail);
      const caulkRequirement = await queryRow(
        client,
        `select id::text as id from app.job_caulk_requirements
         where org_id = $1::uuid and job_id = $2::uuid and product_id = $3::uuid`,
        [config.orgId, jobDetail.summary.jobId, productId]
      );
      if (!isUuidLike(caulkRequirement?.id)) {
        throw new FixtureSafetyError('FIXTURE_REQUIREMENT_INVALID', 'Synthetic caulk requirement is invalid.');
      }
      const allocationResponse = await addCaulkAllocation(client, config.orgId, tag, {
        productId,
        jobId: jobDetail.summary.jobId,
        jobNumber,
        requirementId: caulkRequirement.id,
        warehouse: destinationWarehouse,
        ownerCompanyId,
        allocatedTubes: 2,
        transferFromWarehouse: sourceWarehouse,
        notes: tag,
      });
      const caulkAllocationId = asText(allocationResponse?.result?.caulkAllocationId);
      jobDetail = await buildJobDetailById(client, config.orgId, jobDetail.summary.jobId);
      const ids = await collectPendingFixtureIds(client, {
        config,
        tag,
        fixtureDealer,
        manufacturerId,
        productId,
        jobDetail,
        boxId,
        caulkAllocationId,
      });
      const createdAt = new Date().toISOString();
      const candidate = normalizeV3Manifest({
        version: 3,
        tag,
        namespace: tag,
        scenario: PENDING_TRANSFER_CHECKOUT_SCENARIO,
        createdAt,
        updatedAt: createdAt,
        projectRef: config.projectRef,
        orgId: config.orgId,
        state: { setup: 'prepared', runtime: 'not_started', cleanup: 'not_started' },
        baseline,
        ids,
        fixtureDealer,
        integrity: { dealerTableBefore },
        budgets: PENDING_TRANSFER_STAGE_BUDGETS.initial,
        cleanupEvidence: {},
      });
      assertPendingTransferManifestIdBudget(candidate);
      const counts = await countPendingTransferFixture(client, candidate);
      assertPendingTransferStageBudget(counts, 'initial');
      await assertPendingFilmBoxTopology(client, candidate);
      publishInitialV3Manifest(config, candidate);
      transactionBodyComplete = true;
      return candidate;
    });
    commitKnown = true;
    const readyManifest = buildV3Transition(
      preparedManifest,
      { setup: 'ready', runtime: 'initial', cleanup: 'not_started' },
      { budgets: PENDING_TRANSFER_STAGE_BUDGETS.initial }
    );
    const written = replaceV3Manifest(config, preparedManifest, readyManifest);
    releaseV3LifecycleLock(lock);
    return written.manifest;
  } catch (error) {
    if (preparedManifest || transactionBodyComplete) {
      try {
        if (!commitKnown && transactionBodyComplete) {
          createCommitAmbiguityMarker(config, tag);
        } else {
          createRecoveryMarker(config, tag);
        }
      } catch (_markerError) {
        // Prepared manifest and/or lifecycle lock remains authoritative.
      }
    }
    if (error instanceof FixtureSafetyError) {
      throw error;
    }
    throw new FixtureSafetyError('V3_SETUP_FAILED', 'Pending-transfer fixture setup failed.');
  }
}

function buildManifest({
  config,
  tag,
  scenario,
  jobDetail,
  extraJobDetails = [],
  phaseId,
  requirementIds = [],
  allocationIds = [],
  boxIds = [],
  fixtureDealer,
  dealerTableBefore,
  summary = {},
}) {
  const allJobDetails = [jobDetail, ...extraJobDetails].filter(Boolean);
  const jobIds = allJobDetails.map((entry) => entry.summary?.jobId).filter(Boolean);
  const jobNumbers = allJobDetails.map((entry) => entry.summary?.jobNumber).filter(Boolean);
  return {
    tag,
    scenario,
    createdAt: new Date().toISOString(),
    projectRef: config.projectRef,
    orgId: config.orgId,
    ids: {
      jobIds,
      jobNumbers,
      phaseIds: [phaseId, ...extraJobDetails.map(firstPhaseId)].filter(Boolean),
      requirementIds,
      allocationIds,
      boxIds,
      filmOrderIds: [],
    },
    fixtureDealer,
    integrity: {
      dealerTableBefore,
    },
    routes: {
      jobDetails: jobIds.map(buildJobRoute),
      boxDetails: boxIds.map(buildBoxRoute),
      qrPayloads: boxIds,
    },
    summary,
  };
}

async function fetchBoxPlanningState(client, orgId, boxId) {
  const row = await queryRow(
    client,
    `
      select
        b.box_id::text as box_id,
        b.status::text as status,
        b.last_checkout_job_id::text as last_checkout_job_id,
        b.last_checkout_job::text as last_checkout_job,
        app_api.box_allocatable_now_feet(b)::integer as allocatable_now_feet,
        coalesce((
          select sum(a.allocated_feet)::integer
          from app.allocations a
          where a.org_id = b.org_id
            and a.box_id = b.box_id
            and upper(coalesce(a.status::text, '')) = 'ACTIVE'
        ), 0)::integer as active_allocated_feet
      from app.boxes b
      where b.org_id = $1::uuid
        and b.box_id = $2::text
    `,
    [orgId, boxId]
  );
  if (!row) {
    return null;
  }
  return {
    boxId: row.box_id,
    status: row.status,
    lastCheckoutJobId: asText(row.last_checkout_job_id),
    lastCheckoutJob: asText(row.last_checkout_job),
    allocatableNowFeet: integer(row.allocatable_now_feet),
    activeAllocatedFeet: integer(row.active_allocated_feet),
  };
}

async function discoverFixtureIds(client, orgId, tag) {
  const normalizedTag = normalizeFixtureTag(tag);
  const expectedDealer = buildFixtureDealerIdentity(normalizedTag);
  const row = await queryRow(
    client,
    `
      with fixture_jobs as (
        select id::text as id, job_number::text as job_number
        from app.jobs
        where org_id = $1::uuid
          and (
            notes = $2::text
            or created_by = $2::text
            or updated_by = $2::text
            or sections = $2::text
          )
      ),
      fixture_boxes as (
        select box_id::text as box_id
        from app.boxes
        where org_id = $1::uuid
          and (
            notes = $2::text
            or lot_run = $2::text
            or zeroed_by = $2::text
          )
      ),
      fixture_dealer as (
        select id::text as id, name::text as name, lookup_key::text as code
        from app.box_dealers
        where org_id = $1::uuid
          and name = $3::text
          and lookup_key = $4::text
      ),
      fixture_requirements as (
        select id::text as id
        from app.job_requirements
        where org_id = $1::uuid
          and (
            job_id in (select id::uuid from fixture_jobs)
            or notes = $2::text
            or created_by = $2::text
            or updated_by = $2::text
          )
      ),
      fixture_phases as (
        select id::text as id
        from app.job_phases
        where org_id = $1::uuid
          and (
            job_id in (select id::uuid from fixture_jobs)
            or sections = $2::text
            or created_by = $2::text
            or updated_by = $2::text
          )
      ),
      fixture_allocations as (
        select allocation_id::text as allocation_id
        from app.allocations
        where org_id = $1::uuid
          and (
            job_id in (select id::uuid from fixture_jobs)
            or box_id in (select box_id from fixture_boxes)
            or requirement_id in (select id::uuid from fixture_requirements)
            or notes = $2::text
            or created_by = $2::text
            or resolved_by = $2::text
          )
      )
      select jsonb_build_object(
        'jobIds', coalesce((select jsonb_agg(id order by id) from fixture_jobs), '[]'::jsonb),
        'jobNumbers', coalesce((select jsonb_agg(job_number order by job_number) from fixture_jobs), '[]'::jsonb),
        'phaseIds', coalesce((select jsonb_agg(id order by id) from fixture_phases), '[]'::jsonb),
        'requirementIds', coalesce((select jsonb_agg(id order by id) from fixture_requirements), '[]'::jsonb),
        'allocationIds', coalesce((select jsonb_agg(allocation_id order by allocation_id) from fixture_allocations), '[]'::jsonb),
        'boxIds', coalesce((select jsonb_agg(box_id order by box_id) from fixture_boxes), '[]'::jsonb),
        'filmOrderIds', '[]'::jsonb
      ) as ids,
      coalesce((
        select jsonb_build_object('id', id, 'name', name, 'code', code)
        from fixture_dealer
        order by id
        limit 1
      ), '{}'::jsonb) as fixture_dealer
    `,
    [orgId, normalizedTag, expectedDealer.name, expectedDealer.code]
  );
  return {
    tag: normalizedTag,
    ids: row?.ids || {},
    fixtureDealer: row?.fixture_dealer || {},
  };
}

async function countFixtureRecords(client, orgId, identity) {
  assertSafeFixtureIdentity(identity);
  const ids = identity.ids || {};
  const fixtureDealer = identity.fixtureDealer || {};
  const row = await queryRow(
    client,
    `
      select jsonb_build_object(
        'jobs', (select count(*)::integer from app.jobs where org_id = $1::uuid and (id = any($2::uuid[]) or job_number = any($3::text[]) or notes = $9::text or created_by = $9::text)),
        'phases', (select count(*)::integer from app.job_phases where org_id = $1::uuid and (id = any($4::uuid[]) or job_id = any($2::uuid[]) or sections = $9::text or created_by = $9::text)),
        'requirements', (select count(*)::integer from app.job_requirements where org_id = $1::uuid and (id = any($5::uuid[]) or job_id = any($2::uuid[]) or notes = $9::text or created_by = $9::text)),
        'allocations', (select count(*)::integer from app.allocations where org_id = $1::uuid and (allocation_id = any($6::text[]) or job_id = any($2::uuid[]) or box_id = any($7::text[]) or created_by = $9::text or notes = $9::text)),
        'transfers', (select count(*)::integer from app.box_transfers where org_id = $1::uuid and (source_box_id = any($7::text[]) or destination_box_id = any($7::text[]) or created_by = $9::text or updated_by = $9::text)),
        'boxAliases', (select count(*)::integer from app.box_id_aliases where org_id = $1::uuid and (old_box_id = any($7::text[]) or canonical_box_id = any($7::text[]))),
        'dealers', (select count(*)::integer from app.box_dealers where org_id = $1::uuid and id = $10::uuid and lookup_key = $11::text and name = $12::text),
        'boxes', (select count(*)::integer from app.boxes where org_id = $1::uuid and (box_id = any($7::text[]) or notes = $9::text or lot_run = $9::text)),
        'filmOrders', (select count(*)::integer from app.film_orders where org_id = $1::uuid and (film_order_id = any($8::text[]) or job_id = any($2::uuid[]) or notes = $9::text)),
        'audit', (select count(*)::integer from app.audit_log where org_id = $1::uuid and (box_id = any($7::text[]) or actor = $9::text or notes = $9::text)),
        'rollHistory', (select count(*)::integer from app.roll_weight_log where org_id = $1::uuid and (box_id = any($7::text[]) or job_id = any($2::uuid[]) or job_number = any($3::text[]) or checked_out_by = $9::text or checked_in_by = $9::text or notes = $9::text))
      ) as counts
    `,
    [
      orgId,
      ids.jobIds || [],
      ids.jobNumbers || [],
      ids.phaseIds || [],
      ids.requirementIds || [],
      ids.allocationIds || [],
      ids.boxIds || [],
      ids.filmOrderIds || [],
      identity.tag,
      asText(fixtureDealer.id) || null,
      asText(fixtureDealer.code),
      asText(fixtureDealer.name),
    ]
  );
  return row?.counts || {};
}

async function withFixtureReadOnlySnapshot(callback) {
  return withReadClient(async (client) => {
    await client.query('begin transaction isolation level repeatable read read only');
    try {
      await client.query("set local timezone = 'UTC'");
      await client.query("set local statement_timeout = '30s'");
      const result = await callback(client);
      await client.query('rollback');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch (_rollbackError) {
        // Surface the original categorical failure.
      }
      throw error;
    }
  });
}

async function validatePendingRuntimeAllocation(client, manifest, allocationId) {
  const rows = await queryRows(
    client,
    `
      select
        a.allocation_id::text as allocation_id,
        a.job_id::text as job_id,
        a.requirement_id::text as requirement_id,
        r.phase_id::text as phase_id,
        a.box_id::text as box_id,
        a.allocated_feet::integer as allocated_feet,
        a.allocation_kind::text as allocation_kind,
        a.allocation_source::text as allocation_source,
        a.status::text as status,
        (select count(*)::integer from app.box_transfers t
          where t.org_id = a.org_id and t.box_record_id = b.id) as box_transfer_count,
        (select count(*)::integer from app.box_id_aliases x
          where x.org_id = a.org_id and (x.old_box_id = a.box_id or x.canonical_box_id = a.box_id)) as alias_count,
        (select count(*)::integer from app.roll_weight_log h
          where h.org_id = a.org_id and h.box_id = a.box_id) as roll_history_count
      from app.allocations a
      join app.job_requirements r
        on r.org_id = a.org_id and r.id = a.requirement_id
      join app.boxes b
        on b.org_id = a.org_id and b.box_id = a.box_id
      where a.org_id = $1::uuid
        and a.allocation_id = $2::text
        and a.job_id = $3::uuid
        and a.requirement_id = $4::uuid
        and r.phase_id = $5::uuid
        and a.box_id = $6::text
    `,
    [
      manifest.orgId,
      allocationId,
      manifest.ids.jobIds[0],
      manifest.ids.requirementIds[0],
      manifest.ids.phaseIds[0],
      manifest.ids.boxIds[0],
    ]
  );
  const row = requireExactRows(rows, 1, 'runtime allocation')[0];
  if (
    integer(row.allocated_feet) !== 40 ||
    asText(row.allocation_kind).toUpperCase() !== 'REQUIREMENT' ||
    asText(row.allocation_source).toUpperCase() !== 'MANUAL' ||
    asText(row.status).toUpperCase() !== 'ACTIVE' ||
    integer(row.box_transfer_count) !== 0 ||
    integer(row.alias_count) !== 0 ||
    integer(row.roll_history_count) !== 0
  ) {
    throw new FixtureSafetyError('RUNTIME_ALLOCATION_INVALID', 'Runtime allocation validation failed.');
  }
  return true;
}

async function findPendingFixtureSetStatusAudit(client, manifest) {
  const rows = await queryRows(
    client,
    `
      select id::text as id
      from app.audit_log
      where org_id = $1::uuid
        and box_id = $2::text
        and action = 'SET_STATUS'
        and coalesce(after_state->>'status', '') = 'CHECKED_OUT'
        and coalesce(after_state->>'lastCheckoutJobId', '') = $3::text
        and not (id = any($4::uuid[]))
      order by created_at, id
    `,
    [manifest.orgId, manifest.ids.boxIds[0], manifest.ids.jobIds[0], manifest.ids.auditLogIds]
  );
  return requireExactRows(rows, 1, 'SET_STATUS audit')[0].id;
}

async function recordPendingTransferRuntimeStage(config, { tag, stage, allocationId = '' }) {
  const normalizedStage = asText(stage);
  if (!['allocation-applied', 'mixed-checkout-complete'].includes(normalizedStage)) {
    throw new FixtureSafetyError('RUNTIME_STAGE_INVALID', 'Runtime stage is invalid.');
  }
  const lock = acquireV3LifecycleLock(config, tag, 'record_runtime_stage');
  try {
    const current = readV3ManifestInternal(config, tag);
    const result = await withFixtureReadOnlySnapshot(async (client) => {
      let next;
      if (normalizedStage === 'allocation-applied') {
        if (current.state.setup !== 'ready' || current.state.runtime !== 'initial' || current.state.cleanup !== 'not_started') {
          throw new FixtureSafetyError('RUNTIME_STAGE_ORDER_INVALID', 'Runtime stage order is invalid.');
        }
        await validatePendingRuntimeAllocation(client, current, allocationId);
        next = buildV3Transition(
          current,
          { setup: 'ready', runtime: 'allocation_applied', cleanup: 'not_started' },
          {
            ids: { ...current.ids, allocationIds: [allocationId] },
            budgets: PENDING_TRANSFER_STAGE_BUDGETS.allocation_applied,
          }
        );
      } else {
        if (current.state.setup !== 'ready' || current.state.runtime !== 'allocation_applied' || current.state.cleanup !== 'not_started') {
          throw new FixtureSafetyError('RUNTIME_STAGE_ORDER_INVALID', 'Runtime stage order is invalid.');
        }
        const auditId = await findPendingFixtureSetStatusAudit(client, current);
        next = buildV3Transition(
          current,
          { setup: 'ready', runtime: 'mixed_checkout_complete', cleanup: 'not_started' },
          {
            ids: { ...current.ids, auditLogIds: [...current.ids.auditLogIds, auditId] },
            budgets: PENDING_TRANSFER_STAGE_BUDGETS.mixed_checkout_complete,
          }
        );
      }
      assertPendingTransferManifestIdBudget(next);
      const counts = await countPendingTransferFixture(client, next);
      assertPendingTransferStageBudget(counts, next.state.runtime);
      const currentBaseline = await capturePendingFixtureBaseline(client, config, next.ids);
      assertBaselineEvidenceEqual(current.baseline, currentBaseline);
      return { next, counts };
    });
    const written = replaceV3Manifest(config, current, result.next);
    releaseV3LifecycleLock(lock);
    return {
      runtimeStage: written.manifest.state.runtime,
      lifecycle: written.manifest.state,
      counts: result.counts,
      baselineDigest: written.manifest.baselineDigest,
    };
  } catch (error) {
    if (error instanceof FixtureSafetyError) {
      throw error;
    }
    throw new FixtureSafetyError('RUNTIME_STAGE_FAILED', 'Runtime stage capture failed.');
  }
}

async function verifyPendingTransferFixture(config, manifest) {
  const lock = acquireV3LifecycleLock(config, manifest.tag, 'verify');
  try {
    const result = await withFixtureReadOnlySnapshot(async (client) => {
      const counts = await countPendingTransferFixture(client, manifest);
      if (manifest.state.cleanup === 'not_started') {
        assertPendingTransferStageBudget(counts, manifest.state.runtime);
        const baseline = await capturePendingFixtureBaseline(client, config, manifest.ids);
        assertBaselineEvidenceEqual(manifest.baseline, baseline);
      }
      return counts;
    });
    releaseV3LifecycleLock(lock);
    return {
      ok: true,
      tag: '<private-v3-namespace>',
      ids: {},
      counts: result,
      boxStates: [],
    };
  } catch (error) {
    if (error instanceof FixtureSafetyError) {
      throw error;
    }
    throw new FixtureSafetyError('V3_VERIFY_FAILED', 'Pending-transfer fixture verification failed.');
  }
}

async function verifyFixture(config, { tag, manifest }) {
  if (Number(manifest?.version) === 3) {
    return verifyPendingTransferFixture(config, normalizeV3Manifest(manifest));
  }
  return withReadClient(async (client) => {
    const discovered = await discoverFixtureIds(client, config.orgId, tag);
    const identity = normalizeFixtureIdentity({ tag, manifest, discovered });
    const counts = await countFixtureRecords(client, config.orgId, identity);
    const boxStates = [];
    for (const boxId of identity.ids.boxIds || []) {
      const state = await fetchBoxPlanningState(client, config.orgId, boxId);
      if (state) {
        boxStates.push(state);
      }
    }
    const ok = integer(counts.jobs) > 0 && integer(counts.boxes) > 0;
    return {
      ok,
      tag: identity.tag,
      ids: identity.ids,
      counts,
      boxStates,
    };
  });
}

function assertAllFixtureCountsZero(counts = {}) {
  if (
    Object.keys(PENDING_TRANSFER_STAGE_BUDGETS.initial).some(
      (key) => !Number.isSafeInteger(counts[key]) || counts[key] !== 0
    )
  ) {
    throw new FixtureSafetyError('CLEANUP_RESIDUE', 'Fixture cleanup left unexpected residue.');
  }
  return true;
}

async function deletePendingTransferFixtureRows(client, manifest) {
  const ids = manifest.ids;
  const deleted = {};
  const runDelete = async (category, expected, sql, params) => {
    const result = await client.query(sql, params);
    const count = integer(result.rowCount);
    if (count !== expected) {
      throw new FixtureSafetyError('CLEANUP_BUDGET_MISMATCH', 'Fixture cleanup row budget did not match.');
    }
    deleted[category] = count;
  };

  await runDelete(
    'caulkTransfers',
    1,
    `delete from app.caulk_transfers where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.caulkTransferRowIds]
  );
  await runDelete(
    'caulkAllocations',
    1,
    `delete from app.caulk_job_allocations where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.caulkAllocationRowIds]
  );
  await runDelete(
    'filmAllocations',
    manifest.state.runtime === 'initial' ? 0 : 1,
    `delete from app.allocations where org_id = $1::uuid and allocation_id = any($2::text[])`,
    [manifest.orgId, ids.allocationIds]
  );
  await runDelete(
    'caulkTransactions',
    4,
    `delete from app.caulk_transactions where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.caulkTransactionIds]
  );
  await runDelete(
    'caulkStock',
    2,
    `delete from app.caulk_stock where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.caulkStockIds]
  );
  await runDelete(
    'caulkRequirements',
    1,
    `delete from app.job_caulk_requirements where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.caulkRequirementIds]
  );
  await runDelete(
    'filmRequirements',
    1,
    `delete from app.job_requirements where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.requirementIds]
  );
  await runDelete(
    'phases',
    1,
    `delete from app.job_phases where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.phaseIds]
  );
  await runDelete(
    'auditRows',
    manifest.state.runtime === 'mixed_checkout_complete' ? 2 : 1,
    `delete from app.audit_log where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.auditLogIds]
  );
  await runDelete(
    'boxes',
    1,
    `delete from app.boxes where org_id = $1::uuid and id = any($2::uuid[]) and box_id = any($3::text[])`,
    [manifest.orgId, ids.boxRecordIds, ids.boxIds]
  );
  await runDelete(
    'jobs',
    1,
    `delete from app.jobs where org_id = $1::uuid and id = any($2::uuid[]) and job_number = any($3::text[])`,
    [manifest.orgId, ids.jobIds, ids.jobNumbers]
  );
  await runDelete(
    'filmCatalog',
    1,
    `delete from app.film_catalog where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.filmCatalogIds]
  );
  await runDelete(
    'dealer',
    1,
    `delete from app.box_dealers
     where org_id = $1::uuid and id = $2::uuid and lookup_key = $3::text and name = $4::text`,
    [manifest.orgId, ids.dealerIds[0], manifest.fixtureDealer.code, manifest.fixtureDealer.name]
  );
  await runDelete(
    'product',
    1,
    `delete from app.caulk_products where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.productIds]
  );
  await runDelete(
    'manufacturer',
    1,
    `delete from app.caulk_manufacturers where org_id = $1::uuid and id = any($2::uuid[])`,
    [manifest.orgId, ids.manufacturerIds]
  );
  return deleted;
}

async function persistCleanupTerminalState(config, current, terminal, cleanupEvidence = {}) {
  const next = buildV3Transition(
    current,
    {
      setup: 'ready',
      runtime: current.state.runtime,
      cleanup: terminal,
    },
    { cleanupEvidence }
  );
  return replaceV3Manifest(config, current, next, { allowCleanupMarker: true }).manifest;
}

async function cleanupPendingTransferFixture(config, manifest) {
  const initial = normalizeV3Manifest(manifest);
  normalizePendingTransferCleanupIdentity(initial);
  const lock = acquireV3LifecycleLock(config, initial.tag, 'cleanup');
  let attemptManifest = null;
  let transactionBodyComplete = false;
  let commitKnown = false;
  let before = {};
  let deleted = {};
  try {
    const current = readV3ManifestInternal(config, initial.tag);
    normalizePendingTransferCleanupIdentity(current);
    createCleanupAttemptMarker(config, current.tag);
    attemptManifest = buildV3Transition(
      current,
      { setup: 'ready', runtime: current.state.runtime, cleanup: 'attempt_started' }
    );
    attemptManifest = replaceV3Manifest(config, current, attemptManifest, {
      allowCleanupMarker: true,
    }).manifest;

    const transactionResult = await withMutation(async (client) => {
      before = await countPendingTransferFixture(client, attemptManifest);
      assertPendingTransferStageBudget(before, attemptManifest.state.runtime);
      const preCleanupBaseline = await capturePendingFixtureBaseline(
        client,
        config,
        attemptManifest.ids
      );
      assertBaselineEvidenceEqual(attemptManifest.baseline, preCleanupBaseline);
      deleted = await deletePendingTransferFixtureRows(client, attemptManifest);
      const transactionalAfter = await countPendingTransferFixture(client, attemptManifest);
      assertAllFixtureCountsZero(transactionalAfter);
      transactionBodyComplete = true;
      return transactionalAfter;
    });
    commitKnown = true;

    const postCommit = await withFixtureReadOnlySnapshot(async (client) => {
      const after = await countPendingTransferFixture(client, attemptManifest);
      assertAllFixtureCountsZero(after);
      const restored = await capturePendingFixtureBaseline(client, config, attemptManifest.ids);
      assertBaselineEvidenceEqual(attemptManifest.baseline, restored);
      const dealerAfter = await captureDealerTableIntegrity(client);
      if (!dealerTableIntegrityMatches(attemptManifest.integrity.dealerTableBefore, dealerAfter)) {
        throw new FixtureSafetyError('DEALER_BASELINE_DRIFT', 'Protected dealer baseline was not restored.');
      }
      return { after, dealerRestored: true };
    });

    const succeeded = await persistCleanupTerminalState(
      config,
      attemptManifest,
      'succeeded',
      {
        fixtureEmpty: true,
        baselineRestored: true,
        expectedZero: true,
        dealerRestored: postCommit.dealerRestored,
      }
    );
    Object.assign(manifest, succeeded);
    releaseV3LifecycleLock(lock);
    return {
      ok: true,
      tag: '<private-v3-namespace>',
      ids: {},
      before,
      deleted,
      after: postCommit.after,
      dealerIntegrity: { baselinePresent: true, restored: true },
      transactionAfter: transactionResult,
    };
  } catch (error) {
    if (attemptManifest) {
      try {
        if (!commitKnown && transactionBodyComplete) {
          attemptManifest = await persistCleanupTerminalState(
            config,
            attemptManifest,
            'recovery_required',
            { commitOutcome: 'ambiguous' }
          );
          createCommitAmbiguityMarker(config, initial.tag);
        } else if (!commitKnown) {
          attemptManifest = await persistCleanupTerminalState(
            config,
            attemptManifest,
            'failed',
            { databaseTransaction: 'rolled_back' }
          );
        } else {
          attemptManifest = await persistCleanupTerminalState(
            config,
            attemptManifest,
            'recovery_required',
            { postCommitVerification: 'failed' }
          );
          createRecoveryMarker(config, initial.tag);
        }
        Object.assign(manifest, attemptManifest);
      } catch (_stateError) {
        // The permanent cleanup marker and attempt_started manifest remain authoritative.
      }
    }
    if (error instanceof FixtureSafetyError) {
      throw error;
    }
    throw new FixtureSafetyError('V3_CLEANUP_FAILED', 'Pending-transfer fixture cleanup failed.');
  }
}

async function cleanupFixture(config, { tag, manifest }) {
  if (Number(manifest?.version) === 3) {
    return cleanupPendingTransferFixture(config, manifest);
  }
  return withMutation(async (client) => {
    const discovered = await discoverFixtureIds(client, config.orgId, tag);
    const identity = normalizeFixtureIdentity({ tag, manifest, discovered });
    assertSafeFixtureIdentity(identity);
    const before = await countFixtureRecords(client, config.orgId, identity);
    const ids = identity.ids || {};
    const fixtureDealer = identity.fixtureDealer || {};
    const params = [
      config.orgId,
      ids.jobIds || [],
      ids.jobNumbers || [],
      ids.phaseIds || [],
      ids.requirementIds || [],
      ids.allocationIds || [],
      ids.boxIds || [],
      ids.filmOrderIds || [],
      identity.tag,
      asText(fixtureDealer.id) || null,
      asText(fixtureDealer.code),
      asText(fixtureDealer.name),
    ];
    const paramCte = `
      with fixture_params as (
        select
          $1::uuid as org_id,
          $2::uuid[] as job_ids,
          $3::text[] as job_numbers,
          $4::uuid[] as phase_ids,
          $5::uuid[] as requirement_ids,
          $6::text[] as allocation_ids,
          $7::text[] as box_ids,
          $8::text[] as film_order_ids,
          $9::text as tag,
          $10::uuid as dealer_id,
          $11::text as dealer_code,
          $12::text as dealer_name
      )
    `;
    const deleted = {};
    if (integer(before.transfers) > 0) {
      await client.query('savepoint fixture_transfer_cleanup');
      try {
        await client.query(
          'alter table app.box_transfers disable trigger trg_0191_guard_box_transfers'
        );
        await client.query(
          'alter table app.box_transfers disable trigger trg_0191_transfer_consistency_transfer'
        );
        const transferDeleteResult = await client.query(
          `${paramCte}
          delete from app.box_transfers target
          using fixture_params p
          where target.org_id = p.org_id
            and (
              target.source_box_id = any(p.box_ids)
              or target.destination_box_id = any(p.box_ids)
              or target.created_by = p.tag
              or target.updated_by = p.tag
            )`,
          params
        );
        await client.query(
          'alter table app.box_transfers enable trigger trg_0191_transfer_consistency_transfer'
        );
        await client.query(
          'alter table app.box_transfers enable trigger trg_0191_guard_box_transfers'
        );
        await client.query('release savepoint fixture_transfer_cleanup');
        deleted.box_transfers = integer(transferDeleteResult.rowCount);
      } catch (error) {
        await client.query('rollback to savepoint fixture_transfer_cleanup');
        throw error;
      }
    }

    const deletionSql = [
      `${paramCte}
      delete from app.box_id_aliases target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.old_box_id = any(p.box_ids)
          or target.canonical_box_id = any(p.box_ids)
        )`,
      `${paramCte}
      delete from app.roll_weight_log target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.box_id = any(p.box_ids)
          or target.job_id = any(p.job_ids)
          or target.job_number = any(p.job_numbers)
          or target.checked_out_by = p.tag
          or target.checked_in_by = p.tag
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.audit_log target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.box_id = any(p.box_ids)
          or target.actor = p.tag
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.film_order_box_links target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.film_order_id = any(p.film_order_ids)
          or target.box_id = any(p.box_ids)
        )`,
      `${paramCte}
      delete from app.allocations target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.allocation_id = any(p.allocation_ids)
          or target.job_id = any(p.job_ids)
          or target.box_id = any(p.box_ids)
          or target.requirement_id = any(p.requirement_ids)
          or target.created_by = p.tag
          or target.resolved_by = p.tag
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.film_orders target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.film_order_id = any(p.film_order_ids)
          or target.job_id = any(p.job_ids)
          or target.job_number = any(p.job_numbers)
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.film_catalog target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.source_box_id = any(p.box_ids)
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.job_caulk_requirements target
      using fixture_params p
      where target.org_id = p.org_id
        and target.job_id = any(p.job_ids)`,
      `${paramCte}
      delete from app.job_requirements target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.id = any(p.requirement_ids)
          or target.job_id = any(p.job_ids)
          or target.notes = p.tag
          or target.created_by = p.tag
        )`,
      `${paramCte}
      delete from app.job_phases target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.id = any(p.phase_ids)
          or target.job_id = any(p.job_ids)
          or target.sections = p.tag
          or target.created_by = p.tag
        )`,
      `${paramCte}
      delete from app.jobs target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.id = any(p.job_ids)
          or target.job_number = any(p.job_numbers)
          or target.notes = p.tag
          or target.created_by = p.tag
        )`,
      `${paramCte}
      delete from app.boxes target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.box_id = any(p.box_ids)
          or target.notes = p.tag
          or target.lot_run = p.tag
          or target.zeroed_by = p.tag
        )`,
      `${paramCte}
      delete from app.box_dealers target
      using fixture_params p
      where target.org_id = p.org_id
        and target.id = p.dealer_id
        and target.lookup_key = p.dealer_code
        and target.name = p.dealer_name`,
    ];
    for (const sql of deletionSql) {
      const table = sql.match(/delete from app\.([a-z_]+)/)?.[1] || 'unknown';
      const result = await client.query(sql, params);
      deleted[table] = (deleted[table] || 0) + integer(result.rowCount);
    }
    const after = await countFixtureRecords(client, config.orgId, identity);
    const remaining = Object.values(after).reduce((sum, value) => sum + integer(value), 0);
    const dealerBaseline = identity.integrity?.dealerTableBefore || {};
    const dealerBaselinePresent = (
      Number.isSafeInteger(dealerBaseline.rowCount) && Boolean(dealerBaseline.fingerprint)
    );
    const dealerAfter = dealerBaselinePresent
      ? await captureDealerTableIntegrity(client)
      : null;
    const dealerIntegrityRestored = dealerBaselinePresent
      ? dealerTableIntegrityMatches(dealerBaseline, dealerAfter)
      : !asText(fixtureDealer.id);
    return {
      ok: remaining === 0 && dealerIntegrityRestored,
      tag: identity.tag,
      ids: identity.ids,
      before,
      deleted,
      after,
      dealerIntegrity: {
        baselinePresent: dealerBaselinePresent,
        restored: dealerIntegrityRestored,
      },
    };
  });
}

async function createFixture(config, { scenario, tag }) {
  const normalizedTag = normalizeFixtureTag(tag, scenario);
  if (scenario === PENDING_TRANSFER_CHECKOUT_SCENARIO) {
    return createPendingTransferCheckoutDenial(config, normalizedTag);
  }
  const existing = await verifyFixture(config, { tag: normalizedTag, manifest: null });
  if (Object.values(existing.counts || {}).some((value) => integer(value) > 0)) {
    throw new Error('Fixture tag already owns DEV records; cleanup or use a fresh fixture tag.');
  }
  const dealerPreflight = await prepareFixtureDealer(config, normalizedTag);
  if (scenario === 'checked-out-box-job') {
    return createCheckedOutBoxJob(config, normalizedTag, dealerPreflight);
  }
  if (scenario === 'allocation-eligibility') {
    return createAllocationEligibility(config, normalizedTag, dealerPreflight);
  }
  if (scenario === 'atomic-transfer-assisted-allocation') {
    return createAtomicTransferAssistedAllocation(config, normalizedTag, dealerPreflight);
  }
  if (scenario === 'allocation-timeout-remediation') {
    return createAllocationTimeoutRemediation(config, normalizedTag, dealerPreflight);
  }
  throw new Error(`Unsupported fixture scenario: ${scenario}`);
}

export {
  capturePendingFixtureBaseline,
  cleanupFixture,
  cleanupPendingTransferFixture,
  countPendingTransferFixture,
  captureDealerTableIntegrity,
  createFixture,
  createFixtureDealer,
  discoverFixtureIds,
  prepareFixtureDealer,
  recordPendingTransferRuntimeStage,
  verifyFixture,
};
