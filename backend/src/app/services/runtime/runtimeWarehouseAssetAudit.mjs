import { queryRow, queryRows } from '../../../db/client.mjs';
import { HttpError } from '../../../lib/http.mjs';
import {
  WarehouseAssetAuditError,
  buildWarehouseAssetAuditReport,
} from '../../../../../shared/domain/warehouseAssetAudit.mjs';

async function buildWarehouseAssetAuditFromDatabase(
  client,
  orgId,
  params = {},
  metadata = {},
  deps = {},
) {
  const readRow = deps.queryRow || queryRow;
  const readRows = deps.queryRows || queryRows;
  const onLogicalRead =
    typeof deps.onLogicalRead === 'function' ? deps.onLogicalRead : () => {};
  const readOne = async (name, sql, values) => {
    onLogicalRead(name);
    return readRow(client, sql, values);
  };
  const readMany = async (name, sql, values) => {
    onLogicalRead(name);
    return readRows(client, sql, values);
  };

  const organization = await readOne(
    'organization',
    `
      select id as org_id, name
      from app.organizations
      where id = $1::uuid
    `,
    [orgId],
  );
  const warehouses = await readMany(
    'warehouses',
    `
      select org_id, code, name
      from app.warehouses
      where org_id = $1::uuid
      order by code
    `,
    [orgId],
  );
  const owners = await readMany(
    'owners',
    `
      select id, org_id, code, display_name, is_active
      from app.owner_companies
      where org_id = $1::uuid
      order by code, id
    `,
    [orgId],
  );
  const boxes = await readMany(
    'boxes',
    `
      select
        b.id,
        b.org_id,
        b.box_id,
        b.warehouse,
        b.owner_company_id,
        b.manufacturer,
        b.film_name,
        b.width_in,
        b.initial_feet,
        b.feet_available,
        b.status,
        b.direct_to_job_site,
        b.last_checkout_job_id,
        b.last_checkout_job,
        b.last_roll_weight_lbs,
        b.core_weight_lbs,
        b.lf_weight_lbs_per_ft,
        b.price_per_lf,
        b.purchase_cost,
        app_api.box_physical_feet_available(b)::integer as physical_feet_available
      from app.boxes b
      where b.org_id = $1::uuid
      order by b.box_id, b.id
    `,
    [orgId],
  );
  const pendingTransfers = await readMany(
    'pending-transfers',
    `
      select
        org_id,
        box_record_id,
        source_warehouse,
        destination_warehouse,
        status
      from app.box_transfers
      where org_id = $1::uuid
        and status = 'PENDING'
      order by box_record_id, created_at, id
    `,
    [orgId],
  );
  const hasCheckedOutBoxes = boxes.some(
    (box) => String(box?.status || '').trim().toUpperCase() === 'CHECKED_OUT',
  );
  const checkoutContext = hasCheckedOutBoxes
    ? await readOne(
        'checked-out-context',
        `
          with checked_boxes as (
            select
              b.id,
              b.box_id,
              b.warehouse::text as warehouse,
              b.last_checkout_job_id,
              b.last_checkout_job,
              b.direct_to_job_site
            from app.boxes b
            where b.org_id = $1::uuid
              and b.status = 'CHECKED_OUT'
          ),
          direct_links as (
            select
              l.id,
              l.org_id,
              l.box_id,
              l.film_order_id
            from app.film_order_box_links l
            join checked_boxes b
              on b.box_id = l.box_id
             and b.direct_to_job_site
            where l.org_id = $1::uuid
          ),
          direct_orders as (
            select distinct
              f.id,
              f.org_id,
              f.film_order_id,
              f.job_id,
              f.job_number,
              f.warehouse::text as warehouse,
              f.crew_leader,
              f.created_at
            from app.film_orders f
            join direct_links l
              on l.film_order_id = f.film_order_id
            where f.org_id = $1::uuid
          ),
          candidate_ids as (
            select last_checkout_job_id as id
            from checked_boxes
            where last_checkout_job_id is not null
            union
            select job_id
            from direct_orders
            where job_id is not null
          ),
          candidate_number_keys as (
            select upper(btrim(last_checkout_job)) as key
            from checked_boxes
            where btrim(coalesce(last_checkout_job, '')) <> ''
            union
            select case
              when upper(btrim(last_checkout_job)) like upper(warehouse) || '-%'
                then substring(upper(btrim(last_checkout_job)) from length(warehouse) + 2)
              else upper(btrim(last_checkout_job))
            end
            from checked_boxes
            where btrim(coalesce(last_checkout_job, '')) <> ''
            union
            select upper(btrim(job_number))
            from direct_orders
            where btrim(coalesce(job_number, '')) <> ''
            union
            select case
              when upper(btrim(job_number)) like upper(warehouse) || '-%'
                then substring(upper(btrim(job_number)) from length(warehouse) + 2)
              else upper(btrim(job_number))
            end
            from direct_orders
            where btrim(coalesce(job_number, '')) <> ''
          ),
          candidate_jobs as (
            select distinct j.*
            from app.jobs j
            where j.org_id = $1::uuid
              and (
                j.id in (select id from candidate_ids)
                or upper(btrim(j.job_number)) in (select key from candidate_number_keys)
                or case
                    when upper(btrim(j.job_number)) like upper(j.warehouse::text) || '-%'
                      then substring(upper(btrim(j.job_number)) from length(j.warehouse::text) + 2)
                    else upper(btrim(j.job_number))
                  end in (select key from candidate_number_keys)
              )
          ),
          candidate_job_keys as (
            select upper(btrim(job_number)) as key
            from candidate_jobs
            union
            select case
              when upper(btrim(job_number)) like upper(warehouse::text) || '-%'
                then substring(upper(btrim(job_number)) from length(warehouse::text) + 2)
              else upper(btrim(job_number))
            end
            from candidate_jobs
          ),
          context_film_orders as (
            select distinct f.*
            from app.film_orders f
            where f.org_id = $1::uuid
              and (
                f.id in (select id from direct_orders)
                or f.job_id in (select id from candidate_jobs)
                or (
                  f.job_id is null
                  and upper(btrim(f.job_number)) in (select key from candidate_job_keys)
                )
              )
          ),
          context_allocations as (
            select distinct a.*
            from app.allocations a
            where a.org_id = $1::uuid
              and (
                a.job_id in (select id from candidate_jobs)
                or (
                  a.job_id is null
                  and upper(btrim(a.job_number)) in (select key from candidate_job_keys)
                )
              )
          )
          select jsonb_build_object(
            'jobs',
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', j.id,
                'org_id', j.org_id,
                'job_number', j.job_number,
                'warehouse', j.warehouse,
                'crew_leader', j.crew_leader
              ) order by j.job_number, j.id)
              from candidate_jobs j
            ), '[]'::jsonb),
            'filmOrderBoxLinks',
            coalesce((
              select jsonb_agg(to_jsonb(l) order by l.id)
              from direct_links l
            ), '[]'::jsonb),
            'filmOrders',
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', f.id,
                'org_id', f.org_id,
                'film_order_id', f.film_order_id,
                'job_id', f.job_id,
                'job_number', f.job_number,
                'warehouse', f.warehouse,
                'crew_leader', f.crew_leader,
                'created_at', f.created_at
              ) order by f.created_at, f.id)
              from context_film_orders f
            ), '[]'::jsonb),
            'phases',
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', p.id,
                'org_id', p.org_id,
                'job_id', p.job_id,
                'phase_number', p.phase_number,
                'install_date', p.install_date,
                'crew_leader', p.crew_leader,
                'labor_status', p.labor_status,
                'workflow_status', p.workflow_status,
                'is_primary', p.is_primary
              ) order by p.phase_number, p.id)
              from app.job_phases p
              where p.org_id = $1::uuid
                and p.job_id in (select id from candidate_jobs)
            ), '[]'::jsonb),
            'requirements',
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', r.id,
                'org_id', r.org_id,
                'job_id', r.job_id,
                'phase_id', r.phase_id,
                'status', r.status
              ) order by r.id)
              from app.job_requirements r
              where r.org_id = $1::uuid
                and r.job_id in (select id from candidate_jobs)
            ), '[]'::jsonb),
            'caulkRequirements',
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', r.id,
                'org_id', r.org_id,
                'job_id', r.job_id,
                'phase_id', r.phase_id,
                'status', r.status
              ) order by r.id)
              from app.job_caulk_requirements r
              where r.org_id = $1::uuid
                and r.job_id in (select id from candidate_jobs)
            ), '[]'::jsonb),
            'allocations',
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', a.id,
                'org_id', a.org_id,
                'job_id', a.job_id,
                'job_number', a.job_number,
                'warehouse', a.warehouse,
                'crew_leader', a.crew_leader,
                'created_at', a.created_at
              ) order by a.created_at, a.id)
              from context_allocations a
            ), '[]'::jsonb)
          ) as checkout_context
        `,
        [orgId],
      )
    : null;

  try {
    return buildWarehouseAssetAuditReport({
      expectedOrgId: orgId,
      organizationName: organization?.name,
      generatedAt: metadata.generatedAt || new Date().toISOString(),
      generatedBy: metadata.generatedBy,
      boxes,
      owners,
      warehouses,
      pendingTransfers,
      allocations: [],
      checkoutContext: checkoutContext?.checkout_context || null,
      filters: params,
    });
  } catch (error) {
    if (error instanceof WarehouseAssetAuditError) {
      throw new HttpError(error.statusCode, error.message, [], { code: error.code });
    }
    throw error;
  }
}

export { buildWarehouseAssetAuditFromDatabase };
