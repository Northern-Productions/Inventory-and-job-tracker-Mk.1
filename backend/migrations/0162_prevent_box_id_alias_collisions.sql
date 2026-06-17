/*
 * PURPOSE:
 * Prevent direct BoxID rows and transfer alias rows from becoming ambiguous.
 *
 * AFFECTS:
 * Box lookup, Add Box/Fulfill Order BoxID suggestion, future box creation,
 * and future transfer alias creation.
 *
 * SAFETY:
 * Existing bad direct/alias collisions are reported by diagnostics but are not
 * validated or repaired by this migration.
 */

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
  v_input text := app_api.normalize_box_id_trailing_letters(p_box_id, 'BoxID');
  v_resolved text;
begin
  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  if exists (
    select 1
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = v_input
  ) then
    return v_input;
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

create or replace function app_api.box_id_identity_collision_diagnostics(
  p_org_id uuid default null
)
returns table (
  org_id uuid,
  collision_type text,
  box_id text,
  direct_box_record_id uuid,
  canonical_box_id text,
  canonical_box_record_id uuid,
  alias_expires_at timestamptz
)
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select
    b.org_id,
    'DIRECT_BOX_MATCHES_ALIAS_OLD_BOX_ID'::text as collision_type,
    b.box_id,
    b.id as direct_box_record_id,
    a.canonical_box_id,
    canonical.id as canonical_box_record_id,
    a.expires_at as alias_expires_at
  from app.boxes b
  join app.box_id_aliases a
    on a.org_id = b.org_id
   and a.old_box_id = b.box_id
  left join app.boxes canonical
    on canonical.org_id = a.org_id
   and canonical.box_id = a.canonical_box_id
  where (p_org_id is null or b.org_id = p_org_id)
    and coalesce(a.canonical_box_id, '') <> b.box_id
  order by b.org_id, b.box_id, a.expires_at desc;
$$;

create or replace function app_api.suggest_next_box_id(
  p_org_id uuid,
  p_warehouse text
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text := app_api.require_org_warehouse(p_org_id, p_warehouse, 'Warehouse');
  v_prefix text;
  v_prefix_token text;
  v_best_value integer := 0;
  v_best_width integer := 0;
  v_next_value integer;
  v_next_digits text;
begin
  select coalesce(nullif(upper(btrim(w.box_id_prefix)), ''), upper(btrim(w.code)))
  into v_prefix
  from app.warehouses w
  where w.org_id = p_org_id
    and w.code = v_warehouse;

  v_prefix := upper(btrim(coalesce(v_prefix, v_warehouse)));
  v_prefix_token := regexp_replace(v_prefix, '-+$', '') || '-';

  with identity_box_ids as (
    select b.box_id
    from app.boxes b
    where b.org_id = p_org_id
    union
    select a.old_box_id
    from app.box_id_aliases a
    where a.org_id = p_org_id
    union
    select a.canonical_box_id
    from app.box_id_aliases a
    where a.org_id = p_org_id
    union
    select t.destination_box_id
    from app.box_transfers t
    where t.org_id = p_org_id
      and t.status = 'PENDING'
      and coalesce(t.destination_box_id, '') <> ''
  ),
  matched as (
    select regexp_match(
      upper(btrim(coalesce(box_id, ''))),
      '^' || v_prefix_token || '([0-9]+)[A-Z]?(-|$)'
    ) as parts
    from identity_box_ids
    where upper(btrim(coalesce(box_id, ''))) like v_prefix_token || '%'
  )
  select
    coalesce(max((parts[1])::integer), 0),
    coalesce(max(length(parts[1])), 0)
  into v_best_value, v_best_width
  from matched
  where parts is not null;

  v_next_value := v_best_value + 1;
  v_next_digits := lpad(v_next_value::text, greatest(v_best_width, length(v_next_value::text)), '0');

  return v_prefix_token || v_next_digits;
end;
$$;

create or replace function public.api_acl_suggest_next_box_id(
  p_org_id uuid,
  p_warehouse text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_warehouse text;
  v_box_id text;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');
  v_warehouse := app_api.require_org_warehouse(p_org_id, p_warehouse, 'Warehouse');
  v_box_id := app_api.suggest_next_box_id(p_org_id, v_warehouse);

  return jsonb_build_object(
    'warehouse', v_warehouse,
    'boxId', v_box_id
  );
end;
$$;

create or replace function app_api.prevent_box_id_alias_collision_for_boxes()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box_id text := app_api.normalize_box_id_trailing_letters(new.box_id, 'BoxID');
  v_existing_direct_id uuid;
  v_alias app.box_id_aliases;
begin
  if tg_op = 'UPDATE'
     and app_api.normalize_box_id_trailing_letters(old.box_id, 'BoxID') = v_box_id then
    return new;
  end if;

  select b.id
  into v_existing_direct_id
  from app.boxes b
  where b.org_id = new.org_id
    and b.box_id = v_box_id
  limit 1;

  -- Existing direct rows may already collide with legacy aliases. Do not make
  -- this migration fail future same-row upserts/updates merely because that
  -- historical data exists.
  if v_existing_direct_id is not null then
    return new;
  end if;

  select *
  into v_alias
  from app.box_id_aliases a
  where a.org_id = new.org_id
    and a.old_box_id = v_box_id
  order by a.expires_at desc
  limit 1;

  if found then
    perform app_api.raise_http(
      409,
      format(
        'BoxID %s is reserved as a historical transfer alias for %s and cannot be reused.',
        v_box_id,
        coalesce(v_alias.canonical_box_id, 'another box')
      )
    );
  end if;

  return new;
end;
$$;

create or replace function app_api.prevent_box_id_alias_collision_for_aliases()
returns trigger
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_old_box_id text := app_api.normalize_box_id_trailing_letters(new.old_box_id, 'OldBoxID');
  v_canonical_box_id text := app_api.normalize_box_id_trailing_letters(new.canonical_box_id, 'CanonicalBoxID');
  v_direct_old_box app.boxes;
  v_canonical_box app.boxes;
begin
  if tg_op = 'UPDATE'
     and app_api.normalize_box_id_trailing_letters(old.old_box_id, 'OldBoxID') = v_old_box_id
     and app_api.normalize_box_id_trailing_letters(old.canonical_box_id, 'CanonicalBoxID') = v_canonical_box_id then
    return new;
  end if;

  if v_old_box_id = v_canonical_box_id then
    perform app_api.raise_http(409, format('BoxID alias %s cannot point to itself.', v_old_box_id));
  end if;

  select *
  into v_canonical_box
  from app.boxes b
  where b.org_id = new.org_id
    and b.box_id = v_canonical_box_id
  limit 1;

  if not found then
    perform app_api.raise_http(
      409,
      format('BoxID alias target %s must be an existing canonical box.', v_canonical_box_id)
    );
  end if;

  select *
  into v_direct_old_box
  from app.boxes b
  where b.org_id = new.org_id
    and b.box_id = v_old_box_id
  limit 1;

  if found and v_direct_old_box.id <> v_canonical_box.id then
    perform app_api.raise_http(
      409,
      format(
        'BoxID alias %s cannot be created because a direct box with that ID already exists.',
        v_old_box_id
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_boxes_prevent_alias_old_collision on app.boxes;
create trigger trg_boxes_prevent_alias_old_collision
before insert or update of box_id on app.boxes
for each row
execute function app_api.prevent_box_id_alias_collision_for_boxes();

drop trigger if exists trg_box_id_aliases_prevent_direct_collision on app.box_id_aliases;
create trigger trg_box_id_aliases_prevent_direct_collision
before insert or update of old_box_id, canonical_box_id on app.box_id_aliases
for each row
execute function app_api.prevent_box_id_alias_collision_for_aliases();

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.resolve_box_id_alias(uuid, text, timestamptz)'::regprocedure)
  into v_def;

  if position('from app.boxes b' in v_def) = 0
     or position('return v_input' in v_def) = 0
     or position('from app.box_id_aliases a' in v_def) = 0 then
    raise exception 'direct-first box alias resolver patch is incomplete';
  end if;
end;
$$;

select app_api.grant_execute_if_exists('app_api.resolve_box_id_alias(uuid, text, timestamptz)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.resolve_box_id_alias(uuid, text, timestamptz)', 'service_role');
select app_api.grant_execute_if_exists('app_api.box_id_identity_collision_diagnostics(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.box_id_identity_collision_diagnostics(uuid)', 'service_role');
select app_api.grant_execute_if_exists('app_api.suggest_next_box_id(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.suggest_next_box_id(uuid, text)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_suggest_next_box_id(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_suggest_next_box_id(uuid, text)', 'service_role');
