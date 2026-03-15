-- Warehouse Prefix V2
-- Canonical format:
--   warehouse code:  ^[A-Z]{2}[1-9][0-9]*$
--   box id:          CODE-SUFFIX
--
-- This migration adds:
-- 1) indexed warehouse code/prefix validation for new/updated rows,
-- 2) temporary old->new BoxID alias support,
-- 3) org-scoped migration helpers to move IL/MS + IL-/M* to IL1/MS1 + IL1-/MS1-,
-- 4) alias-aware ACL wrappers for box-id entrypoints,
-- 5) updated default warehouse bootstrap and prefix-boundary routing.

create table if not exists app.box_id_aliases (
  org_id uuid not null references app.organizations(id) on delete cascade,
  old_box_id text not null,
  canonical_box_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  primary key (org_id, old_box_id),
  foreign key (org_id, canonical_box_id)
    references app.boxes(org_id, box_id)
    on delete cascade
);

alter table app.box_id_aliases
  drop constraint if exists box_id_aliases_value_format;
alter table app.box_id_aliases
  add constraint box_id_aliases_value_format check (
    old_box_id = upper(btrim(old_box_id))
    and canonical_box_id = upper(btrim(canonical_box_id))
    and btrim(old_box_id) <> ''
    and btrim(canonical_box_id) <> ''
    and old_box_id <> canonical_box_id
  );

create index if not exists idx_box_id_aliases_org_canonical
  on app.box_id_aliases (org_id, canonical_box_id);

create index if not exists idx_box_id_aliases_expiry
  on app.box_id_aliases (expires_at);

create or replace function app_api.normalize_indexed_warehouse_code(
  p_value text,
  p_field_name text default 'Warehouse code'
)
returns text
language plpgsql
immutable
as $$
declare
  v_code text := upper(app_api.require_text(p_value, p_field_name));
begin
  if v_code !~ '^[A-Z]{2}[1-9][0-9]{0,6}$' then
    perform app_api.raise_http(
      400,
      format(
        '%s must match AA1, AA2, ... with 2 letters and 1-based index.',
        coalesce(p_field_name, 'Warehouse code')
      )
    );
  end if;

  return v_code;
end;
$$;

create or replace function app_api.resolve_box_id_alias(
  p_org_id uuid,
  p_box_id text,
  p_reference_time timestamptz default now()
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_input text := upper(app_api.require_text(p_box_id, 'BoxID'));
  v_resolved text;
begin
  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  select a.canonical_box_id
  into v_resolved
  from app.box_id_aliases a
  where a.org_id = p_org_id
    and a.old_box_id = v_input
    and a.expires_at >= coalesce(p_reference_time, now())
  order by a.expires_at desc
  limit 1;

  return coalesce(v_resolved, v_input);
end;
$$;

create or replace function app_api.cleanup_expired_box_id_aliases(p_org_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_deleted integer := 0;
begin
  if p_org_id is null then
    delete from app.box_id_aliases a
    where a.expires_at < now();
  else
    delete from app.box_id_aliases a
    where a.org_id = p_org_id
      and a.expires_at < now();
  end if;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

alter table app.warehouses
  drop constraint if exists warehouses_code_format;
alter table app.warehouses
  add constraint warehouses_code_format check (
    code = upper(btrim(code))
    and code ~ '^[A-Z]{2}[1-9][0-9]{0,6}$'
  ) not valid;

alter table app.warehouses
  drop constraint if exists warehouses_box_id_prefix_format;
alter table app.warehouses
  add constraint warehouses_box_id_prefix_format check (
    box_id_prefix = upper(btrim(box_id_prefix))
    and box_id_prefix ~ '^[A-Z]{2}[1-9][0-9]{0,6}$'
  ) not valid;

alter table app.warehouses
  drop constraint if exists warehouses_code_prefix_match;
alter table app.warehouses
  add constraint warehouses_code_prefix_match check (code = box_id_prefix) not valid;

create or replace function app_api.ensure_default_warehouses_for_org(
  p_org_id uuid,
  p_actor text default 'system'
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if p_org_id is null then
    return;
  end if;

  insert into app.warehouses (
    org_id,
    code,
    name,
    box_id_prefix,
    created_by,
    updated_by
  )
  values
    (p_org_id, 'IL1', 'Wauconda Illinois #1', 'IL1', app_api.trim_text(p_actor), app_api.trim_text(p_actor)),
    (p_org_id, 'MS1', 'Ridgeland Mississippi #1', 'MS1', app_api.trim_text(p_actor), app_api.trim_text(p_actor))
  on conflict (org_id, code) do update set
    name = excluded.name,
    box_id_prefix = excluded.box_id_prefix,
    updated_at = now(),
    updated_by = excluded.updated_by;
end;
$$;

create or replace function app_api.resolve_warehouse_from_box_id(
  p_org_id uuid,
  p_box_id text
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_box_id text := upper(app_api.require_text(p_box_id, 'BoxID'));
  v_match text;
  v_default text;
begin
  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  -- Canonical boundary match first: PREFIX-...
  select w.code
  into v_match
  from app.warehouses w
  where w.org_id = p_org_id
    and w.box_id_prefix <> ''
    and v_box_id like w.box_id_prefix || '-%'
  order by length(w.box_id_prefix) desc, w.code
  limit 1;

  if v_match is not null then
    return v_match;
  end if;

  -- Temporary legacy compatibility for pre-v2 IDs.
  select w.code
  into v_match
  from app.warehouses w
  where w.org_id = p_org_id
    and (
      (w.box_id_prefix = 'M' and v_box_id like 'M%')
      or (w.box_id_prefix = 'IL' and v_box_id like 'IL-%')
    )
  order by length(w.box_id_prefix) desc, w.code
  limit 1;

  if v_match is not null then
    return v_match;
  end if;

  select w.code
  into v_default
  from app.warehouses w
  where w.org_id = p_org_id
    and w.box_id_prefix = ''
  order by w.code
  limit 1;

  if v_default is not null then
    return v_default;
  end if;

  perform app_api.raise_http(
    400,
    'No default warehouse is configured for BoxID values without a prefix.'
  );
  return '';
end;
$$;

create or replace function public.api_acl_list_warehouses(p_org_id uuid)
returns table (
  code text,
  name text,
  box_id_prefix text
)
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  return query
  select
    w.code,
    w.name,
    w.box_id_prefix
  from app.warehouses w
  where w.org_id = p_org_id
  order by
    case
      when w.code = 'IL1' then 0
      when w.code = 'MS1' then 1
      else 2
    end,
    w.code;
end;
$$;

create or replace function public.api_acl_add_warehouse(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_code text := app_api.normalize_indexed_warehouse_code(p_payload->>'code', 'Warehouse code');
  v_name text := app_api.normalize_warehouse_name(p_payload->>'name', 'Warehouse name');
  v_prefix_raw text := app_api.trim_text(p_payload->>'boxIdPrefix');
  v_prefix text;
begin
  perform app_api.require_org_owner(p_org_id);

  if v_prefix_raw = '' then
    v_prefix := v_code;
  else
    v_prefix := app_api.normalize_indexed_warehouse_code(v_prefix_raw, 'BoxID prefix');
  end if;

  if v_prefix <> v_code then
    perform app_api.raise_http(400, 'Warehouse code and BoxID prefix must match.');
  end if;

  if exists (
    select 1
    from app.warehouses w
    where w.org_id = p_org_id
      and w.code = v_code
  ) then
    perform app_api.raise_http(400, format('Warehouse %s already exists.', v_code));
  end if;

  if exists (
    select 1
    from app.warehouses w
    where w.org_id = p_org_id
      and w.box_id_prefix = v_prefix
  ) then
    perform app_api.raise_http(400, format('BoxID prefix %s is already in use.', v_prefix));
  end if;

  insert into app.warehouses (
    org_id,
    code,
    name,
    box_id_prefix,
    created_by,
    updated_by
  )
  values (
    p_org_id,
    v_code,
    v_name,
    v_prefix,
    app_api.trim_text(p_actor),
    app_api.trim_text(p_actor)
  );

  return jsonb_build_object(
    'code', v_code,
    'name', v_name,
    'boxIdPrefix', v_prefix
  );
end;
$$;

create or replace function public.api_acl_find_box_by_id(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_lookup_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');
  v_lookup_box_id := app_api.resolve_box_id_alias(p_org_id, p_box_id);
  return public.api_find_box_by_id(p_org_id, v_lookup_box_id);
end;
$$;

create or replace function public.api_acl_list_allocations_by_box(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_lookup_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'read');
  v_lookup_box_id := app_api.resolve_box_id_alias(p_org_id, p_box_id);
  return public.api_list_allocations_by_box(p_org_id, v_lookup_box_id);
end;
$$;

create or replace function public.api_acl_list_audit_entries_by_box(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_lookup_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'activity_history', 'read');
  v_lookup_box_id := app_api.resolve_box_id_alias(p_org_id, p_box_id);
  return public.api_list_audit_entries_by_box(p_org_id, v_lookup_box_id);
end;
$$;

create or replace function public.api_acl_list_roll_history_by_box(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_lookup_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'activity_history', 'read');
  v_lookup_box_id := app_api.resolve_box_id_alias(p_org_id, p_box_id);
  return public.api_list_roll_history_by_box(p_org_id, v_lookup_box_id);
end;
$$;

create or replace function public.api_acl_boxes_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_lookup_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );
  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  return public.api_boxes_update(p_org_id, p_actor, v_payload);
end;
$$;

create or replace function public.api_acl_boxes_set_status(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_lookup_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );
  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  return public.api_boxes_set_status(p_org_id, p_actor, v_payload);
end;
$$;

create or replace function public.api_acl_boxes_delete(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_lookup_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );
  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  return public.api_boxes_delete(p_org_id, p_actor, v_payload);
end;
$$;

create or replace function import.warehouse_prefix_v2_preflight(target_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, import, app_api
as $$
declare
  v_rename_candidates integer := 0;
  v_duplicate_target_box_ids integer := 0;
  v_existing_target_collisions integer := 0;
  v_legacy_warehouse_rows integer := 0;
  v_total_boxes integer := 0;
  v_collision_sample text := '';
begin
  if target_org_id is null then
    raise exception 'target_org_id is required';
  end if;

  if not exists (select 1 from app.organizations o where o.id = target_org_id) then
    raise exception 'Organization % does not exist in app.organizations', target_org_id;
  end if;

  drop table if exists pg_temp.tmp_prefix_v2_box_map;
  create temporary table tmp_prefix_v2_box_map (
    old_box_id text primary key,
    new_box_id text not null
  ) on commit drop;

  insert into tmp_prefix_v2_box_map (old_box_id, new_box_id)
  select
    b.box_id,
    case
      when b.box_id like 'IL-%' then 'IL1-' || substr(b.box_id, 4)
      when b.box_id ~ '^M[0-9A-Z]+$' then 'MS1-' || substr(b.box_id, 2)
      else b.box_id
    end as new_box_id
  from app.boxes b
  where b.org_id = target_org_id
    and (
      b.box_id like 'IL-%'
      or b.box_id ~ '^M[0-9A-Z]+$'
    );

  select count(*) into v_rename_candidates from tmp_prefix_v2_box_map;

  select count(*)
  into v_duplicate_target_box_ids
  from (
    select m.new_box_id
    from tmp_prefix_v2_box_map m
    group by m.new_box_id
    having count(*) > 1
  ) d;

  select count(*)
  into v_existing_target_collisions
  from tmp_prefix_v2_box_map m
  join app.boxes b
    on b.org_id = target_org_id
   and b.box_id = m.new_box_id
   and b.box_id <> m.old_box_id;

  select count(*)
  into v_legacy_warehouse_rows
  from app.warehouses w
  where w.org_id = target_org_id
    and w.code in ('IL', 'MS');

  select count(*)
  into v_total_boxes
  from app.boxes b
  where b.org_id = target_org_id;

  if v_duplicate_target_box_ids > 0 or v_existing_target_collisions > 0 then
    select string_agg(format('%s->%s', x.old_box_id, x.new_box_id), ', ')
    into v_collision_sample
    from (
      select m.old_box_id, m.new_box_id
      from tmp_prefix_v2_box_map m
      left join app.boxes b
        on b.org_id = target_org_id
       and b.box_id = m.new_box_id
       and b.box_id <> m.old_box_id
      where b.box_id is not null
         or m.new_box_id in (
           select m2.new_box_id
           from tmp_prefix_v2_box_map m2
           group by m2.new_box_id
           having count(*) > 1
         )
      order by m.old_box_id
      limit 20
    ) x;
  end if;

  return jsonb_build_object(
    'org_id', target_org_id,
    'total_boxes', v_total_boxes,
    'rename_candidates', v_rename_candidates,
    'alias_rows_to_create', v_rename_candidates,
    'legacy_warehouse_rows', v_legacy_warehouse_rows,
    'duplicate_target_box_ids', v_duplicate_target_box_ids,
    'existing_target_collisions', v_existing_target_collisions,
    'collision_sample', coalesce(v_collision_sample, '')
  );
end;
$$;

create or replace function import.migrate_org_warehouse_prefix_v2(
  target_org_id uuid,
  actor text default 'migration',
  alias_days integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, import, app_api
as $$
declare
  v_preflight jsonb;
  v_rename_count integer := 0;
  v_alias_upserted integer := 0;
  v_boxes_warehouse_updated integer := 0;
  v_jobs_warehouse_updated integer := 0;
  v_film_orders_warehouse_updated integer := 0;
  v_allocations_warehouse_updated integer := 0;
  v_roll_log_warehouse_updated integer := 0;
  v_allocations_box_updated integer := 0;
  v_links_box_updated integer := 0;
  v_roll_box_updated integer := 0;
  v_audit_box_updated integer := 0;
  v_film_orders_source_updated integer := 0;
  v_film_catalog_source_updated integer := 0;
  v_boxes_box_id_updated integer := 0;
  v_deleted_legacy_warehouses integer := 0;
begin
  if target_org_id is null then
    raise exception 'target_org_id is required';
  end if;

  if alias_days is null or alias_days <= 0 then
    raise exception 'alias_days must be greater than zero';
  end if;

  v_preflight := import.warehouse_prefix_v2_preflight(target_org_id);
  if coalesce((v_preflight->>'duplicate_target_box_ids')::integer, 0) > 0
     or coalesce((v_preflight->>'existing_target_collisions')::integer, 0) > 0 then
    raise exception
      'Warehouse Prefix V2 migration blocked by BoxID collisions. Sample: %',
      nullif(v_preflight->>'collision_sample', '');
  end if;

  drop table if exists pg_temp.tmp_prefix_v2_box_map;
  create temporary table tmp_prefix_v2_box_map (
    old_box_id text primary key,
    new_box_id text not null
  ) on commit drop;

  insert into tmp_prefix_v2_box_map (old_box_id, new_box_id)
  select
    b.box_id,
    case
      when b.box_id like 'IL-%' then 'IL1-' || substr(b.box_id, 4)
      when b.box_id ~ '^M[0-9A-Z]+$' then 'MS1-' || substr(b.box_id, 2)
      else b.box_id
    end as new_box_id
  from app.boxes b
  where b.org_id = target_org_id
    and (
      b.box_id like 'IL-%'
      or b.box_id ~ '^M[0-9A-Z]+$'
    );

  select count(*) into v_rename_count from tmp_prefix_v2_box_map;

  insert into app.warehouses (
    org_id,
    code,
    name,
    box_id_prefix,
    created_by,
    updated_by
  )
  values
    (target_org_id, 'IL1', 'Wauconda Illinois #1', 'IL1', app_api.trim_text(actor), app_api.trim_text(actor)),
    (target_org_id, 'MS1', 'Ridgeland Mississippi #1', 'MS1', app_api.trim_text(actor), app_api.trim_text(actor))
  on conflict (org_id, code) do update set
    name = excluded.name,
    box_id_prefix = excluded.box_id_prefix,
    updated_at = now(),
    updated_by = excluded.updated_by;

  update app.boxes b
  set warehouse = case
      when b.warehouse = 'IL' then 'IL1'
      when b.warehouse = 'MS' then 'MS1'
      else b.warehouse
    end
  where b.org_id = target_org_id
    and b.warehouse in ('IL', 'MS');
  get diagnostics v_boxes_warehouse_updated = row_count;

  update app.jobs j
  set warehouse = case
      when j.warehouse = 'IL' then 'IL1'
      when j.warehouse = 'MS' then 'MS1'
      else j.warehouse
    end
  where j.org_id = target_org_id
    and j.warehouse in ('IL', 'MS');
  get diagnostics v_jobs_warehouse_updated = row_count;

  update app.film_orders f
  set warehouse = case
      when f.warehouse = 'IL' then 'IL1'
      when f.warehouse = 'MS' then 'MS1'
      else f.warehouse
    end
  where f.org_id = target_org_id
    and f.warehouse in ('IL', 'MS');
  get diagnostics v_film_orders_warehouse_updated = row_count;

  update app.allocations a
  set warehouse = case
      when a.warehouse = 'IL' then 'IL1'
      when a.warehouse = 'MS' then 'MS1'
      else a.warehouse
    end
  where a.org_id = target_org_id
    and a.warehouse in ('IL', 'MS');
  get diagnostics v_allocations_warehouse_updated = row_count;

  update app.roll_weight_log r
  set warehouse = case
      when r.warehouse = 'IL' then 'IL1'
      when r.warehouse = 'MS' then 'MS1'
      else r.warehouse
    end
  where r.org_id = target_org_id
    and r.warehouse in ('IL', 'MS');
  get diagnostics v_roll_log_warehouse_updated = row_count;

  update app.allocations a
  set box_id = m.new_box_id
  from tmp_prefix_v2_box_map m
  where a.org_id = target_org_id
    and a.box_id = m.old_box_id;
  get diagnostics v_allocations_box_updated = row_count;

  update app.film_order_box_links l
  set box_id = m.new_box_id
  from tmp_prefix_v2_box_map m
  where l.org_id = target_org_id
    and l.box_id = m.old_box_id;
  get diagnostics v_links_box_updated = row_count;

  update app.roll_weight_log r
  set box_id = m.new_box_id
  from tmp_prefix_v2_box_map m
  where r.org_id = target_org_id
    and r.box_id = m.old_box_id;
  get diagnostics v_roll_box_updated = row_count;

  update app.audit_log a
  set box_id = m.new_box_id
  from tmp_prefix_v2_box_map m
  where a.org_id = target_org_id
    and a.box_id = m.old_box_id;
  get diagnostics v_audit_box_updated = row_count;

  update app.film_orders f
  set source_box_id = m.new_box_id
  from tmp_prefix_v2_box_map m
  where f.org_id = target_org_id
    and f.source_box_id = m.old_box_id;
  get diagnostics v_film_orders_source_updated = row_count;

  update app.film_catalog f
  set source_box_id = m.new_box_id,
      updated_at = now()
  from tmp_prefix_v2_box_map m
  where f.org_id = target_org_id
    and f.source_box_id = m.old_box_id;
  get diagnostics v_film_catalog_source_updated = row_count;

  update app.boxes b
  set box_id = m.new_box_id,
      updated_at = now()
  from tmp_prefix_v2_box_map m
  where b.org_id = target_org_id
    and b.box_id = m.old_box_id;
  get diagnostics v_boxes_box_id_updated = row_count;

  insert into app.box_id_aliases (
    org_id,
    old_box_id,
    canonical_box_id,
    expires_at,
    created_by,
    updated_by
  )
  select
    target_org_id,
    m.old_box_id,
    m.new_box_id,
    now() + make_interval(days => alias_days),
    app_api.trim_text(actor),
    app_api.trim_text(actor)
  from tmp_prefix_v2_box_map m
  on conflict (org_id, old_box_id) do update set
    canonical_box_id = excluded.canonical_box_id,
    expires_at = excluded.expires_at,
    updated_at = now(),
    updated_by = excluded.updated_by;
  get diagnostics v_alias_upserted = row_count;

  delete from app.warehouses w
  where w.org_id = target_org_id
    and w.code in ('IL', 'MS')
    and not exists (
      select 1 from app.boxes b where b.org_id = w.org_id and b.warehouse = w.code
    )
    and not exists (
      select 1 from app.jobs j where j.org_id = w.org_id and j.warehouse = w.code
    )
    and not exists (
      select 1 from app.film_orders f where f.org_id = w.org_id and f.warehouse = w.code
    )
    and not exists (
      select 1 from app.allocations a where a.org_id = w.org_id and a.warehouse = w.code
    )
    and not exists (
      select 1 from app.roll_weight_log r where r.org_id = w.org_id and r.warehouse = w.code
    );
  get diagnostics v_deleted_legacy_warehouses = row_count;

  return jsonb_build_object(
    'org_id', target_org_id,
    'alias_days', alias_days,
    'preflight', v_preflight,
    'rename_candidates', v_rename_count,
    'aliases_upserted', v_alias_upserted,
    'warehouse_updates', jsonb_build_object(
      'boxes', v_boxes_warehouse_updated,
      'jobs', v_jobs_warehouse_updated,
      'film_orders', v_film_orders_warehouse_updated,
      'allocations', v_allocations_warehouse_updated,
      'roll_weight_log', v_roll_log_warehouse_updated
    ),
    'box_id_updates', jsonb_build_object(
      'boxes', v_boxes_box_id_updated,
      'allocations', v_allocations_box_updated,
      'film_order_box_links', v_links_box_updated,
      'roll_weight_log', v_roll_box_updated,
      'audit_log', v_audit_box_updated,
      'film_orders_source_box_id', v_film_orders_source_updated,
      'film_catalog_source_box_id', v_film_catalog_source_updated
    ),
    'deleted_legacy_warehouses', v_deleted_legacy_warehouses
  );
end;
$$;

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

  -- Canonical v2 prefix format.
  if v_box_id ~ '^[A-Z]{2}[1-9][0-9]*-.+' then
    return v_box_id;
  end if;

  -- Legacy IL and legacy M forms.
  if v_box_id like 'IL-%' then
    return 'IL1-' || substr(v_box_id, 4);
  end if;

  if v_box_id ~ '^M[0-9A-Z]+$' then
    return 'MS1-' || substr(v_box_id, 2);
  end if;

  -- Preserve other already-prefixed forms.
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
    return v_prefix || '-' || v_box_id;
  end if;

  if v_warehouse = 'IL' then
    return 'IL1-' || v_box_id;
  end if;

  if v_warehouse = 'MS' then
    return 'MS1-' || v_box_id;
  end if;

  return v_box_id;
end;
$$;
