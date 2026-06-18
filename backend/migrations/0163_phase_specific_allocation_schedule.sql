-- Phase-scoped film allocations must use the selected requirement phase schedule.
--
-- Jobs may have phases with different install dates. The allocation apply RPC
-- previously validated a jobId payload date against the primary job due date
-- before loading the selected requirement, which blocked valid Phase 2
-- allocations. Keep the legacy no-requirement guard, but for requirement-bound
-- allocations derive jobDate/crewLeader from the selected requirement phase.

do $$
declare
  v_def text;
  v_next text;
begin
  select pg_get_functiondef('public.api_allocations_apply(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');

  if position('v_payload_job_date date;' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
  v_job_date date;
  v_crew_leader text;
$old$, E'\r\n', E'\n'),
      replace($new$
  v_job_date date;
  v_payload_job_date date;
  v_crew_leader text;
  v_payload_crew_leader text := '';
$new$, E'\r\n', E'\n')
    );
  end if;

  if position('v_requirement_phase_install_date date;' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
  v_requirement app.job_requirements;
  v_source_film_key text;
$old$, E'\r\n', E'\n'),
      replace($new$
  v_requirement app.job_requirements;
  v_requirement_phase_install_date date;
  v_requirement_phase_crew_leader text := '';
  v_requirement_has_phase boolean := false;
  v_source_film_key text;
$new$, E'\r\n', E'\n')
    );
  end if;

  v_next := replace(
    v_next,
    replace($old$
    v_job_date := nullif(app_api.trim_text(p_payload->>'jobDate'), '')::date;
    v_crew_leader := app_api.trim_text(p_payload->>'crewLeader');
$old$, E'\r\n', E'\n'),
    replace($new$
    v_payload_job_date := nullif(app_api.trim_text(p_payload->>'jobDate'), '')::date;
    v_payload_crew_leader := app_api.trim_text(p_payload->>'crewLeader');
    v_job_date := v_payload_job_date;
    v_crew_leader := v_payload_crew_leader;
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
    if v_job.due_date is not null and v_job_date is not null and v_job.due_date <> v_job_date then
      perform app_api.raise_http(400, 'JobDate must stay the same for an existing Job Number.');
    end if;

    if coalesce(v_job.crew_leader, '') <> ''
      and v_crew_leader <> ''
      and upper(coalesce(v_job.crew_leader, '')) <> upper(v_crew_leader)
$old$, E'\r\n', E'\n'),
    replace($new$
    if v_requirement_id_text = ''
      and v_job.due_date is not null
      and v_job_date is not null
      and v_job.due_date <> v_job_date
    then
      perform app_api.raise_http(400, 'JobDate must stay the same for an existing Job Number.');
    end if;

    if v_requirement_id_text = ''
      and coalesce(v_job.crew_leader, '') <> ''
      and v_crew_leader <> ''
      and upper(coalesce(v_job.crew_leader, '')) <> upper(v_crew_leader)
$new$, E'\r\n', E'\n')
  );

  if position('select ph.install_date, coalesce(ph.crew_leader, ''''), true' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
    v_requirement_is_exterior := app_api.requirement_film_is_exterior(
$old$, E'\r\n', E'\n'),
      replace($new$
    select ph.install_date, coalesce(ph.crew_leader, ''), true
    into v_requirement_phase_install_date, v_requirement_phase_crew_leader, v_requirement_has_phase
    from app.job_phases ph
    where ph.org_id = p_org_id
      and ph.job_id = v_job_id
      and ph.id = v_requirement.phase_id;

    if v_has_job_id and v_requirement_has_phase then
      if v_requirement_phase_install_date is not null
        and v_payload_job_date is not null
        and v_requirement_phase_install_date <> v_payload_job_date
      then
        perform app_api.raise_http(400, 'JobDate must match the selected requirement phase.');
      end if;

      if coalesce(v_requirement_phase_crew_leader, '') <> ''
        and v_payload_crew_leader <> ''
        and upper(v_requirement_phase_crew_leader) <> upper(v_payload_crew_leader)
      then
        perform app_api.raise_http(400, 'CrewLeader must match the selected requirement phase.');
      end if;

      v_job_date := v_requirement_phase_install_date;
      v_crew_leader := coalesce(nullif(v_requirement_phase_crew_leader, ''), '');

      if v_job_date is not null and v_crew_leader = '' then
        perform app_api.raise_http(400, 'CrewLeader is required when JobDate is set.');
      end if;

      v_job_context := jsonb_build_object(
        'jobId', v_job.id::text,
        'jobNumber', v_job.job_number,
        'jobDate', coalesce(to_char(v_job_date, 'YYYY-MM-DD'), ''),
        'crewLeader', v_crew_leader
      );
    end if;

    v_requirement_is_exterior := app_api.requirement_film_is_exterior(
$new$, E'\r\n', E'\n')
    );
  end if;

  if position('v_payload_job_date date;' in v_next) = 0
     or position('v_requirement_phase_install_date date;' in v_next) = 0
     or position('v_requirement_id_text = ''''' in v_next) = 0
     or position('v_requirement_has_phase then' in v_next) = 0 then
    raise exception 'api_allocations_apply phase-specific schedule patch verification failed';
  end if;

  execute v_next;
end $$;
