create or replace function public.api_list_roll_history_by_box(
  p_org_id uuid,
  p_box_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  select coalesce(
    jsonb_agg(
      to_jsonb(r)
      order by r.checked_in_at desc nulls last, r.checked_out_at desc nulls last, r.log_id desc
    ),
    '[]'::jsonb
  )
  into v_result
  from app.roll_weight_log r
  where r.org_id = p_org_id
    and r.box_id = app_api.trim_text(p_box_id);

  return v_result;
end;
$$;

grant execute on function public.api_list_roll_history_by_box(uuid, text) to authenticated;
