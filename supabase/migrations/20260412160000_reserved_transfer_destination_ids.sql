create or replace function app_api.plan_transfer_destination_box_id(
  p_org_id uuid,
  p_box_id text,
  p_source_prefix text,
  p_destination_prefix text
)
returns text
language plpgsql
stable
security definer
set search_path = public, app, app_api
as $$
declare
  v_box_id text := upper(app_api.require_text(p_box_id, 'BoxID'));
  v_source_prefix text := upper(app_api.require_text(p_source_prefix, 'Source box prefix'));
  v_destination_prefix text := upper(app_api.require_text(p_destination_prefix, 'Destination box prefix'));
  v_remainder text;
  v_segments text[];
  v_origin_index integer := 0;
  v_origin_prefix text := '';
  v_local_segments text[];
  v_extra_segments text[] := '{}'::text[];
  v_result_segments text[];
  v_index integer;
  v_candidate text;
begin
  if left(v_box_id, length(v_source_prefix) + 1) = v_source_prefix || '-' then
    v_remainder := substr(v_box_id, length(v_source_prefix) + 2);
  elsif strpos(v_box_id, '-') > 0 then
    v_remainder := substr(v_box_id, strpos(v_box_id, '-') + 1);
  else
    v_remainder := v_box_id;
  end if;

  v_segments := array_remove(regexp_split_to_array(v_remainder, '-'), '');
  if coalesce(array_length(v_segments, 1), 0) = 0 then
    v_segments := array[v_box_id];
  end if;

  if coalesce(array_length(v_segments, 1), 0) >= 2 then
    for v_index in 2..array_length(v_segments, 1) loop
      v_candidate := upper(coalesce(v_segments[v_index], ''));
      if v_candidate = v_source_prefix then
        continue;
      end if;

      if exists (
        select 1
        from app.warehouses w
        where w.org_id = p_org_id
          and coalesce(nullif(upper(btrim(w.box_id_prefix)), ''), upper(btrim(w.code))) = v_candidate
      ) then
        v_origin_index := v_index;
        exit;
      end if;
    end loop;
  end if;

  if v_origin_index > 0 then
    v_origin_prefix := upper(v_segments[v_origin_index]);
    v_local_segments := v_segments[1:v_origin_index - 1];
    if array_length(v_segments, 1) > v_origin_index then
      v_extra_segments := v_segments[v_origin_index + 1:array_length(v_segments, 1)];
    end if;
  else
    v_local_segments := v_segments;
  end if;

  if coalesce(array_length(v_local_segments, 1), 0) = 0 then
    v_local_segments := array[v_box_id];
  end if;

  if v_origin_prefix <> '' and v_origin_prefix = v_destination_prefix then
    v_result_segments := array_cat(v_local_segments, v_extra_segments);
  elsif v_origin_prefix <> '' then
    v_result_segments := array_cat(v_local_segments, array[v_origin_prefix]);
    v_result_segments := array_cat(v_result_segments, v_extra_segments);
  else
    v_result_segments := array_cat(v_local_segments, array[v_source_prefix]);
  end if;

  return v_destination_prefix || '-' || array_to_string(v_result_segments, '-');
end;
$$;

with pending_transfer_destinations as (
  select
    t.id,
    app_api.plan_transfer_destination_box_id(
      t.org_id,
      t.source_box_id,
      coalesce(nullif(upper(btrim(sw.box_id_prefix)), ''), upper(btrim(sw.code))),
      coalesce(nullif(upper(btrim(dw.box_id_prefix)), ''), upper(btrim(dw.code)))
    ) as destination_box_id
  from app.box_transfers t
  join app.warehouses sw
    on sw.org_id = t.org_id
   and sw.code = t.source_warehouse
  join app.warehouses dw
    on dw.org_id = t.org_id
   and dw.code = t.destination_warehouse
  where t.status = 'PENDING'
)
update app.box_transfers t
set
  destination_box_id = p.destination_box_id,
  updated_at = now()
from pending_transfer_destinations p
where t.id = p.id
  and t.destination_box_id <> p.destination_box_id;

create unique index if not exists idx_box_transfers_one_pending_destination_box
  on app.box_transfers (org_id, destination_box_id)
  where status = 'PENDING';
