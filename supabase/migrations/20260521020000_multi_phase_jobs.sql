/**
 * PURPOSE:
 * Adds first-class job phases while preserving job-level duplicate identity.
 *
 * AFFECTS:
 * app.job_phases, job requirement phase ownership, caulk requirement phase
 * ownership, job create/update RPCs, phase labor state, and phase-aware reads.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtimeJobsMutations/runtimeJobSummaries, Supabase Edge api-handler,
 * frontend job editor/detail phase UI, and schema/latest guard.
 */

create table if not exists app.job_phases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  job_id uuid not null references app.jobs(id) on delete cascade,
  phase_number integer not null,
  sections text,
  install_date date,
  crew_leader text not null default '',
  labor_status text not null default 'ACTIVE',
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  constraint job_phases_phase_number_positive check (phase_number > 0),
  constraint job_phases_labor_status_check check (labor_status in ('ACTIVE', 'COMPLETE')),
  constraint job_phases_org_job_phase_number_unique unique (org_id, job_id, phase_number) deferrable initially immediate,
  constraint job_phases_org_id_id_unique unique (org_id, id)
);

alter table app.job_phases
  drop constraint if exists job_phases_org_job_phase_number_unique,
  add constraint job_phases_org_job_phase_number_unique
    unique (org_id, job_id, phase_number) deferrable initially immediate;

alter table app.job_phases enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'app'
      and tablename = 'job_phases'
      and policyname = 'job_phases_rw'
  ) then
    create policy job_phases_rw on app.job_phases
      for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));
  end if;
end $$;

create index if not exists idx_job_phases_org_job
  on app.job_phases (org_id, job_id, phase_number);

create unique index if not exists idx_job_phases_primary_unique
  on app.job_phases (org_id, job_id)
  where is_primary;

insert into app.job_phases (
  org_id,
  job_id,
  phase_number,
  sections,
  install_date,
  crew_leader,
  labor_status,
  is_primary,
  created_at,
  created_by,
  updated_at,
  updated_by
)
select
  j.org_id,
  j.id,
  1,
  j.sections,
  j.due_date,
  coalesce(j.crew_leader, ''),
  'ACTIVE',
  true,
  j.created_at,
  j.created_by,
  j.updated_at,
  j.updated_by
from app.jobs j
where not exists (
  select 1
  from app.job_phases p
  where p.org_id = j.org_id
    and p.job_id = j.id
);

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'app'
      and table_name = 'job_requirements'
      and column_name = 'phase_id'
  ) then
    alter table app.job_requirements
      add column phase_id uuid;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'app'
      and table_name = 'job_caulk_requirements'
      and column_name = 'phase_id'
  ) then
    alter table app.job_caulk_requirements
      add column phase_id uuid;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'app'
      and table_name = 'allocation_planner_suppressions'
      and column_name = 'phase_id'
  ) then
    alter table app.allocation_planner_suppressions
      add column phase_id uuid;
  end if;
end $$;

update app.job_requirements r
set phase_id = p.id
from app.job_phases p
where p.org_id = r.org_id
  and p.job_id = r.job_id
  and p.is_primary
  and r.phase_id is null;

update app.job_caulk_requirements r
set phase_id = p.id
from app.job_phases p
where p.org_id = r.org_id
  and p.job_id = r.job_id
  and p.is_primary
  and r.phase_id is null;

alter table app.job_requirements
  alter column phase_id set not null;

alter table app.job_caulk_requirements
  alter column phase_id set not null;

alter table app.job_requirements
  drop constraint if exists job_requirements_phase_fk,
  add constraint job_requirements_phase_fk
    foreign key (org_id, phase_id) references app.job_phases(org_id, id) on delete restrict;

alter table app.job_caulk_requirements
  drop constraint if exists job_caulk_requirements_phase_fk,
  add constraint job_caulk_requirements_phase_fk
    foreign key (org_id, phase_id) references app.job_phases(org_id, id) on delete restrict;

alter table app.allocation_planner_suppressions
  drop constraint if exists allocation_planner_suppressions_phase_fk,
  add constraint allocation_planner_suppressions_phase_fk
    foreign key (org_id, phase_id) references app.job_phases(org_id, id) on delete set null;

create index if not exists idx_job_requirements_org_phase
  on app.job_requirements (org_id, phase_id);

create index if not exists idx_job_caulk_requirements_org_phase
  on app.job_caulk_requirements (org_id, phase_id);

drop index if exists app.idx_allocation_planner_suppressions_active_unique;
create unique index if not exists idx_allocation_planner_suppressions_active_unique
  on app.allocation_planner_suppressions (
    org_id,
    job_id,
    material_type,
    coalesce(phase_id, '00000000-0000-0000-0000-000000000000'::uuid),
    requirement_signature
  )
  where cleared_at is null;

do $$
declare
  v_constraint_name text;
begin
  select c.conname
  into v_constraint_name
  from pg_constraint c
  where c.conrelid = 'app.job_caulk_requirements'::regclass
    and c.contype = 'u'
    and (
      select array_agg(a.attname::text order by cols.ordinality)
      from unnest(c.conkey) with ordinality as cols(attnum, ordinality)
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum = cols.attnum
    ) = array['org_id', 'job_id', 'product_id']::text[]
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table app.job_caulk_requirements drop constraint %I', v_constraint_name);
  end if;

  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'app.job_caulk_requirements'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by cols.ordinality)
        from unnest(c.conkey) with ordinality as cols(attnum, ordinality)
        join pg_attribute a
          on a.attrelid = c.conrelid
         and a.attnum = cols.attnum
      ) = array['org_id', 'job_id', 'phase_id', 'product_id']::text[]
  ) then
    alter table app.job_caulk_requirements
      add constraint job_caulk_requirements_org_job_phase_product_unique
      unique (org_id, job_id, phase_id, product_id);
  end if;
end $$;

create or replace function app_api.normalize_job_phase_labor_status(p_status text)
returns text
language sql
immutable
as $$
  select case when upper(btrim(coalesce(p_status, ''))) = 'COMPLETE' then 'COMPLETE' else 'ACTIVE' end;
$$;

create or replace function app_api.require_job_phase_number(p_value text, p_field text)
returns integer
language plpgsql
immutable
as $$
declare
  v_value text := btrim(coalesce(p_value, ''));
  v_number integer;
begin
  if v_value = '' or v_value !~ '^[0-9]+$' then
    perform app_api.raise_http(400, format('%s must be a positive whole number.', p_field));
  end if;
  v_number := v_value::integer;
  if v_number <= 0 then
    perform app_api.raise_http(400, format('%s must be a positive whole number.', p_field));
  end if;
  return v_number;
end;
$$;

create or replace function app_api.job_phase_rows_from_payload(p_payload jsonb)
returns table (
  phase_id uuid,
  phase_number integer,
  sections text,
  install_date date,
  crew_leader text,
  labor_status text,
  is_primary boolean,
  requirements jsonb,
  caulk_requirements jsonb,
  ordinality bigint
)
language plpgsql
stable
as $$
declare
  v_has_phases boolean := p_payload ? 'phases' and jsonb_typeof(p_payload->'phases') = 'array' and jsonb_array_length(p_payload->'phases') > 0;
begin
  if v_has_phases then
    return query
    select
      nullif(app_api.trim_text(value->>'phaseId'), '')::uuid as phase_id,
      app_api.require_job_phase_number(coalesce(value->>'phaseNumber', ordinality::text), format('Phases[%s].PhaseNumber', ordinality)) as phase_number,
      app_api.normalize_job_work_scope(coalesce(value->>'workScope', value->>'sections')) as sections,
      nullif(app_api.trim_text(coalesce(value->>'installDate', value->>'dueDate')), '')::date as install_date,
      app_api.trim_text(value->>'crewLeader') as crew_leader,
      app_api.normalize_job_phase_labor_status(coalesce(value->>'laborStatus', value->>'status')) as labor_status,
      coalesce((value->>'isPrimary')::boolean, ordinality = 1) as is_primary,
      case when jsonb_typeof(value->'requirements') = 'array' then value->'requirements' else '[]'::jsonb end as requirements,
      case when jsonb_typeof(value->'caulkRequirements') = 'array' then value->'caulkRequirements' else '[]'::jsonb end as caulk_requirements,
      ordinality
    from jsonb_array_elements(p_payload->'phases') with ordinality;
    return;
  end if;

  return query
  select
    null::uuid,
    app_api.require_job_phase_number(coalesce(p_payload->>'phaseNumber', '1'), 'PhaseNumber'),
    app_api.normalize_job_work_scope(
      case when p_payload ? 'workScope' then p_payload->>'workScope' else p_payload->>'sections' end
    ),
    nullif(app_api.trim_text(coalesce(p_payload->>'installDate', p_payload->>'dueDate')), '')::date,
    app_api.trim_text(p_payload->>'crewLeader'),
    'ACTIVE',
    true,
    case when jsonb_typeof(p_payload->'requirements') = 'array' then p_payload->'requirements' else '[]'::jsonb end,
    case when jsonb_typeof(p_payload->'caulkRequirements') = 'array' then p_payload->'caulkRequirements' else '[]'::jsonb end,
    1::bigint;
end;
$$;

create or replace function app_api.replace_job_phases(
  p_org_id uuid,
  p_job app.jobs,
  p_payload jsonb,
  p_actor text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_phase record;
  v_seen integer[] := array[]::integer[];
  v_next_id uuid;
begin
  set constraints job_phases_org_job_phase_number_unique deferred;

  update app.job_phases p
  set is_primary = false,
      updated_at = p_now,
      updated_by = app_api.trim_text(p_actor)
  where p.org_id = p_org_id
    and p.job_id = p_job.id
    and p.is_primary;

  for v_phase in
    select * from app_api.job_phase_rows_from_payload(p_payload)
  loop
    if v_phase.phase_number = any(v_seen) then
      perform app_api.raise_http(400, format('Phase %s already exists on this job.', v_phase.phase_number));
    end if;
    v_seen := array_append(v_seen, v_phase.phase_number);

    if v_phase.phase_id is not null then
      select id into v_next_id
      from app.job_phases
      where org_id = p_org_id
        and job_id = p_job.id
        and id = v_phase.phase_id
      for update;
      if not found then
        perform app_api.raise_http(400, 'Phase does not belong to this job.');
      end if;
    else
      select id into v_next_id
      from app.job_phases
      where org_id = p_org_id
        and job_id = p_job.id
        and phase_number = v_phase.phase_number
      for update;
    end if;

    insert into app.job_phases (
      id,
      org_id,
      job_id,
      phase_number,
      sections,
      install_date,
      crew_leader,
      labor_status,
      is_primary,
      created_at,
      created_by,
      updated_at,
      updated_by
    )
    values (
      coalesce(v_next_id, gen_random_uuid()),
      p_org_id,
      p_job.id,
      v_phase.phase_number,
      v_phase.sections,
      v_phase.install_date,
      v_phase.crew_leader,
      v_phase.labor_status,
      v_phase.is_primary,
      p_now,
      app_api.trim_text(p_actor),
      p_now,
      app_api.trim_text(p_actor)
    )
    on conflict (id) do update set
      phase_number = excluded.phase_number,
      sections = excluded.sections,
      install_date = excluded.install_date,
      crew_leader = excluded.crew_leader,
      labor_status = excluded.labor_status,
      is_primary = excluded.is_primary,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;
  end loop;

  update app.job_phases p
  set is_primary = false,
      updated_at = p_now,
      updated_by = app_api.trim_text(p_actor)
  where p.org_id = p_org_id
    and p.job_id = p_job.id
    and p.phase_number <> (
      select min(p2.phase_number)
      from app.job_phases p2
      where p2.org_id = p_org_id
        and p2.job_id = p_job.id
        and p2.is_primary
    )
    and p.is_primary;

  if not exists (
    select 1 from app.job_phases p
    where p.org_id = p_org_id
      and p.job_id = p_job.id
      and p.is_primary
  ) then
    update app.job_phases p
    set is_primary = true,
        updated_at = p_now,
        updated_by = app_api.trim_text(p_actor)
    where p.id = (
      select p2.id from app.job_phases p2
      where p2.org_id = p_org_id
        and p2.job_id = p_job.id
      order by p2.phase_number asc, p2.created_at asc
      limit 1
    );
  end if;
end;
$$;

create or replace function app_api.job_phase_requirements_payload(
  p_org_id uuid,
  p_job app.jobs,
  p_payload jsonb
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_response jsonb := '[]'::jsonb;
  v_phase record;
  v_saved_phase app.job_phases;
  v_requirement jsonb;
begin
  for v_phase in
    select * from app_api.job_phase_rows_from_payload(p_payload)
  loop
    select *
    into v_saved_phase
    from app.job_phases p
    where p.org_id = p_org_id
      and p.job_id = p_job.id
      and p.phase_number = v_phase.phase_number
    limit 1;

    for v_requirement in
      select value
      from jsonb_array_elements(coalesce(v_phase.requirements, '[]'::jsonb))
    loop
      v_response := v_response || jsonb_build_array(
        v_requirement ||
        jsonb_build_object(
          'phaseId', v_saved_phase.id::text,
          'phaseNumber', v_saved_phase.phase_number
        )
      );
    end loop;
  end loop;

  return v_response;
end;
$$;

create or replace function app_api.job_phase_caulk_requirements_payload(
  p_org_id uuid,
  p_job app.jobs,
  p_payload jsonb
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_response jsonb := '[]'::jsonb;
  v_phase record;
  v_saved_phase app.job_phases;
  v_requirement jsonb;
begin
  for v_phase in
    select * from app_api.job_phase_rows_from_payload(p_payload)
  loop
    select *
    into v_saved_phase
    from app.job_phases p
    where p.org_id = p_org_id
      and p.job_id = p_job.id
      and p.phase_number = v_phase.phase_number
    limit 1;

    for v_requirement in
      select value
      from jsonb_array_elements(coalesce(v_phase.caulk_requirements, '[]'::jsonb))
    loop
      v_response := v_response || jsonb_build_array(
        v_requirement ||
        jsonb_build_object(
          'phaseId', v_saved_phase.id::text,
          'phaseNumber', v_saved_phase.phase_number
        )
      );
    end loop;
  end loop;

  return v_response;
end;
$$;

drop function if exists app_api.requirement_rows_from_payload_with_ids(jsonb);

create or replace function app_api.requirement_rows_from_payload_with_ids(p_requirements jsonb)
returns table (
  requirement_id uuid,
  phase_id uuid,
  phase_number integer,
  status text,
  actual_used_feet integer,
  completed_at timestamptz,
  completed_by text,
  manufacturer text,
  film_name text,
  width_in numeric,
  required_feet integer
)
language plpgsql
stable
as $$
declare
  v_value jsonb;
  v_width_in numeric;
  v_required_feet integer;
begin
  if p_requirements is not null and jsonb_typeof(p_requirements) = 'array' then
    for v_value in select value from jsonb_array_elements(p_requirements)
    loop
      perform app_api.require_text(v_value->>'manufacturer', 'Requirements[].Manufacturer');
      perform app_api.require_text(v_value->>'filmName', 'Requirements[].FilmName');
      v_width_in := nullif(app_api.trim_text(v_value->>'widthIn'), '')::numeric;
      v_required_feet := floor(nullif(app_api.trim_text(v_value->>'requiredFeet'), '')::numeric);
      if v_width_in is null or v_width_in <= 0 then
        perform app_api.raise_http(400, 'Requirements[].WidthIn must be greater than zero.');
      end if;
      if v_required_feet is null or v_required_feet <= 0 then
        perform app_api.raise_http(400, 'Requirements[].RequiredFeet must be greater than zero.');
      end if;
    end loop;
  end if;

  return query
  with source as (
    select value, ordinality
    from jsonb_array_elements(
      case when p_requirements is null or jsonb_typeof(p_requirements) <> 'array' then '[]'::jsonb else p_requirements end
    ) with ordinality
  ),
  normalized as (
    select
      nullif(app_api.trim_text(value->>'requirementId'), '')::uuid as requirement_id,
      nullif(app_api.trim_text(value->>'phaseId'), '')::uuid as phase_id,
      nullif(app_api.trim_text(value->>'phaseNumber'), '')::integer as phase_number,
      app_api.normalize_requirement_status(value->>'status') as status,
      greatest(coalesce(floor(nullif(app_api.trim_text(value->>'actualUsedFeet'), '')::numeric)::integer, 0), 0) as actual_used_feet,
      nullif(app_api.trim_text(value->>'completedAt'), '')::timestamptz as completed_at,
      app_api.trim_text(value->>'completedBy') as completed_by,
      app_api.canonical_manufacturer_label(value->>'manufacturer') as manufacturer,
      app_api.normalize_collapsed_catalog_label(value->>'filmName') as film_name,
      (nullif(app_api.trim_text(value->>'widthIn'), '')::numeric) as width_in,
      floor(nullif(app_api.trim_text(value->>'requiredFeet'), '')::numeric)::integer as required_feet,
      ordinality
    from source
  )
  select
    (array_agg(n.requirement_id order by n.ordinality) filter (where n.requirement_id is not null))[1],
    n.phase_id,
    n.phase_number,
    (array_agg(n.status order by n.ordinality))[1],
    (array_agg(n.actual_used_feet order by n.ordinality))[1],
    (array_agg(n.completed_at order by n.ordinality) filter (where n.completed_at is not null))[1],
    (array_agg(n.completed_by order by n.ordinality))[1],
    n.manufacturer,
    n.film_name,
    n.width_in,
    sum(n.required_feet)::integer
  from normalized n
  group by n.phase_id, n.phase_number, n.manufacturer, n.film_name, n.width_in
  order by coalesce(n.phase_number, 1), lower(n.manufacturer), lower(n.film_name), n.width_in;
end;
$$;

create or replace function app_api.replace_job_requirements(
  p_org_id uuid,
  p_job app.jobs,
  p_requirements jsonb,
  p_actor text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_requirement record;
  v_existing app.job_requirements;
  v_next_id uuid;
  v_phase_id uuid;
  v_default_phase_id uuid;
  v_retained_ids uuid[] := array[]::uuid[];
begin
  select id into v_default_phase_id
  from app.job_phases
  where org_id = p_org_id
    and job_id = p_job.id
    and is_primary
  order by phase_number asc
  limit 1;

  for v_requirement in
    select * from app_api.requirement_rows_from_payload_with_ids(p_requirements)
  loop
    v_existing := null;
    v_phase_id := coalesce(v_requirement.phase_id, v_default_phase_id);
    if v_phase_id is null then
      perform app_api.raise_http(400, 'Requirement phase is required.');
    end if;

    if v_requirement.requirement_id is not null then
      select * into v_existing
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.job_id = p_job.id
        and r.id = v_requirement.requirement_id
        and not (r.id = any(v_retained_ids))
      limit 1;
    end if;

    if v_existing.id is null then
      select * into v_existing
      from app.job_requirements r
      where r.org_id = p_org_id
        and r.job_id = p_job.id
        and r.phase_id = v_phase_id
        and app_api.normalize_job_requirement_lookup_key(r.manufacturer, r.film_name, r.width_in) =
          app_api.normalize_job_requirement_lookup_key(v_requirement.manufacturer, v_requirement.film_name, v_requirement.width_in)
        and not (r.id = any(v_retained_ids))
      limit 1;
    end if;

    v_next_id := coalesce(v_existing.id, gen_random_uuid());
    v_retained_ids := array_append(v_retained_ids, v_next_id);

    insert into app.job_requirements (
      id,
      org_id,
      job_id,
      phase_id,
      manufacturer,
      film_name,
      width_in,
      required_feet,
      status,
      actual_used_feet,
      completed_at,
      completed_by,
      notes,
      created_at,
      created_by,
      updated_at,
      updated_by
    )
    values (
      v_next_id,
      p_org_id,
      p_job.id,
      v_phase_id,
      v_requirement.manufacturer,
      v_requirement.film_name,
      v_requirement.width_in,
      v_requirement.required_feet,
      coalesce(v_requirement.status, v_existing.status, 'ACTIVE'),
      coalesce(v_requirement.actual_used_feet, v_existing.actual_used_feet, 0),
      case when coalesce(v_requirement.status, v_existing.status, 'ACTIVE') = 'COMPLETE'
        then coalesce(v_requirement.completed_at, v_existing.completed_at, p_now)
        else null
      end,
      case when coalesce(v_requirement.status, v_existing.status, 'ACTIVE') = 'COMPLETE'
        then coalesce(nullif(v_requirement.completed_by, ''), v_existing.completed_by, app_api.trim_text(p_actor))
        else ''
      end,
      coalesce(v_existing.notes, ''),
      coalesce(v_existing.created_at, p_now),
      coalesce(v_existing.created_by, app_api.trim_text(p_actor)),
      p_now,
      app_api.trim_text(p_actor)
    )
    on conflict (id) do update set
      phase_id = excluded.phase_id,
      manufacturer = excluded.manufacturer,
      film_name = excluded.film_name,
      width_in = excluded.width_in,
      required_feet = excluded.required_feet,
      status = excluded.status,
      actual_used_feet = excluded.actual_used_feet,
      completed_at = excluded.completed_at,
      completed_by = excluded.completed_by,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;
  end loop;

  delete from app.job_requirements
  where org_id = p_org_id
    and job_id = p_job.id
    and not (id = any(v_retained_ids));
end;
$$;

drop function if exists app_api.caulk_requirement_rows_from_payload(jsonb);

create or replace function app_api.caulk_requirement_rows_from_payload(p_requirements jsonb)
returns table (
  requirement_id uuid,
  phase_id uuid,
  phase_number integer,
  product_id uuid,
  required_tubes integer
)
language plpgsql
stable
as $$
declare
  v_value jsonb;
  v_product_id uuid;
  v_required_tubes integer;
begin
  if p_requirements is not null and jsonb_typeof(p_requirements) = 'array' then
    for v_value in select value from jsonb_array_elements(p_requirements)
    loop
      v_product_id := nullif(app_api.trim_text(v_value->>'productId'), '')::uuid;
      v_required_tubes := floor(nullif(app_api.trim_text(v_value->>'requiredTubes'), '')::numeric);
      if v_product_id is null then
        perform app_api.raise_http(400, 'caulkRequirements[].productId is required.');
      end if;
      if v_required_tubes is null or v_required_tubes <= 0 then
        perform app_api.raise_http(400, 'caulkRequirements[].requiredTubes must be greater than zero.');
      end if;
    end loop;
  end if;

  return query
  with normalized as (
    select
      nullif(app_api.trim_text(value->>'requirementId'), '')::uuid as requirement_id,
      nullif(app_api.trim_text(value->>'phaseId'), '')::uuid as phase_id,
      nullif(app_api.trim_text(value->>'phaseNumber'), '')::integer as phase_number,
      (nullif(app_api.trim_text(value->>'productId'), '')::uuid) as product_id,
      floor(nullif(app_api.trim_text(value->>'requiredTubes'), '')::numeric)::integer as required_tubes,
      ordinality
    from jsonb_array_elements(
      case when p_requirements is null or jsonb_typeof(p_requirements) <> 'array' then '[]'::jsonb else p_requirements end
    ) with ordinality
  )
  select
    (array_agg(n.requirement_id order by n.ordinality) filter (where n.requirement_id is not null))[1],
    n.phase_id,
    n.phase_number,
    n.product_id,
    sum(n.required_tubes)::integer
  from normalized n
  group by n.phase_id, n.phase_number, n.product_id
  order by coalesce(n.phase_number, 1), n.product_id;
end;
$$;

create or replace function app_api.replace_job_caulk_requirements(
  p_org_id uuid,
  p_job app.jobs,
  p_requirements jsonb,
  p_actor text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_requirement record;
  v_existing app.job_caulk_requirements;
  v_default_phase_id uuid;
  v_phase_id uuid;
  v_next_id uuid;
  v_retained_ids uuid[] := array[]::uuid[];
begin
  select id into v_default_phase_id
  from app.job_phases
  where org_id = p_org_id
    and job_id = p_job.id
    and is_primary
  order by phase_number asc
  limit 1;

  for v_requirement in
    select * from app_api.caulk_requirement_rows_from_payload(p_requirements)
  loop
    v_existing := null;
    v_phase_id := coalesce(v_requirement.phase_id, v_default_phase_id);
    if v_phase_id is null then
      perform app_api.raise_http(400, 'Caulk requirement phase is required.');
    end if;

    if v_requirement.requirement_id is not null then
      select * into v_existing
      from app.job_caulk_requirements r
      where r.org_id = p_org_id
        and r.job_id = p_job.id
        and r.id = v_requirement.requirement_id
        and not (r.id = any(v_retained_ids))
      limit 1;
    end if;

    if v_existing.id is null then
      select * into v_existing
      from app.job_caulk_requirements r
      where r.org_id = p_org_id
        and r.job_id = p_job.id
        and r.phase_id = v_phase_id
        and r.product_id = v_requirement.product_id
        and not (r.id = any(v_retained_ids))
      limit 1;
    end if;

    v_next_id := coalesce(v_existing.id, gen_random_uuid());
    v_retained_ids := array_append(v_retained_ids, v_next_id);

    insert into app.job_caulk_requirements (
      id,
      org_id,
      job_id,
      phase_id,
      product_id,
      required_tubes,
      notes,
      created_at,
      created_by,
      updated_at,
      updated_by
    )
    values (
      v_next_id,
      p_org_id,
      p_job.id,
      v_phase_id,
      v_requirement.product_id,
      v_requirement.required_tubes,
      coalesce(v_existing.notes, ''),
      coalesce(v_existing.created_at, p_now),
      coalesce(v_existing.created_by, app_api.trim_text(p_actor)),
      p_now,
      app_api.trim_text(p_actor)
    )
    on conflict (id) do update set
      phase_id = excluded.phase_id,
      product_id = excluded.product_id,
      required_tubes = excluded.required_tubes,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;
  end loop;

  delete from app.job_caulk_requirements
  where org_id = p_org_id
    and job_id = p_job.id
    and not (id = any(v_retained_ids));
end;
$$;

create or replace function public.api_acl_list_job_phases(p_org_id uuid)
returns setof app.job_phases
language sql
security definer
set search_path = public, app, app_api
as $$
  select p.*
  from app.job_phases p
  where p.org_id = p_org_id
    and app_api.can_read_feature(p_org_id, 'jobs')
  order by p.job_id asc, p.phase_number asc, p.created_at asc;
$$;

create or replace function public.api_acl_list_job_phases_by_job(p_org_id uuid, p_job_number text)
returns setof app.job_phases
language sql
security definer
set search_path = public, app, app_api
as $$
  select p.*
  from app.job_phases p
  join app.jobs j
    on j.org_id = p.org_id
   and j.id = p.job_id
  where p.org_id = p_org_id
    and upper(trim(j.job_number)) = upper(trim(p_job_number))
    and app_api.can_read_feature(p_org_id, 'jobs')
  order by p.phase_number asc, p.created_at asc;
$$;

create or replace function public.api_acl_list_job_phases_by_job_id(p_org_id uuid, p_job_id uuid)
returns setof app.job_phases
language sql
security definer
set search_path = public, app, app_api
as $$
  select p.*
  from app.job_phases p
  where p.org_id = p_org_id
    and p.job_id = p_job_id
    and app_api.can_read_feature(p_org_id, 'jobs')
  order by p.phase_number asc, p.created_at asc;
$$;

drop function if exists public.api_acl_list_job_requirements(uuid);

create or replace function public.api_acl_list_job_requirements(p_org_id uuid)
returns table (
  id uuid,
  org_id uuid,
  job_id uuid,
  phase_id uuid,
  manufacturer text,
  film_name text,
  width_in numeric,
  required_feet integer,
  status text,
  actual_used_feet integer,
  completed_at timestamptz,
  completed_by text,
  notes text,
  created_at timestamptz,
  created_by text,
  updated_at timestamptz,
  updated_by text,
  job_number text,
  phase_number integer,
  phase_sections text,
  phase_install_date date,
  phase_crew_leader text,
  auto_planning_suppressed boolean
)
language sql
security definer
set search_path = public, app, app_api
as $$
  select
    r.id,
    r.org_id,
    r.job_id,
    r.phase_id,
    r.manufacturer,
    r.film_name,
    r.width_in,
    r.required_feet,
    r.status,
    r.actual_used_feet,
    r.completed_at,
    r.completed_by,
    r.notes,
    r.created_at,
    r.created_by,
    r.updated_at,
    r.updated_by,
    j.job_number,
    p.phase_number,
    p.sections as phase_sections,
    p.install_date as phase_install_date,
    p.crew_leader as phase_crew_leader,
    exists (
      select 1
      from app.allocation_planner_suppressions s
      where s.org_id = r.org_id
        and s.job_id = r.job_id
        and (s.phase_id is null or s.phase_id = r.phase_id)
        and s.material_type = 'FILM'
        and s.cleared_at is null
        and s.requirement_signature = app_api.film_requirement_planner_signature(
          r.manufacturer,
          r.film_name,
          r.width_in,
          r.required_feet
        )
    ) as auto_planning_suppressed
  from app.job_requirements r
  join app.jobs j on j.id = r.job_id and j.org_id = r.org_id
  join app.job_phases p on p.id = r.phase_id and p.org_id = r.org_id
  where r.org_id = p_org_id
    and app_api.can_read_feature(p_org_id, 'jobs')
  order by j.job_number asc, p.phase_number asc, r.manufacturer asc, r.film_name asc, r.width_in asc;
$$;

drop function if exists public.api_acl_list_job_requirements_by_job(uuid, text);

create or replace function public.api_acl_list_job_requirements_by_job(p_org_id uuid, p_job_number text)
returns table (
  id uuid,
  org_id uuid,
  job_id uuid,
  phase_id uuid,
  manufacturer text,
  film_name text,
  width_in numeric,
  required_feet integer,
  status text,
  actual_used_feet integer,
  completed_at timestamptz,
  completed_by text,
  notes text,
  created_at timestamptz,
  created_by text,
  updated_at timestamptz,
  updated_by text,
  job_number text,
  phase_number integer,
  phase_sections text,
  phase_install_date date,
  phase_crew_leader text,
  auto_planning_suppressed boolean
)
language sql
security definer
set search_path = public, app, app_api
as $$
  select *
  from public.api_acl_list_job_requirements(p_org_id) r
  where upper(trim(r.job_number)) = upper(trim(p_job_number));
$$;

drop function if exists public.api_acl_list_job_caulk_requirements_by_job(uuid, text);

create or replace function public.api_acl_list_job_caulk_requirements_by_job(
  p_org_id uuid,
  p_job_number text
)
returns table (
  requirement_id uuid,
  job_id uuid,
  phase_id uuid,
  phase_number integer,
  phase_sections text,
  phase_install_date date,
  phase_crew_leader text,
  job_number text,
  product_id uuid,
  manufacturer_id uuid,
  manufacturer text,
  product_name text,
  product_code text,
  tubes_per_case integer,
  required_tubes integer,
  notes text,
  updated_at timestamptz,
  auto_planning_suppressed boolean
)
language sql
security definer
set search_path = public, app, app_api
as $$
  select
    r.id as requirement_id,
    r.job_id,
    r.phase_id,
    ph.phase_number,
    ph.sections as phase_sections,
    ph.install_date as phase_install_date,
    ph.crew_leader as phase_crew_leader,
    j.job_number,
    r.product_id,
    p.manufacturer_id,
    m.name as manufacturer,
    p.name as product_name,
    p.code as product_code,
    p.tubes_per_case,
    r.required_tubes,
    r.notes,
    r.updated_at,
    exists (
      select 1
      from app.allocation_planner_suppressions s
      where s.org_id = r.org_id
        and s.job_id = r.job_id
        and (s.phase_id is null or s.phase_id = r.phase_id)
        and s.material_type = 'CAULK'
        and s.cleared_at is null
        and s.requirement_signature = app_api.caulk_requirement_planner_signature(
          r.product_id,
          j.warehouse,
          r.required_tubes
        )
    ) as auto_planning_suppressed
  from app.job_caulk_requirements r
  join app.jobs j
    on j.id = r.job_id
   and j.org_id = r.org_id
  join app.job_phases ph
    on ph.id = r.phase_id
   and ph.org_id = r.org_id
  join app.caulk_products p
    on p.id = r.product_id
   and p.org_id = r.org_id
  join app.caulk_manufacturers m
    on m.id = p.manufacturer_id
   and m.org_id = p.org_id
  where r.org_id = p_org_id
    and upper(j.job_number) = upper(trim(p_job_number))
    and app_api.can_read_feature(p_org_id, 'jobs')
  order by ph.phase_number asc, lower(m.name), lower(p.name), lower(p.code);
$$;

create or replace function public.api_jobs_create(
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
  v_job app.jobs;
  v_existing_job app.jobs;
  v_primary_phase record;
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_sections text;
  v_work_scope_key text;
  v_constraint_name text := '';
  v_now timestamptz := now();
  v_phase_requirements jsonb;
  v_phase_caulk_requirements jsonb;
  v_has_film_requirements boolean;
  v_has_caulk_requirements boolean;
  v_has_labor_only_input boolean := coalesce(p_payload ? 'isLaborOnly', false) or coalesce(p_payload ? 'is_labor_only', false);
  v_labor_only_text text := lower(app_api.trim_text(coalesce(p_payload->>'isLaborOnly', p_payload->>'is_labor_only')));
  v_is_labor_only boolean := false;
begin
  perform app_api.require_org_member(p_org_id);

  select * into v_primary_phase
  from app_api.job_phase_rows_from_payload(p_payload)
  where is_primary
  order by ordinality
  limit 1;

  if not found then
    select * into v_primary_phase
    from app_api.job_phase_rows_from_payload(p_payload)
    order by ordinality
    limit 1;
  end if;

  v_sections := v_primary_phase.sections;
  v_work_scope_key := app_api.normalize_job_work_scope_key(v_sections);

  select *
  into v_existing_job
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = v_job_number
    and j.work_scope_key = v_work_scope_key
  for update;

  if found then
    perform app_api.raise_http(409, format('Job %s already exists.', v_job_number));
  end if;

  v_job.id := gen_random_uuid();
  v_job.created_at := v_now;
  v_job.created_by := app_api.trim_text(p_actor);
  v_job.is_staged_for_pickup := false;
  v_job.is_labor_only := false;
  v_job.org_id := p_org_id;
  v_job.job_number := v_job_number;
  v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  v_job.sections := v_sections;
  v_job.due_date := v_primary_phase.install_date;
  v_job.crew_leader := v_primary_phase.crew_leader;
  v_job.lifecycle_status := app_api.normalize_job_lifecycle_status(p_payload->>'lifecycleStatus');
  v_job.notes := app_api.trim_text(p_payload->>'notes');

  if v_has_labor_only_input then
    if v_labor_only_text in ('true', 't', '1', 'yes', 'on') then
      v_is_labor_only := true;
    elsif v_labor_only_text in ('false', 'f', '0', 'no', 'off') then
      v_is_labor_only := false;
    else
      perform app_api.raise_http(400, 'isLaborOnly must be true or false.');
    end if;
  end if;

  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);

  begin
    v_job := app_api.save_job(v_job);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint_name = CONSTRAINT_NAME;
      if v_constraint_name = 'jobs_org_job_number_work_scope_key_unique' then
        perform app_api.raise_http(409, format('Job %s already exists.', v_job_number));
      end if;
      raise;
  end;

  perform app_api.replace_job_phases(p_org_id, v_job, p_payload, p_actor, v_now);
  v_phase_requirements := app_api.job_phase_requirements_payload(p_org_id, v_job, p_payload);
  v_phase_caulk_requirements := app_api.job_phase_caulk_requirements_payload(p_org_id, v_job, p_payload);
  v_has_film_requirements := exists (select 1 from app_api.requirement_rows_from_payload(v_phase_requirements));
  v_has_caulk_requirements := exists (select 1 from app_api.caulk_requirement_rows_from_payload(v_phase_caulk_requirements));

  if v_has_film_requirements or v_has_caulk_requirements then
    v_is_labor_only := false;
  elsif v_is_labor_only then
    v_job.is_staged_for_pickup := true;
  else
    v_is_labor_only := true;
  end if;
  v_job.is_labor_only := v_is_labor_only;
  v_job := app_api.save_job(v_job);

  perform app_api.replace_job_requirements(p_org_id, v_job, v_phase_requirements, p_actor, v_now);
  perform app_api.replace_job_caulk_requirements(p_org_id, v_job, v_phase_caulk_requirements, p_actor, v_now);

  return jsonb_build_object('jobId', v_job.id::text, 'jobNumber', v_job.job_number, 'warnings', '[]'::jsonb);
end;
$$;

create or replace function public.api_jobs_update(
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
  v_job app.jobs;
  v_now timestamptz := now();
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid;
  v_primary_phase record;
  v_primary_phase_id uuid;
  v_phase_requirements jsonb;
  v_phase_caulk_requirements jsonb;
  v_retained_phase_requirements jsonb := '[]'::jsonb;
  v_retained_phase_caulk_requirements jsonb := '[]'::jsonb;
  v_has_film_requirements boolean;
  v_has_caulk_requirements boolean;
  v_has_labor_only_input boolean := coalesce(p_payload ? 'isLaborOnly', false) or coalesce(p_payload ? 'is_labor_only', false);
  v_labor_only_text text := lower(app_api.trim_text(coalesce(p_payload->>'isLaborOnly', p_payload->>'is_labor_only')));
  v_is_labor_only boolean := false;
  v_had_labor_only boolean := false;
begin
  perform app_api.require_org_member(p_org_id);

  if v_has_job_id then
    if not coalesce(v_job_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end if;
    v_job_id := v_job_id_text::uuid;
    select * into v_job from app.jobs j where j.org_id = p_org_id and j.id = v_job_id for update;
    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;
    if upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(409, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;
  else
    select * into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.job_number = v_job_number
    for update;
    if not found then
      perform app_api.raise_http(404, format('Job %s was not found.', v_job_number));
    end if;
  end if;

  v_had_labor_only := coalesce(v_job.is_labor_only, false);

  select * into v_primary_phase
  from app_api.job_phase_rows_from_payload(p_payload)
  where is_primary
  order by ordinality
  limit 1;
  if not found then
    select * into v_primary_phase from app_api.job_phase_rows_from_payload(p_payload) order by ordinality limit 1;
  end if;

  if p_payload ? 'warehouse' then
    v_job.warehouse := app_api.require_org_warehouse(p_org_id, p_payload->>'warehouse', 'Warehouse');
  end if;
  v_job.sections := v_primary_phase.sections;
  v_job.due_date := v_primary_phase.install_date;
  v_job.crew_leader := v_primary_phase.crew_leader;
  if p_payload ? 'lifecycleStatus' then
    v_job.lifecycle_status := app_api.normalize_job_lifecycle_status(p_payload->>'lifecycleStatus');
  end if;
  if p_payload ? 'notes' then
    v_job.notes := app_api.trim_text(p_payload->>'notes');
  end if;

  perform app_api.replace_job_phases(p_org_id, v_job, p_payload, p_actor, v_now);
  v_phase_requirements := app_api.job_phase_requirements_payload(p_org_id, v_job, p_payload);
  v_phase_caulk_requirements := app_api.job_phase_caulk_requirements_payload(p_org_id, v_job, p_payload);

  if not (p_payload ? 'phases' and jsonb_typeof(p_payload->'phases') = 'array') then
    select p.id
    into v_primary_phase_id
    from app.job_phases p
    where p.org_id = p_org_id
      and p.job_id = v_job.id
      and p.is_primary
    order by p.phase_number, p.created_at
    limit 1;

    select coalesce(jsonb_agg(jsonb_build_object(
      'requirementId', r.id::text,
      'phaseId', r.phase_id::text,
      'phaseNumber', p.phase_number,
      'manufacturer', r.manufacturer,
      'filmName', r.film_name,
      'widthIn', r.width_in,
      'requiredFeet', r.required_feet,
      'status', r.status,
      'actualUsedFeet', r.actual_used_feet,
      'completedAt', r.completed_at,
      'completedBy', r.completed_by
    )), '[]'::jsonb)
    into v_retained_phase_requirements
    from app.job_requirements r
    join app.job_phases p
      on p.org_id = r.org_id
     and p.id = r.phase_id
    where r.org_id = p_org_id
      and r.job_id = v_job.id
      and r.phase_id is distinct from v_primary_phase_id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'requirementId', r.id::text,
      'phaseId', r.phase_id::text,
      'phaseNumber', p.phase_number,
      'productId', r.product_id::text,
      'requiredTubes', r.required_tubes,
      'notes', r.notes
    )), '[]'::jsonb)
    into v_retained_phase_caulk_requirements
    from app.job_caulk_requirements r
    join app.job_phases p
      on p.org_id = r.org_id
     and p.id = r.phase_id
    where r.org_id = p_org_id
      and r.job_id = v_job.id
      and r.phase_id is distinct from v_primary_phase_id;

    v_phase_requirements := coalesce(v_phase_requirements, '[]'::jsonb) || v_retained_phase_requirements;
    v_phase_caulk_requirements := coalesce(v_phase_caulk_requirements, '[]'::jsonb) || v_retained_phase_caulk_requirements;
  end if;

  v_has_film_requirements := exists (select 1 from app_api.requirement_rows_from_payload(v_phase_requirements));
  v_has_caulk_requirements := exists (select 1 from app_api.caulk_requirement_rows_from_payload(v_phase_caulk_requirements));

  if v_has_labor_only_input then
    if v_labor_only_text in ('true', 't', '1', 'yes', 'on') then
      v_is_labor_only := true;
    elsif v_labor_only_text in ('false', 'f', '0', 'no', 'off') then
      v_is_labor_only := false;
    else
      perform app_api.raise_http(400, 'isLaborOnly must be true or false.');
    end if;
  else
    v_is_labor_only := v_had_labor_only;
  end if;

  if v_has_film_requirements or v_has_caulk_requirements then
    v_is_labor_only := false;
    if v_had_labor_only then
      v_job.is_staged_for_pickup := false;
    end if;
  elsif v_is_labor_only then
    v_job.is_staged_for_pickup := true;
  elsif v_has_labor_only_input and not v_is_labor_only and v_had_labor_only then
    v_job.is_staged_for_pickup := false;
  end if;

  v_job.is_labor_only := v_is_labor_only;
  v_job.updated_at := v_now;
  v_job.updated_by := app_api.trim_text(p_actor);
  v_job := app_api.save_job(v_job);
  perform app_api.replace_job_requirements(p_org_id, v_job, v_phase_requirements, p_actor, v_now);
  perform app_api.replace_job_caulk_requirements(p_org_id, v_job, v_phase_caulk_requirements, p_actor, v_now);

  return jsonb_build_object('jobId', v_job.id::text, 'jobNumber', v_job.job_number, 'warnings', '[]'::jsonb);
end;
$$;

create or replace function app_api.sync_active_job_phase_schedules(
  p_org_id uuid,
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_box app.boxes;
  v_box_id text;
  v_physical_feet_by_box jsonb := '{}'::jsonb;
  v_updated_allocation_count integer := 0;
  v_updated_film_order_count integer := 0;
begin
  for v_box_id in
    select distinct a.box_id
    from app.allocations a
    where a.org_id = p_org_id
      and a.job_id = p_job_id
      and a.status = 'ACTIVE'
      and coalesce(trim(a.box_id), '') <> ''
  loop
    select *
    into v_box
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = v_box_id
    for update;

    if found and upper(coalesce(v_box.status::text, '')) in ('IN_STOCK', 'TRANSFER') then
      v_physical_feet_by_box := jsonb_set(
        v_physical_feet_by_box,
        array[v_box_id],
        to_jsonb(coalesce(app_api.box_physical_feet_available(v_box), 0)),
        true
      );
    end if;
  end loop;

  with primary_phase as (
    select p.*
    from app.job_phases p
    where p.org_id = p_org_id
      and p.job_id = p_job_id
    order by case when p.is_primary then 0 else 1 end, p.phase_number, p.created_at
    limit 1
  ),
  allocation_schedule as (
    select
      a.id as allocation_row_id,
      coalesce(rp.install_date, pp.install_date) as install_date,
      coalesce(rp.crew_leader, pp.crew_leader, '') as crew_leader
    from app.allocations a
    left join app.job_requirements r
      on r.org_id = a.org_id
     and r.id = a.requirement_id
    left join app.job_phases rp
      on rp.org_id = r.org_id
     and rp.id = r.phase_id
    cross join primary_phase pp
    where a.org_id = p_org_id
      and a.job_id = p_job_id
      and a.status = 'ACTIVE'
  ),
  updated_allocations as (
    update app.allocations a
    set
      job_date = s.install_date,
      crew_leader = coalesce(s.crew_leader, '')
    from allocation_schedule s
    where a.id = s.allocation_row_id
      and (
        a.job_date is distinct from s.install_date
        or coalesce(a.crew_leader, '') is distinct from coalesce(s.crew_leader, '')
      )
    returning a.id
  )
  select count(*) into v_updated_allocation_count from updated_allocations;

  with primary_phase as (
    select p.*
    from app.job_phases p
    where p.org_id = p_org_id
      and p.job_id = p_job_id
    order by case when p.is_primary then 0 else 1 end, p.phase_number, p.created_at
    limit 1
  ),
  order_schedule as (
    select
      f.id as film_order_row_id,
      coalesce(rp.install_date, pp.install_date) as install_date,
      coalesce(rp.crew_leader, pp.crew_leader, '') as crew_leader
    from app.film_orders f
    left join app.job_requirements r
      on r.org_id = f.org_id
     and r.id = f.requirement_id
    left join app.job_phases rp
      on rp.org_id = r.org_id
     and rp.id = r.phase_id
    cross join primary_phase pp
    where f.org_id = p_org_id
      and f.job_id = p_job_id
      and f.status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
  ),
  updated_orders as (
    update app.film_orders f
    set
      job_date = s.install_date,
      crew_leader = coalesce(s.crew_leader, '')
    from order_schedule s
    where f.id = s.film_order_row_id
      and (
        f.job_date is distinct from s.install_date
        or coalesce(f.crew_leader, '') is distinct from coalesce(s.crew_leader, '')
      )
    returning f.id
  )
  select count(*) into v_updated_film_order_count from updated_orders;

  for v_box_id in
    select jsonb_object_keys(v_physical_feet_by_box)
  loop
    perform app_api.recalculate_physical_box_allocatable_now(
      p_org_id,
      v_box_id,
      coalesce((v_physical_feet_by_box->>v_box_id)::integer, 0)
    );
  end loop;

  return jsonb_build_object(
    'updatedAllocationCount', v_updated_allocation_count,
    'updatedFilmOrderCount', v_updated_film_order_count
  );
end;
$$;

create or replace function public.api_acl_jobs_update(p_org_id uuid, p_actor text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_updated_job app.jobs;
  v_result jsonb;
  v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_has_job_id boolean := v_job_id_text <> '';
  v_job_id uuid;
  v_scope jsonb;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');

  if v_has_job_id then
    if not coalesce(v_job_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end if;

    v_job_id := v_job_id_text::uuid;
    v_result := public.api_jobs_update(p_org_id, p_actor, p_payload);

    select *
    into v_updated_job
    from app.jobs j
    where j.org_id = p_org_id
      and j.id = v_job_id
    limit 1;

    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;

    perform app_api.sync_active_job_phase_schedules(p_org_id, v_updated_job.id);

    v_scope := jsonb_build_object(
      'jobIds', jsonb_build_array(v_updated_job.id),
      'jobNumbers', jsonb_build_array(v_updated_job.job_number)
    );
  else
    v_result := public.api_jobs_update(p_org_id, p_actor, p_payload);

    select *
    into v_updated_job
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number))
    limit 1;

    if found then
      perform app_api.sync_active_job_phase_schedules(p_org_id, v_updated_job.id);
    end if;

    v_scope := jsonb_build_object('jobNumbers', jsonb_build_array(v_job_number));
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    v_scope
  );

  return v_result;
end;
$$;

create or replace function public.api_acl_job_phase_set_state(
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
  v_job_id_text text := app_api.trim_text(p_payload->>'jobId');
  v_job_number text := app_api.trim_text(p_payload->>'jobNumber');
  v_phase_id_text text := app_api.require_text(p_payload->>'phaseId', 'PhaseId');
  v_status text := app_api.normalize_job_phase_labor_status(p_payload->>'status');
  v_job_id uuid := null;
  v_phase_id uuid;
  v_job app.jobs;
  v_match_count integer := 0;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'write');
  begin
    v_phase_id := v_phase_id_text::uuid;
  exception when others then
    perform app_api.raise_http(400, 'PhaseId must be a valid UUID.');
  end;

  if v_job_id_text <> '' then
    begin
      v_job_id := v_job_id_text::uuid;
    exception when others then
      perform app_api.raise_http(400, 'jobId must be a valid UUID.');
    end;
    select * into v_job from app.jobs j where j.org_id = p_org_id and j.id = v_job_id for update;
    if not found then
      perform app_api.raise_http(404, 'Job was not found.');
    end if;
    if v_job_number <> '' and upper(trim(v_job.job_number)) <> upper(trim(v_job_number)) then
      perform app_api.raise_http(400, 'Job identity mismatch: selected job does not match jobNumber.');
    end if;
  else
    v_job_number := app_api.require_text(v_job_number, 'JobNumber');
    select count(*)::integer into v_match_count
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number));
    if v_match_count = 0 then
      perform app_api.raise_http(404, format('Job %s was not found.', v_job_number));
    end if;
    if v_match_count > 1 then
      perform app_api.raise_http(409, format('Job %s has multiple work scopes. Open the exact job before changing phase state.', v_job_number));
    end if;
    select * into v_job
    from app.jobs j
    where j.org_id = p_org_id
      and upper(trim(j.job_number)) = upper(trim(v_job_number))
    for update;
    v_job_id := v_job.id;
  end if;

  if coalesce(v_job.lifecycle_status::text, 'ACTIVE') <> 'ACTIVE' then
    perform app_api.raise_http(400, format('Job %s is closed. Reopen it before changing phase state.', v_job.job_number));
  end if;

  update app.job_phases
  set labor_status = v_status,
      updated_at = timezone('utc', now()),
      updated_by = app_api.trim_text(p_actor)
  where org_id = p_org_id
    and job_id = v_job_id
    and id = v_phase_id;

  if not found then
    perform app_api.raise_http(404, 'Job phase was not found.');
  end if;

  perform app_api.reconcile_auto_planned_allocations(
    p_org_id,
    p_actor,
    jsonb_build_object('jobIds', jsonb_build_array(v_job_id::text), 'jobNumbers', jsonb_build_array(v_job.job_number))
  );

  return jsonb_build_object('jobId', v_job.id, 'jobNumber', v_job.job_number, 'phaseId', v_phase_id, 'status', v_status, 'warnings', '[]'::jsonb);
end;
$$;

select app_api.grant_execute_if_exists('app_api.normalize_job_phase_labor_status(text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.normalize_job_phase_labor_status(text)', 'service_role');
select app_api.grant_execute_if_exists('app_api.require_job_phase_number(text, text)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.require_job_phase_number(text, text)', 'service_role');
select app_api.grant_execute_if_exists('app_api.job_phase_rows_from_payload(jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.job_phase_rows_from_payload(jsonb)', 'service_role');
select app_api.grant_execute_if_exists('app_api.replace_job_phases(uuid, app.jobs, jsonb, text, timestamptz)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.replace_job_phases(uuid, app.jobs, jsonb, text, timestamptz)', 'service_role');
select app_api.grant_execute_if_exists('app_api.job_phase_requirements_payload(uuid, app.jobs, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.job_phase_requirements_payload(uuid, app.jobs, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('app_api.job_phase_caulk_requirements_payload(uuid, app.jobs, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.job_phase_caulk_requirements_payload(uuid, app.jobs, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_job_phases(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_job_phases(uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_job_phases_by_job(uuid, text)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_job_phases_by_job(uuid, text)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_list_job_phases_by_job_id(uuid, uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_list_job_phases_by_job_id(uuid, uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_job_phase_set_state(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_job_phase_set_state(uuid, text, jsonb)', 'service_role');
