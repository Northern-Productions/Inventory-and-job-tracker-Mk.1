-- Manual allocation apply must use only explicitly selected suggestion boxes.
--
-- Auto Allocate remains planner-driven. Manual Apply may partially fulfill a
-- requirement and must leave the remaining LF open instead of silently adding
-- extra boxes from another warehouse.

do $$
declare
  v_def text;
  v_next text;
  v_base text;
begin
  select pg_get_functiondef('public.api_allocations_apply(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('v_auto_allocate boolean := coalesce((p_payload->>''autoAllocate'')::boolean, false);' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
  v_selected_box_ids text[] := coalesce(
    array(select jsonb_array_elements_text(coalesce(p_payload->'selectedSuggestionBoxIds', '[]'::jsonb))),
    array[]::text[]
  );
$old$, E'\r\n', E'\n'),
      replace($new$
  v_auto_allocate boolean := coalesce((p_payload->>'autoAllocate')::boolean, false);
  v_selected_box_ids text[] := coalesce(
    array(select jsonb_array_elements_text(coalesce(p_payload->'selectedSuggestionBoxIds', '[]'::jsonb))),
    array[]::text[]
  );
$new$, E'\r\n', E'\n')
    );
  end if;

  if position('if not v_auto_allocate and array_position(v_selected_box_ids, v_candidate.box_id) is null then' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
    if coalesce(array_length(v_selected_box_ids, 1), 0) > 0 and array_position(v_selected_box_ids, v_candidate.box_id) is null then
      continue;
    end if;
$old$, E'\r\n', E'\n'),
      replace($new$
    if not v_auto_allocate and array_position(v_selected_box_ids, v_candidate.box_id) is null then
      continue;
    end if;
$new$, E'\r\n', E'\n')
    );
  end if;

  if v_next = v_base then
    if position('v_auto_allocate boolean := coalesce((p_payload->>''autoAllocate'')::boolean, false);' in v_next) > 0
       and position('if not v_auto_allocate and array_position(v_selected_box_ids, v_candidate.box_id) is null then' in v_next) > 0 then
      return;
    end if;
    raise exception 'api_allocations_apply explicit manual selection patch did not match expected snippets';
  end if;

  if position('v_auto_allocate boolean := coalesce((p_payload->>''autoAllocate'')::boolean, false);' in v_next) = 0
     or position('if not v_auto_allocate and array_position(v_selected_box_ids, v_candidate.box_id) is null then' in v_next) = 0 then
    raise exception 'api_allocations_apply explicit manual selection patch verification failed';
  end if;

  execute v_next;
end $$;
