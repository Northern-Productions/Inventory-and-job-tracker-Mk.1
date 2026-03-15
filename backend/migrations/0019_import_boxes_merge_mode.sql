-- Adds non-destructive box merge support for import.boxes_raw.
-- This keeps existing app.boxes rows and appends (or upserts) staging rows.
--
-- New functions:
-- 1) import.normalize_existing_box_ids(target_org_id uuid)
--    - Normalizes existing app.boxes IDs to prefixed form (IL-/M/custom prefix).
--    - Updates dependent box-id references in related tables.
-- 2) import.merge_boxes_from_staging(
--      target_org_id uuid,
--      normalize_existing boolean default true,
--      conflict_mode text default 'keep_existing'
--    )
--    - Loads import.boxes_raw into app.boxes without deleting org data.
--    - conflict_mode:
--      - keep_existing: skip incoming rows when box_id already exists.
--      - overwrite_existing: update existing rows from staging values.

create or replace function import.canonical_box_id(
  target_org_id uuid,
  warehouse_code text,
  raw_box_id text
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, import
as $$
declare
  v_box_id text := upper(btrim(coalesce(raw_box_id, '')));
  v_warehouse text := upper(btrim(coalesce(warehouse_code, '')));
  v_prefix text := '';
begin
  if v_box_id = '' then
    return '';
  end if;

  -- Already in canonical IL/MS-prefixed form.
  if v_box_id like 'IL-%' or left(v_box_id, 1) = 'M' then
    return v_box_id;
  end if;

  -- Preserve other explicit prefixed forms (for future/custom warehouse codes).
  if v_box_id ~ '^[A-Z0-9]{2,8}-.+' then
    return v_box_id;
  end if;

  if target_org_id is not null and v_warehouse <> '' then
    select coalesce(w.box_id_prefix, '')
    into v_prefix
    from app.warehouses w
    where w.org_id = target_org_id
      and w.code = v_warehouse
    limit 1;
  end if;

  if v_prefix <> '' then
    return v_prefix || v_box_id;
  end if;

  -- Preserve historical IL-style canonicalization.
  if v_warehouse = 'IL' then
    return 'IL-' || v_box_id;
  end if;

  if v_warehouse = 'MS' then
    return 'M' || v_box_id;
  end if;

  return v_box_id;
end;
$$;

create or replace function import.normalize_existing_box_ids(target_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, import
as $$
declare
  v_candidate_count integer := 0;
  v_collision_count integer := 0;
  v_boxes_updated integer := 0;
  v_allocations_updated integer := 0;
  v_links_updated integer := 0;
  v_roll_log_updated integer := 0;
  v_audit_log_updated integer := 0;
  v_film_orders_updated integer := 0;
  v_film_catalog_updated integer := 0;
  v_collision_sample text := '';
begin
  if target_org_id is null then
    raise exception 'target_org_id is required';
  end if;

  if not exists (
    select 1
    from app.organizations o
    where o.id = target_org_id
  ) then
    raise exception 'Organization % does not exist in app.organizations', target_org_id;
  end if;

  create temporary table tmp_box_id_map (
    old_box_id text primary key,
    new_box_id text not null
  ) on commit drop;

  insert into tmp_box_id_map (old_box_id, new_box_id)
  select
    b.box_id,
    import.canonical_box_id(target_org_id, b.warehouse, b.box_id)
  from app.boxes b
  where b.org_id = target_org_id
    and btrim(b.box_id) <> ''
    and import.canonical_box_id(target_org_id, b.warehouse, b.box_id) <> b.box_id;

  select count(*)
  into v_candidate_count
  from tmp_box_id_map;

  if v_candidate_count = 0 then
    return jsonb_build_object(
      'normalized_candidates', 0,
      'boxes_updated', 0,
      'allocations_updated', 0,
      'film_order_box_links_updated', 0,
      'roll_weight_log_updated', 0,
      'audit_log_updated', 0,
      'film_orders_source_box_id_updated', 0,
      'film_catalog_source_box_id_updated', 0
    );
  end if;

  -- Collision 1: two existing rows normalize to the same target box_id.
  select count(*)
  into v_collision_count
  from (
    select m.new_box_id
    from tmp_box_id_map m
    group by m.new_box_id
    having count(*) > 1
  ) d;

  if v_collision_count > 0 then
    select string_agg(format('%s->%s', x.old_box_id, x.new_box_id), ', ')
    into v_collision_sample
    from (
      select m.old_box_id, m.new_box_id
      from tmp_box_id_map m
      where m.new_box_id in (
        select m2.new_box_id
        from tmp_box_id_map m2
        group by m2.new_box_id
        having count(*) > 1
      )
      order by m.old_box_id
      limit 10
    ) x;

    raise exception
      'BoxID normalization collision (multiple rows map to same new BoxID). Sample: %',
      coalesce(v_collision_sample, '(none)');
  end if;

  -- Collision 2: normalized ID already exists in another row not being renamed.
  select count(*)
  into v_collision_count
  from tmp_box_id_map m
  join app.boxes b
    on b.org_id = target_org_id
   and b.box_id = m.new_box_id
   and b.box_id <> m.old_box_id;

  if v_collision_count > 0 then
    select string_agg(format('%s->%s (existing target)', x.old_box_id, x.new_box_id), ', ')
    into v_collision_sample
    from (
      select m.old_box_id, m.new_box_id
      from tmp_box_id_map m
      join app.boxes b
        on b.org_id = target_org_id
       and b.box_id = m.new_box_id
       and b.box_id <> m.old_box_id
      order by m.old_box_id
      limit 10
    ) x;

    raise exception
      'BoxID normalization collision (target BoxID already exists). Sample: %',
      coalesce(v_collision_sample, '(none)');
  end if;

  update app.allocations a
  set box_id = m.new_box_id
  from tmp_box_id_map m
  where a.org_id = target_org_id
    and a.box_id = m.old_box_id;
  get diagnostics v_allocations_updated = row_count;

  update app.film_order_box_links l
  set box_id = m.new_box_id
  from tmp_box_id_map m
  where l.org_id = target_org_id
    and l.box_id = m.old_box_id;
  get diagnostics v_links_updated = row_count;

  update app.roll_weight_log rw
  set box_id = m.new_box_id
  from tmp_box_id_map m
  where rw.org_id = target_org_id
    and rw.box_id = m.old_box_id;
  get diagnostics v_roll_log_updated = row_count;

  update app.audit_log al
  set box_id = m.new_box_id
  from tmp_box_id_map m
  where al.org_id = target_org_id
    and al.box_id = m.old_box_id;
  get diagnostics v_audit_log_updated = row_count;

  update app.film_orders fo
  set source_box_id = m.new_box_id
  from tmp_box_id_map m
  where fo.org_id = target_org_id
    and fo.source_box_id = m.old_box_id;
  get diagnostics v_film_orders_updated = row_count;

  update app.film_catalog fc
  set source_box_id = m.new_box_id,
      updated_at = now()
  from tmp_box_id_map m
  where fc.org_id = target_org_id
    and fc.source_box_id = m.old_box_id;
  get diagnostics v_film_catalog_updated = row_count;

  update app.boxes b
  set box_id = m.new_box_id,
      updated_at = now()
  from tmp_box_id_map m
  where b.org_id = target_org_id
    and b.box_id = m.old_box_id;
  get diagnostics v_boxes_updated = row_count;

  return jsonb_build_object(
    'normalized_candidates', v_candidate_count,
    'boxes_updated', v_boxes_updated,
    'allocations_updated', v_allocations_updated,
    'film_order_box_links_updated', v_links_updated,
    'roll_weight_log_updated', v_roll_log_updated,
    'audit_log_updated', v_audit_log_updated,
    'film_orders_source_box_id_updated', v_film_orders_updated,
    'film_catalog_source_box_id_updated', v_film_catalog_updated
  );
end;
$$;

create or replace function import.merge_boxes_from_staging(
  target_org_id uuid,
  normalize_existing boolean default true,
  conflict_mode text default 'keep_existing'
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, import, app_api
as $$
declare
  v_mode text := lower(btrim(coalesce(conflict_mode, 'keep_existing')));
  v_prepared_count integer := 0;
  v_inserted_count integer := 0;
  v_updated_count integer := 0;
  v_skipped_count integer := 0;
  v_existing_conflicts integer := 0;
  v_stage_duplicates integer := 0;
  v_normalize_result jsonb := '{}'::jsonb;
begin
  if target_org_id is null then
    raise exception 'target_org_id is required';
  end if;

  if not exists (
    select 1
    from app.organizations o
    where o.id = target_org_id
  ) then
    raise exception 'Organization % does not exist in app.organizations', target_org_id;
  end if;

  if v_mode not in ('keep_existing', 'overwrite_existing') then
    raise exception 'Invalid conflict_mode %. Allowed values: keep_existing, overwrite_existing', conflict_mode;
  end if;

  -- Make sure IL/MS warehouse defaults exist for older orgs.
  perform app_api.ensure_default_warehouses_for_org(target_org_id, 'import-merge');

  if normalize_existing then
    v_normalize_result := import.normalize_existing_box_ids(target_org_id);
  end if;

  create temporary table tmp_import_boxes_prepared on commit drop as
  with src as (
    select
      trim("BoxID") as raw_box_id,
      trim("Manufacturer") as manufacturer,
      trim("FilmName") as film_name,
      trim("WidthIn") as width_in_raw,
      trim("InitialFeet") as initial_feet_raw,
      trim("FeetAvailable") as feet_available_raw,
      trim("LotRun") as lot_run_raw,
      trim("Status") as status_raw,
      trim("OrderDate") as order_date_raw,
      trim("ReceivedDate") as received_date_raw,
      trim("InitialWeightLbs") as initial_weight_lbs_raw,
      trim("LastRollWeightLbs") as last_roll_weight_lbs_raw,
      trim("LastWeighedDate") as last_weighed_date_raw,
      trim("FilmKey") as film_key_raw,
      trim("CoreType") as core_type_raw,
      trim("CoreWeightLbs") as core_weight_lbs_raw,
      trim("LfWeightLbsPerFt") as lf_weight_lbs_per_ft_raw,
      trim("PurchaseCost") as purchase_cost_raw,
      trim("Notes") as notes_raw,
      trim("HasEverBeenCheckedOut") as has_ever_raw,
      trim("LastCheckoutJob") as last_checkout_job_raw,
      trim("LastCheckoutDate") as last_checkout_date_raw,
      trim("ZeroedDate") as zeroed_date_raw,
      trim("ZeroedReason") as zeroed_reason_raw,
      trim("ZeroedBy") as zeroed_by_raw
    from import.boxes_raw
    where coalesce(trim("BoxID"), '') <> ''
  ),
  canon as (
    select
      import.canonical_box_id(
        target_org_id,
        case when upper(left(raw_box_id, 1)) = 'M' then 'MS' else 'IL' end,
        raw_box_id
      ) as box_id,
      manufacturer,
      film_name,
      width_in_raw,
      initial_feet_raw,
      feet_available_raw,
      lot_run_raw,
      status_raw,
      order_date_raw,
      received_date_raw,
      initial_weight_lbs_raw,
      last_roll_weight_lbs_raw,
      last_weighed_date_raw,
      film_key_raw,
      core_type_raw,
      core_weight_lbs_raw,
      lf_weight_lbs_per_ft_raw,
      purchase_cost_raw,
      notes_raw,
      has_ever_raw,
      last_checkout_job_raw,
      last_checkout_date_raw,
      zeroed_date_raw,
      zeroed_reason_raw,
      zeroed_by_raw
    from src
  )
  select
    c.box_id,
    app_api.resolve_warehouse_from_box_id(target_org_id, c.box_id) as warehouse,
    c.manufacturer,
    c.film_name,
    nullif(c.width_in_raw, '')::numeric(10, 4) as width_in,
    nullif(c.initial_feet_raw, '')::integer as initial_feet,
    coalesce(nullif(c.feet_available_raw, '')::integer, 0) as feet_available,
    coalesce(c.lot_run_raw, '') as lot_run,
    (
      case
        when upper(coalesce(c.status_raw, '')) in ('ORDERED', 'IN_STOCK', 'CHECKED_OUT', 'ZEROED', 'RETIRED')
          then upper(c.status_raw)
        when nullif(c.received_date_raw, '') is not null and nullif(c.received_date_raw, '')::date <= current_date
          then 'IN_STOCK'
        else 'ORDERED'
      end
    )::app.box_status as status,
    nullif(c.order_date_raw, '')::date as order_date,
    nullif(c.received_date_raw, '')::date as received_date,
    nullif(c.initial_weight_lbs_raw, '')::numeric(12, 2) as initial_weight_lbs,
    nullif(c.last_roll_weight_lbs_raw, '')::numeric(12, 2) as last_roll_weight_lbs,
    nullif(c.last_weighed_date_raw, '')::date as last_weighed_date,
    coalesce(nullif(c.film_key_raw, ''), upper(c.manufacturer) || '|' || upper(c.film_name)) as film_key,
    coalesce(nullif(c.core_type_raw, ''), '') as core_type,
    nullif(c.core_weight_lbs_raw, '')::numeric(12, 4) as core_weight_lbs,
    nullif(c.lf_weight_lbs_per_ft_raw, '')::numeric(12, 6) as lf_weight_lbs_per_ft,
    nullif(c.purchase_cost_raw, '')::numeric(12, 2) as purchase_cost,
    coalesce(c.notes_raw, '') as notes,
    import.to_bool(c.has_ever_raw) as has_ever_been_checked_out,
    coalesce(c.last_checkout_job_raw, '') as last_checkout_job,
    nullif(c.last_checkout_date_raw, '')::date as last_checkout_date,
    nullif(c.zeroed_date_raw, '')::date as zeroed_date,
    coalesce(c.zeroed_reason_raw, '') as zeroed_reason,
    coalesce(c.zeroed_by_raw, '') as zeroed_by
  from canon c
  where coalesce(c.box_id, '') <> '';

  select count(*)
  into v_stage_duplicates
  from (
    select t.box_id
    from tmp_import_boxes_prepared t
    group by t.box_id
    having count(*) > 1
  ) d;

  if v_stage_duplicates > 0 then
    raise exception
      'Staging contains % canonical BoxID duplicate(s) after prefix normalization. Resolve duplicates before merge.',
      v_stage_duplicates;
  end if;

  select count(*)
  into v_prepared_count
  from tmp_import_boxes_prepared;

  select count(*)
  into v_existing_conflicts
  from tmp_import_boxes_prepared t
  join app.boxes b
    on b.org_id = target_org_id
   and b.box_id = t.box_id;

  if v_mode = 'keep_existing' then
    insert into app.boxes (
      id,
      org_id,
      box_id,
      warehouse,
      manufacturer,
      film_name,
      width_in,
      initial_feet,
      feet_available,
      lot_run,
      status,
      order_date,
      received_date,
      initial_weight_lbs,
      last_roll_weight_lbs,
      last_weighed_date,
      film_key,
      core_type,
      core_weight_lbs,
      lf_weight_lbs_per_ft,
      purchase_cost,
      notes,
      has_ever_been_checked_out,
      last_checkout_job,
      last_checkout_date,
      zeroed_date,
      zeroed_reason,
      zeroed_by
    )
    select
      gen_random_uuid(),
      target_org_id,
      t.box_id,
      t.warehouse,
      t.manufacturer,
      t.film_name,
      t.width_in,
      t.initial_feet,
      t.feet_available,
      t.lot_run,
      t.status,
      t.order_date,
      t.received_date,
      t.initial_weight_lbs,
      t.last_roll_weight_lbs,
      t.last_weighed_date,
      t.film_key,
      t.core_type,
      t.core_weight_lbs,
      t.lf_weight_lbs_per_ft,
      t.purchase_cost,
      t.notes,
      t.has_ever_been_checked_out,
      t.last_checkout_job,
      t.last_checkout_date,
      t.zeroed_date,
      t.zeroed_reason,
      t.zeroed_by
    from tmp_import_boxes_prepared t
    on conflict (org_id, box_id) do nothing;

    get diagnostics v_inserted_count = row_count;
    v_updated_count := 0;
    v_skipped_count := v_prepared_count - v_inserted_count;
  else
    insert into app.boxes (
      id,
      org_id,
      box_id,
      warehouse,
      manufacturer,
      film_name,
      width_in,
      initial_feet,
      feet_available,
      lot_run,
      status,
      order_date,
      received_date,
      initial_weight_lbs,
      last_roll_weight_lbs,
      last_weighed_date,
      film_key,
      core_type,
      core_weight_lbs,
      lf_weight_lbs_per_ft,
      purchase_cost,
      notes,
      has_ever_been_checked_out,
      last_checkout_job,
      last_checkout_date,
      zeroed_date,
      zeroed_reason,
      zeroed_by
    )
    select
      gen_random_uuid(),
      target_org_id,
      t.box_id,
      t.warehouse,
      t.manufacturer,
      t.film_name,
      t.width_in,
      t.initial_feet,
      t.feet_available,
      t.lot_run,
      t.status,
      t.order_date,
      t.received_date,
      t.initial_weight_lbs,
      t.last_roll_weight_lbs,
      t.last_weighed_date,
      t.film_key,
      t.core_type,
      t.core_weight_lbs,
      t.lf_weight_lbs_per_ft,
      t.purchase_cost,
      t.notes,
      t.has_ever_been_checked_out,
      t.last_checkout_job,
      t.last_checkout_date,
      t.zeroed_date,
      t.zeroed_reason,
      t.zeroed_by
    from tmp_import_boxes_prepared t
    on conflict (org_id, box_id) do update set
      warehouse = excluded.warehouse,
      manufacturer = excluded.manufacturer,
      film_name = excluded.film_name,
      width_in = excluded.width_in,
      initial_feet = excluded.initial_feet,
      feet_available = excluded.feet_available,
      lot_run = excluded.lot_run,
      status = excluded.status,
      order_date = excluded.order_date,
      received_date = excluded.received_date,
      initial_weight_lbs = excluded.initial_weight_lbs,
      last_roll_weight_lbs = excluded.last_roll_weight_lbs,
      last_weighed_date = excluded.last_weighed_date,
      film_key = excluded.film_key,
      core_type = excluded.core_type,
      core_weight_lbs = excluded.core_weight_lbs,
      lf_weight_lbs_per_ft = excluded.lf_weight_lbs_per_ft,
      purchase_cost = excluded.purchase_cost,
      notes = excluded.notes,
      has_ever_been_checked_out = excluded.has_ever_been_checked_out,
      last_checkout_job = excluded.last_checkout_job,
      last_checkout_date = excluded.last_checkout_date,
      zeroed_date = excluded.zeroed_date,
      zeroed_reason = excluded.zeroed_reason,
      zeroed_by = excluded.zeroed_by,
      updated_at = now();

    -- On overwrite mode, all prepared rows are applied.
    v_inserted_count := v_prepared_count - v_existing_conflicts;
    v_updated_count := v_existing_conflicts;
    v_skipped_count := 0;
  end if;

  return jsonb_build_object(
    'mode', v_mode,
    'prepared_rows', v_prepared_count,
    'existing_conflicts', v_existing_conflicts,
    'inserted_rows', v_inserted_count,
    'updated_rows', v_updated_count,
    'skipped_rows', v_skipped_count,
    'normalize_existing_applied', normalize_existing,
    'normalize_existing_result', v_normalize_result
  );
end;
$$;
