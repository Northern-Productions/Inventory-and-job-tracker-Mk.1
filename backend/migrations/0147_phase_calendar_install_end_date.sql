-- Add optional phase install end dates for phase-based calendar ranges.

alter table app.job_phases
  add column if not exists install_end_date date;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'app.job_phases'::regclass
      and conname = 'job_phases_install_end_date_check'
  ) then
    alter table app.job_phases
      add constraint job_phases_install_end_date_check
      check (
        install_end_date is null
        or (
          install_date is not null
          and install_end_date >= install_date
        )
      );
  end if;
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
  v_install_end_text text;
  v_install_end_date date;
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

    v_install_end_text := '';
    if p_payload ? 'phases' and jsonb_typeof(p_payload->'phases') = 'array' then
      select app_api.trim_text(coalesce(phase.value->>'installEndDate', phase.value->>'install_end_date', phase.value->>'endDate'))
        into v_install_end_text
      from jsonb_array_elements(p_payload->'phases') with ordinality as phase(value, phase_ordinality)
      where phase.phase_ordinality = v_phase.ordinality;
    else
      v_install_end_text := app_api.trim_text(coalesce(p_payload->>'installEndDate', p_payload->>'install_end_date', p_payload->>'endDate'));
    end if;

    v_install_end_date := null;
    if coalesce(v_install_end_text, '') <> '' then
      if v_phase.install_date is null then
        perform app_api.raise_http(400, 'Install End Date requires an Install Date.');
      end if;
      if v_install_end_text !~ '^\d{4}-\d{2}-\d{2}$' then
        perform app_api.raise_http(400, 'Install End Date must use yyyy-mm-dd.');
      end if;
      begin
        v_install_end_date := v_install_end_text::date;
      exception when others then
        perform app_api.raise_http(400, 'Install End Date must use yyyy-mm-dd.');
      end;
      if v_install_end_date < v_phase.install_date then
        perform app_api.raise_http(400, 'Install End Date must be the same day as or later than Install Date.');
      end if;
    end if;

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
      install_end_date,
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
      v_install_end_date,
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
      install_end_date = excluded.install_end_date,
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

select app_api.grant_execute_if_exists('app_api.replace_job_phases(uuid, app.jobs, jsonb, text, timestamptz)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.replace_job_phases(uuid, app.jobs, jsonb, text, timestamptz)', 'service_role');
