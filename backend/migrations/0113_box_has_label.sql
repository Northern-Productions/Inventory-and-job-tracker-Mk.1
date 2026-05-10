alter table app.boxes
  add column if not exists has_label boolean not null default true;

update app.boxes
set has_label = true
where has_label is null;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('app_api.save_box(app.boxes)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('has_label = excluded.has_label' in v_base) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    replace($old$
    direct_to_job_site,
    has_ever_been_checked_out,
$old$, E'\r\n', E'\n'),
    replace($new$
    direct_to_job_site,
    has_label,
    has_ever_been_checked_out,
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
    coalesce(p_box.direct_to_job_site, false),
    coalesce(p_box.has_ever_been_checked_out, false),
$old$, E'\r\n', E'\n'),
    replace($new$
    coalesce(p_box.direct_to_job_site, false),
    coalesce(p_box.has_label, true),
    coalesce(p_box.has_ever_been_checked_out, false),
$new$, E'\r\n', E'\n')
  );

  v_next := replace(
    v_next,
    replace($old$
    direct_to_job_site = excluded.direct_to_job_site,
    has_ever_been_checked_out = excluded.has_ever_been_checked_out,
$old$, E'\r\n', E'\n'),
    replace($new$
    direct_to_job_site = excluded.direct_to_job_site,
    has_label = excluded.has_label,
    has_ever_been_checked_out = excluded.has_ever_been_checked_out,
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base
     or position('has_label = excluded.has_label' in v_next) = 0
     or position('coalesce(p_box.has_label, true)' in v_next) = 0 then
    raise exception 'app_api.save_box has_label patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('app_api.public_box_json(app.boxes)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('''hasLabel'', coalesce(p_box.has_label, true)' in v_base) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    replace($old$
    'directToJobSite', coalesce(p_box.direct_to_job_site, false),
    'hasEverBeenCheckedOut', p_box.has_ever_been_checked_out,
$old$, E'\r\n', E'\n'),
    replace($new$
    'directToJobSite', coalesce(p_box.direct_to_job_site, false),
    'hasLabel', coalesce(p_box.has_label, true),
    'hasEverBeenCheckedOut', p_box.has_ever_been_checked_out,
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base
     or position('''hasLabel'', coalesce(p_box.has_label, true)' in v_next) = 0 then
    raise exception 'app_api.public_box_json has_label patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('app_api.public_box_state_to_box_row(uuid, jsonb, uuid)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('v_box.has_label := coalesce((p_state->>''hasLabel'')::boolean, true);' in v_base) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    replace($old$
  v_box.direct_to_job_site := coalesce((p_state->>'directToJobSite')::boolean, false);
  v_box.has_ever_been_checked_out := coalesce((p_state->>'hasEverBeenCheckedOut')::boolean, false);
$old$, E'\r\n', E'\n'),
    replace($new$
  v_box.direct_to_job_site := coalesce((p_state->>'directToJobSite')::boolean, false);
  v_box.has_label := coalesce((p_state->>'hasLabel')::boolean, true);
  v_box.has_ever_been_checked_out := coalesce((p_state->>'hasEverBeenCheckedOut')::boolean, false);
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base
     or position('v_box.has_label := coalesce((p_state->>''hasLabel'')::boolean, true);' in v_next) = 0 then
    raise exception 'app_api.public_box_state_to_box_row has_label patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('v_box.has_label := false;' in v_base) > 0 then
    return;
  end if;

  v_next := replace(
    v_next,
    replace($old$
  v_box.status := 'IN_STOCK';
  v_box.received_date := current_date;
  v_box.feet_available := greatest(coalesce(v_existing.initial_feet, 0) - v_locked_allocated_feet, 0);
$old$, E'\r\n', E'\n'),
    replace($new$
  v_box.status := 'IN_STOCK';
  v_box.received_date := current_date;
  v_box.has_label := false;
  v_box.feet_available := greatest(coalesce(v_existing.initial_feet, 0) - v_locked_allocated_feet, 0);
$new$, E'\r\n', E'\n')
  );

  if v_next = v_base
     or position('v_box.has_label := false;' in v_next) = 0 then
    raise exception 'api_acl_boxes_receive_ordered has_label patch did not match expected snippets';
  end if;

  execute v_next;
end;
$$;

create or replace function public.api_acl_boxes_mark_labels_printed(
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
  v_raw text;
  v_box_id text;
  v_box_ids text[] := array[]::text[];
  v_existing app.boxes;
  v_after app.boxes;
  v_log_ids text[] := array[]::text[];
begin
  perform app_api.require_org_member(p_org_id);

  if jsonb_typeof(p_payload->'boxIds') is distinct from 'array' then
    perform app_api.raise_http(400, 'BoxIDs must be a non-empty array.');
  end if;

  for v_raw in
    select value
    from jsonb_array_elements_text(p_payload->'boxIds')
  loop
    v_box_id := upper(app_api.trim_text(v_raw));
    if v_box_id <> '' and not (v_box_id = any(v_box_ids)) then
      v_box_ids := array_append(v_box_ids, v_box_id);
    end if;
  end loop;

  if coalesce(array_length(v_box_ids, 1), 0) = 0 then
    perform app_api.raise_http(400, 'BoxIDs must include at least one box.');
  end if;

  foreach v_box_id in array v_box_ids loop
    select *
    into v_existing
    from app.boxes b
    where b.org_id = p_org_id
      and b.box_id = v_box_id
    for update;

    if not found then
      perform app_api.raise_http(404, format('Box %s was not found.', v_box_id));
    end if;

    update app.boxes
    set has_label = true,
        updated_at = timezone('utc', now())
    where id = v_existing.id
    returning * into v_after;

    v_log_ids := array_append(
      v_log_ids,
      app_api.append_audit_entry(
        p_org_id,
        'UPDATE_BOX',
        v_after.box_id,
        app_api.public_box_json(v_existing),
        app_api.public_box_json(v_after),
        p_actor,
        format('Label printed for box %s.', v_after.box_id)
      )
    );
  end loop;

  return jsonb_build_object(
    'boxIds', to_jsonb(v_box_ids),
    'logIds', to_jsonb(v_log_ids)
  );
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_boxes_mark_labels_printed(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_mark_labels_printed(uuid, text, jsonb)', 'service_role');
