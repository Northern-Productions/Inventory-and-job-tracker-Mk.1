/**
 * PURPOSE:
 * Reconcile checked-in legacy film allocations with requirement actual usage.
 *
 * AFFECTS:
 * app_api.record_requirement_actual_usage_for_checkin,
 * public.api_boxes_set_status, app_api.replace_job_requirements, allocation
 * release after check-in, and a deterministic repair for already-checked-in
 * rows that have one roll log, one active allocation, and one requirement.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend statusTransitions/jobsRepository, Supabase Edge roll-history reads,
 * job detail material history, and schema/latest checks.
 *
 * COMMON FAILURE MODES:
 * Double-counting actual usage, guessing a requirement for ambiguous legacy
 * rows, erasing actual usage during job edits, or leaving returned checkout
 * allocations active after actual LF is recorded.
 */

create or replace function app_api.record_requirement_actual_usage_for_checkin(
  p_org_id uuid,
  p_actor text,
  p_box_id text,
  p_job_id uuid,
  p_job_number text,
  p_used_feet integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_used_feet integer := greatest(coalesce(p_used_feet, 0), 0);
  v_box_id text := upper(app_api.trim_text(p_box_id));
  v_job_number text := app_api.trim_text(p_job_number);
  v_candidate_count integer := 0;
  v_distinct_job_count integer := 0;
  v_index integer := 0;
  v_remaining_feet integer := 0;
  v_applied_feet integer := 0;
  v_recorded_feet integer := 0;
  v_requirement_ids uuid[] := array[]::uuid[];
  v_row record;
  v_warnings text[] := array[]::text[];
begin
  if v_box_id = '' or v_used_feet <= 0 then
    return jsonb_build_object(
      'recordedFeet', 0,
      'requirementIds', '[]'::jsonb,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  with active_allocations as (
    select a.*
    from app.allocations a
    where a.org_id = p_org_id
      and upper(trim(a.box_id)) = v_box_id
      and a.status = 'ACTIVE'
      and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
      and (
        (
          p_job_id is not null
          and (
            a.job_id = p_job_id
            or (
              a.job_id is null
              and upper(trim(a.job_number)) = upper(v_job_number)
            )
          )
        )
        or (
          p_job_id is null
          and upper(trim(a.job_number)) = upper(v_job_number)
        )
      )
  ),
  candidate_requirements as (
    select
      a.allocation_id,
      a.requirement_id
    from active_allocations a
    join app.job_requirements r
      on r.org_id = a.org_id
     and r.id = a.requirement_id
    where a.requirement_id is not null
      and (
        p_job_id is null
        or r.job_id = p_job_id
      )
    union all
    select
      a.allocation_id,
      legacy_match.requirement_id
    from active_allocations a
    left join lateral (
      select
        count(*)::integer as box_match_count,
        (array_agg(b.manufacturer order by b.updated_at desc, b.id))[1] as manufacturer,
        (array_agg(b.film_name order by b.updated_at desc, b.id))[1] as film_name,
        (array_agg(b.width_in order by b.updated_at desc, b.id))[1] as width_in
      from app.boxes b
      where b.org_id = a.org_id
        and upper(trim(b.box_id)) = upper(trim(a.box_id))
        and (
          upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'
          or (
            p_job_id is not null
            and b.last_checkout_job_id = p_job_id
          )
          or (
            p_job_id is null
            and upper(trim(coalesce(b.last_checkout_job, ''))) = upper(v_job_number)
          )
        )
    ) box_match on true
    left join lateral (
      select
        count(*)::integer as requirement_match_count,
        (array_agg(r.id order by r.created_at, r.id))[1] as requirement_id
      from app.job_requirements r
      where r.org_id = a.org_id
        and r.job_id = coalesce(a.job_id, p_job_id)
        and box_match.box_match_count = 1
        and r.width_in = box_match.width_in
        and app_api.normalize_requirement_film_key(r.org_id, r.manufacturer, r.film_name) =
          app_api.normalize_requirement_film_key(a.org_id, box_match.manufacturer, box_match.film_name)
    ) legacy_match on true
    where a.requirement_id is null
      and box_match.box_match_count = 1
      and legacy_match.requirement_match_count = 1
  ),
  candidates as (
    select
      cr.allocation_id,
      cr.requirement_id,
      r.job_id
    from candidate_requirements cr
    join app.allocations a
      on a.org_id = p_org_id
     and a.allocation_id = cr.allocation_id
    join app.job_requirements r
      on r.org_id = a.org_id
     and r.id = cr.requirement_id
  )
  select count(*)::integer, count(distinct job_id)::integer
  into v_candidate_count, v_distinct_job_count
  from candidates;

  if v_candidate_count <= 0 then
    v_warnings := app_api.push_warning(
      v_warnings,
      format(
        'Actual used LF from box %s was preserved in roll history but was not assigned to a requirement because no active requirement allocation matched the check-out job.',
        v_box_id
      )
    );
    return jsonb_build_object(
      'recordedFeet', 0,
      'requirementIds', '[]'::jsonb,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  if p_job_id is null and v_distinct_job_count > 1 then
    v_warnings := app_api.push_warning(
      v_warnings,
      format(
        'Actual used LF from box %s was preserved in roll history but was not assigned to a requirement because job number %s maps to multiple jobs.',
        v_box_id,
        coalesce(nullif(v_job_number, ''), 'UNKNOWN')
      )
    );
    return jsonb_build_object(
      'recordedFeet', 0,
      'requirementIds', '[]'::jsonb,
      'warnings', to_jsonb(v_warnings)
    );
  end if;

  v_remaining_feet := v_used_feet;
  for v_row in
    with active_allocations as (
      select a.*
      from app.allocations a
      where a.org_id = p_org_id
        and upper(trim(a.box_id)) = v_box_id
        and a.status = 'ACTIVE'
        and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
        and (
          (
            p_job_id is not null
            and (
              a.job_id = p_job_id
              or (
                a.job_id is null
                and upper(trim(a.job_number)) = upper(v_job_number)
              )
            )
          )
          or (
            p_job_id is null
            and upper(trim(a.job_number)) = upper(v_job_number)
          )
        )
    ),
    candidate_requirements as (
      select
        a.allocation_id,
        a.requirement_id
      from active_allocations a
      join app.job_requirements r
        on r.org_id = a.org_id
       and r.id = a.requirement_id
      where a.requirement_id is not null
        and (
          p_job_id is null
          or r.job_id = p_job_id
        )
      union all
      select
        a.allocation_id,
        legacy_match.requirement_id
      from active_allocations a
      left join lateral (
        select
          count(*)::integer as box_match_count,
          (array_agg(b.manufacturer order by b.updated_at desc, b.id))[1] as manufacturer,
          (array_agg(b.film_name order by b.updated_at desc, b.id))[1] as film_name,
          (array_agg(b.width_in order by b.updated_at desc, b.id))[1] as width_in
        from app.boxes b
        where b.org_id = a.org_id
          and upper(trim(b.box_id)) = upper(trim(a.box_id))
          and (
            upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'
            or (
              p_job_id is not null
              and b.last_checkout_job_id = p_job_id
            )
            or (
              p_job_id is null
              and upper(trim(coalesce(b.last_checkout_job, ''))) = upper(v_job_number)
            )
          )
      ) box_match on true
      left join lateral (
        select
          count(*)::integer as requirement_match_count,
          (array_agg(r.id order by r.created_at, r.id))[1] as requirement_id
        from app.job_requirements r
        where r.org_id = a.org_id
          and r.job_id = coalesce(a.job_id, p_job_id)
          and box_match.box_match_count = 1
          and r.width_in = box_match.width_in
          and app_api.normalize_requirement_film_key(r.org_id, r.manufacturer, r.film_name) =
            app_api.normalize_requirement_film_key(a.org_id, box_match.manufacturer, box_match.film_name)
      ) legacy_match on true
      where a.requirement_id is null
        and box_match.box_match_count = 1
        and legacy_match.requirement_match_count = 1
    )
    select
      a.allocation_id,
      cr.requirement_id,
      r.job_id,
      greatest(coalesce(nullif(a.covered_feet, 0), a.allocated_feet, 0), 0)::integer as usage_basis_feet
    from candidate_requirements cr
    join app.allocations a
      on a.org_id = p_org_id
     and a.allocation_id = cr.allocation_id
    join app.job_requirements r
      on r.org_id = a.org_id
     and r.id = cr.requirement_id
    order by a.created_at asc, a.allocation_id asc
    for update of a, r
  loop
    exit when v_remaining_feet <= 0;
    v_index := v_index + 1;
    v_applied_feet := case
      when v_index = v_candidate_count then v_remaining_feet
      else least(v_remaining_feet, greatest(coalesce(v_row.usage_basis_feet, 0), 0))
    end;

    if v_applied_feet <= 0 then
      continue;
    end if;

    update app.job_requirements
    set actual_used_feet = greatest(coalesce(actual_used_feet, 0), 0) + v_applied_feet,
        updated_at = timezone('utc', now()),
        updated_by = app_api.trim_text(p_actor)
    where org_id = p_org_id
      and job_id = v_row.job_id
      and id = v_row.requirement_id;

    v_recorded_feet := v_recorded_feet + v_applied_feet;
    if not (v_row.requirement_id = any(v_requirement_ids)) then
      v_requirement_ids := array_append(v_requirement_ids, v_row.requirement_id);
    end if;
    v_remaining_feet := v_remaining_feet - v_applied_feet;
  end loop;

  return jsonb_build_object(
    'recordedFeet', v_recorded_feet,
    'requirementIds', to_jsonb(v_requirement_ids),
    'warnings', to_jsonb(v_warnings)
  );
end;
$$;

do $$
declare
  v_def text;
  v_next text;
  v_base text;
begin
  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('Consumed during film box check-in after actual LF was recorded.' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
    v_reconciliation_result := app_api.reconcile_box_checkin_allocations(
$old$, E'\r\n', E'\n'),
      replace($new$
    if coalesce(v_existing.status::text, '') = 'CHECKED_OUT'
       and v_same_job_active_allocation_count > 0
       and (v_checkout_job_id is not null or v_checkout_job <> '') then
      v_same_job_release := app_api.cancel_active_allocations_for_box_job(
        p_org_id,
        v_box.box_id,
        v_checkout_job,
        p_actor,
        'Consumed during film box check-in after actual LF was recorded.',
        v_checkout_job_id
      );
      if coalesce((v_same_job_release->>'cancelledCount')::integer, 0) > 0 then
        v_warnings := app_api.push_warning(
          v_warnings,
          format(
            'Resolved %s checked-out allocation%s totaling %s LF for job %s.',
            (v_same_job_release->>'cancelledCount')::integer,
            case when (v_same_job_release->>'cancelledCount')::integer = 1 then '' else 's' end,
            coalesce((v_same_job_release->>'cancelledFeet')::integer, 0),
            coalesce(nullif(v_checkout_job, ''), 'UNKNOWN')
          )
        );
      end if;
    end if;

    v_reconciliation_result := app_api.reconcile_box_checkin_allocations(
$new$, E'\r\n', E'\n')
    );
  end if;

  if v_next = v_base then
    if position('Consumed during film box check-in after actual LF was recorded.' in v_next) > 0 then
      return;
    end if;
    raise exception 'api_boxes_set_status legacy check-in release patch did not match expected snippets';
  end if;

  if position('app_api.record_requirement_actual_usage_for_checkin' in v_next) = 0
     or position('Consumed during film box check-in after actual LF was recorded.' in v_next) = 0
     or position('v_reconciliation_result := app_api.reconcile_box_checkin_allocations' in v_next) = 0 then
    raise exception 'api_boxes_set_status legacy check-in release patch verification failed';
  end if;

  execute v_next;
end $$;

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
      case
        when v_existing.id is null then coalesce(v_requirement.actual_used_feet, 0)
        else greatest(coalesce(v_existing.actual_used_feet, 0), coalesce(v_requirement.actual_used_feet, 0))
      end,
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

drop table if exists pg_temp.legacy_checkin_backfill_candidates;

create temporary table legacy_checkin_backfill_candidates on commit drop as
with roll_usage as (
  select
    l.org_id,
    l.box_id,
    l.job_id,
    l.job_number,
    l.log_id,
    l.checked_out_at,
    l.checked_in_at,
    greatest(coalesce(l.feet_before, 0) - coalesce(l.feet_after, 0), 0)::integer as used_feet
  from app.roll_weight_log l
  where l.checked_in_at is not null
    and l.job_id is not null
    and greatest(coalesce(l.feet_before, 0) - coalesce(l.feet_after, 0), 0) > 0
),
candidate_pairs as (
  select
    ru.*,
    a.allocation_id,
    a.requirement_id,
    r.actual_used_feet,
    count(*) over (partition by ru.org_id, ru.log_id) as allocation_match_count
  from roll_usage ru
  join app.allocations a
    on a.org_id = ru.org_id
   and upper(trim(a.box_id)) = upper(trim(ru.box_id))
   and a.job_id = ru.job_id
   and a.status = 'ACTIVE'
   and a.requirement_id is not null
   and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
   and a.created_at <= ru.checked_in_at
   and (a.resolved_at is null or a.resolved_at <= ru.checked_in_at)
  join app.job_requirements r
    on r.org_id = a.org_id
   and r.id = a.requirement_id
   and r.job_id = a.job_id
  join app.boxes b
    on b.org_id = a.org_id
   and upper(trim(b.box_id)) = upper(trim(a.box_id))
   and upper(coalesce(b.status::text, '')) <> 'CHECKED_OUT'
),
unambiguous as (
  select *
  from candidate_pairs
  where allocation_match_count = 1
),
grouped as (
  select
    org_id,
    requirement_id,
    sum(used_feet)::integer as total_used_feet,
    min(actual_used_feet)::integer as current_actual_used_feet,
    max(checked_in_at) as latest_checked_in_at,
    array_agg(distinct allocation_id) as allocation_ids
  from unambiguous
  group by org_id, requirement_id
)
select *
from grouped
where current_actual_used_feet = 0
  and total_used_feet > 0;

do $$
declare
  v_requirement_count integer := 0;
  v_allocation_count integer := 0;
begin
  update app.job_requirements r
  set actual_used_feet = c.total_used_feet,
      updated_at = timezone('utc', now()),
      updated_by = 'legacy-checkin-reconciliation-0145'
  from legacy_checkin_backfill_candidates c
  where r.org_id = c.org_id
    and r.id = c.requirement_id
    and r.actual_used_feet = 0;
  get diagnostics v_requirement_count = row_count;

  update app.allocations a
  set status = 'CANCELLED',
      resolved_at = coalesce(c.latest_checked_in_at, timezone('utc', now())),
      resolved_by = 'legacy-checkin-reconciliation-0145',
      notes = trim(
        coalesce(a.notes, '') ||
        case when coalesce(a.notes, '') = '' then '' else ' ' end ||
        'Resolved by legacy check-in reconciliation after roll history usage was backfilled.'
      )
  from legacy_checkin_backfill_candidates c
  where a.org_id = c.org_id
    and a.allocation_id = any(c.allocation_ids)
    and a.status = 'ACTIVE';
  get diagnostics v_allocation_count = row_count;

  raise notice 'legacy check-in reconciliation backfilled % requirement row(s) and resolved % allocation row(s)',
    v_requirement_count,
    v_allocation_count;
end $$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('app_api.record_requirement_actual_usage_for_checkin(uuid, text, text, uuid, text, integer)'::regprocedure)
  into v_def;

  if position('a.requirement_id is null' in v_def) = 0
     or position('legacy_match.requirement_match_count = 1' in v_def) = 0
     or position('app_api.normalize_requirement_film_key' in v_def) = 0 then
    raise exception 'record_requirement_actual_usage_for_checkin missing safe legacy requirement mapping';
  end if;

  select pg_get_functiondef('public.api_boxes_set_status(uuid, text, jsonb)'::regprocedure)
  into v_def;

  if position('Consumed during film box check-in after actual LF was recorded.' in v_def) = 0
     or position('Resolved %s checked-out allocation%s totaling %s LF for job %s.' in v_def) = 0 then
    raise exception 'public.api_boxes_set_status missing post-usage checked-out allocation release';
  end if;

  select pg_get_functiondef('app_api.replace_job_requirements(uuid, app.jobs, jsonb, text, timestamp with time zone)'::regprocedure)
  into v_def;

  if position('greatest(coalesce(v_existing.actual_used_feet, 0), coalesce(v_requirement.actual_used_feet, 0))' in v_def) = 0 then
    raise exception 'app_api.replace_job_requirements can still erase actual_used_feet';
  end if;
end $$;
