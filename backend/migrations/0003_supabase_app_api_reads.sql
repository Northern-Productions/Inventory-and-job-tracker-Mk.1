create schema if not exists app_api;

create index if not exists idx_allocations_org_upper_job_number
  on app.allocations (org_id, upper(job_number));

create index if not exists idx_film_orders_org_upper_job_number
  on app.film_orders (org_id, upper(job_number));

create index if not exists idx_film_order_links_org_box_id
  on app.film_order_box_links (org_id, box_id);

create index if not exists idx_audit_log_org_box_created_at
  on app.audit_log (org_id, box_id, created_at desc);

create or replace function app_api.raise_http(p_status integer, p_message text)
returns void
language plpgsql
as $$
begin
  raise exception using
    message = p_message,
    detail = format('status=%s', p_status);
end;
$$;

create or replace function app_api.trim_text(p_value text)
returns text
language sql
immutable
as $$
  select btrim(coalesce(p_value, ''));
$$;

create or replace function app_api.today_date()
returns date
language sql
stable
as $$
  select (now() at time zone 'utc')::date;
$$;

create or replace function app_api.create_log_id()
returns text
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_suffix text := lpad(floor(random() * 1000)::text, 3, '0');
begin
  return to_char(v_now at time zone 'utc', 'YYYYMMDDHH24MISSMS') || '-' || v_suffix;
end;
$$;

create or replace function app_api.require_org_member(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  if auth.uid() is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  if p_org_id is null then
    perform app_api.raise_http(400, 'Organization is required.');
  end if;

  if not exists (
    select 1
    from app.organization_members m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
  ) then
    perform app_api.raise_http(403, 'You do not have access to this inventory workspace.');
  end if;
end;
$$;

create or replace function app_api.normalize_core_type(p_value text, p_allow_blank boolean default false)
returns text
language plpgsql
immutable
as $$
declare
  v_trimmed text := app_api.trim_text(p_value);
  v_normalized text := lower(v_trimmed);
begin
  if v_trimmed = '' then
    if p_allow_blank then
      return '';
    end if;

    perform app_api.raise_http(400, 'CoreType is required.');
  end if;

  if v_normalized = 'white' then
    return 'White';
  end if;

  if v_normalized = 'red' then
    return 'Red';
  end if;

  if v_normalized = 'cardboard' then
    return 'Cardboard';
  end if;

  perform app_api.raise_http(400, 'CoreType must be White, Red, or Cardboard.');
  return '';
end;
$$;

create or replace function app_api.derive_core_weight_lbs(p_core_type text, p_width_in numeric)
returns numeric
language sql
immutable
as $$
  select round(
    (
      case app_api.normalize_core_type(p_core_type, false)
        when 'White' then 2::numeric
        when 'Red' then 1.85::numeric
        else 2.05::numeric
      end / 72::numeric
    ) * p_width_in,
    4
  );
$$;

create or replace function app_api.derive_lf_weight_lbs_per_ft(p_sq_ft_weight numeric, p_width_in numeric)
returns numeric
language sql
immutable
as $$
  select round(p_sq_ft_weight * (p_width_in / 12::numeric), 6);
$$;

create or replace function app_api.derive_initial_weight_lbs(
  p_lf_weight numeric,
  p_initial_feet integer,
  p_core_weight numeric
)
returns numeric
language sql
immutable
as $$
  select round((p_lf_weight * p_initial_feet) + p_core_weight, 2);
$$;

create or replace function app_api.derive_sqft_weight_lbs_per_sqft(
  p_initial_weight numeric,
  p_core_weight numeric,
  p_width_in numeric,
  p_initial_feet integer
)
returns numeric
language plpgsql
immutable
as $$
declare
  v_area_sq_ft numeric := (p_width_in / 12::numeric) * p_initial_feet;
  v_film_only_weight numeric := p_initial_weight - p_core_weight;
begin
  if v_area_sq_ft <= 0 then
    perform app_api.raise_http(
      400,
      'WidthIn and InitialFeet must be greater than zero to derive film weight.'
    );
  end if;

  if v_film_only_weight < 0 then
    perform app_api.raise_http(
      400,
      'InitialWeightLbs must be greater than or equal to the derived core weight.'
    );
  end if;

  return round(v_film_only_weight / v_area_sq_ft, 8);
end;
$$;

create or replace function app_api.derive_feet_available_from_roll_weight(
  p_last_roll_weight numeric,
  p_core_weight numeric,
  p_lf_weight numeric,
  p_initial_feet integer
)
returns integer
language plpgsql
immutable
as $$
declare
  v_raw_feet numeric;
  v_floored integer;
begin
  if p_lf_weight is null or p_lf_weight <= 0 then
    perform app_api.raise_http(
      400,
      'LfWeightLbsPerFt must be greater than zero to calculate FeetAvailable.'
    );
  end if;

  v_raw_feet := (p_last_roll_weight - p_core_weight) / p_lf_weight;
  if v_raw_feet <= 0 then
    return 0;
  end if;

  v_floored := floor(v_raw_feet);
  if v_floored > p_initial_feet then
    return p_initial_feet;
  end if;

  return greatest(v_floored, 0);
end;
$$;

create or replace function app_api.public_box_json(p_box app.boxes)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'boxId', coalesce(p_box.box_id, ''),
    'warehouse', coalesce(p_box.warehouse::text, ''),
    'manufacturer', coalesce(p_box.manufacturer, ''),
    'filmName', coalesce(p_box.film_name, ''),
    'widthIn', p_box.width_in,
    'initialFeet', p_box.initial_feet,
    'feetAvailable', p_box.feet_available,
    'lotRun', coalesce(p_box.lot_run, ''),
    'status', coalesce(p_box.status::text, 'ORDERED'),
    'orderDate', coalesce(to_char(p_box.order_date, 'YYYY-MM-DD'), ''),
    'receivedDate', coalesce(to_char(p_box.received_date, 'YYYY-MM-DD'), ''),
    'initialWeightLbs', p_box.initial_weight_lbs,
    'lastRollWeightLbs', p_box.last_roll_weight_lbs,
    'lastWeighedDate', coalesce(to_char(p_box.last_weighed_date, 'YYYY-MM-DD'), ''),
    'filmKey', upper(coalesce(p_box.film_key, '')),
    'coreType', coalesce(p_box.core_type, ''),
    'coreWeightLbs', p_box.core_weight_lbs,
    'lfWeightLbsPerFt', p_box.lf_weight_lbs_per_ft,
    'purchaseCost', p_box.purchase_cost,
    'notes', coalesce(p_box.notes, ''),
    'hasEverBeenCheckedOut', p_box.has_ever_been_checked_out,
    'lastCheckoutJob', coalesce(p_box.last_checkout_job, ''),
    'lastCheckoutDate', coalesce(to_char(p_box.last_checkout_date, 'YYYY-MM-DD'), ''),
    'zeroedDate', coalesce(to_char(p_box.zeroed_date, 'YYYY-MM-DD'), ''),
    'zeroedReason', coalesce(p_box.zeroed_reason, ''),
    'zeroedBy', coalesce(p_box.zeroed_by, '')
  );
$$;

create or replace function app_api.public_allocation_json(p_entry app.allocations)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'allocationId', coalesce(p_entry.allocation_id, ''),
    'boxId', coalesce(p_entry.box_id, ''),
    'warehouse', coalesce(p_entry.warehouse::text, ''),
    'jobNumber', coalesce(p_entry.job_number, ''),
    'jobDate', coalesce(to_char(p_entry.job_date, 'YYYY-MM-DD'), ''),
    'crewLeader', coalesce(p_entry.crew_leader, ''),
    'allocatedFeet', p_entry.allocated_feet,
    'status', coalesce(p_entry.status::text, 'ACTIVE'),
    'createdAt', coalesce(to_char(p_entry.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'createdBy', coalesce(p_entry.created_by, ''),
    'resolvedAt', coalesce(to_char(p_entry.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'resolvedBy', coalesce(p_entry.resolved_by, ''),
    'filmOrderId', coalesce(p_entry.film_order_id, ''),
    'notes', coalesce(p_entry.notes, '')
  );
$$;

create or replace function app_api.public_film_order_linked_boxes_json(
  p_org_id uuid,
  p_film_order_id text
)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'boxId', l.box_id,
        'orderedFeet', l.ordered_feet,
        'autoAllocatedFeet', l.auto_allocated_feet
      )
      order by l.box_id asc
    ),
    '[]'::jsonb
  )
  from app.film_order_box_links l
  where l.org_id = p_org_id
    and l.film_order_id = p_film_order_id
    and exists (
      select 1
      from app.boxes b
      where b.org_id = l.org_id
        and b.box_id = l.box_id
    );
$$;

create or replace function app_api.public_film_order_json(
  p_org_id uuid,
  p_order app.film_orders
)
returns jsonb
language sql
stable
security definer
set search_path = public, app, app_api
as $$
  select jsonb_build_object(
    'filmOrderId', coalesce(p_order.film_order_id, ''),
    'jobNumber', coalesce(p_order.job_number, ''),
    'warehouse', coalesce(p_order.warehouse::text, ''),
    'manufacturer', coalesce(p_order.manufacturer, ''),
    'filmName', coalesce(p_order.film_name, ''),
    'widthIn', p_order.width_in,
    'requestedFeet', p_order.requested_feet,
    'coveredFeet', p_order.covered_feet,
    'orderedFeet', p_order.ordered_feet,
    'remainingToOrderFeet', p_order.remaining_to_order_feet,
    'jobDate', coalesce(to_char(p_order.job_date, 'YYYY-MM-DD'), ''),
    'crewLeader', coalesce(p_order.crew_leader, ''),
    'status', coalesce(p_order.status::text, 'FILM_ORDER'),
    'sourceBoxId', coalesce(p_order.source_box_id, ''),
    'createdAt', coalesce(to_char(p_order.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'createdBy', coalesce(p_order.created_by, ''),
    'resolvedAt', coalesce(to_char(p_order.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
    'resolvedBy', coalesce(p_order.resolved_by, ''),
    'notes', coalesce(p_order.notes, ''),
    'linkedBoxes', app_api.public_film_order_linked_boxes_json(p_org_id, p_order.film_order_id)
  );
$$;

create or replace function public.api_list_memberships()
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    perform app_api.raise_http(401, 'Authenticated session is required.');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'org_id', m.org_id,
        'created_at', to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      order by m.created_at asc, m.org_id asc
    ),
    '[]'::jsonb
  )
  into v_result
  from app.organization_members m
  where m.user_id = auth.uid();

  return v_result;
end;
$$;

create or replace function public.api_list_boxes(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  select coalesce(jsonb_agg(to_jsonb(b) order by b.box_id asc), '[]'::jsonb)
  into v_result
  from app.boxes b
  where b.org_id = p_org_id;

  return v_result;
end;
$$;

create or replace function public.api_find_box_by_id(p_org_id uuid, p_box_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  select to_jsonb(b)
  into v_result
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = app_api.trim_text(p_box_id);

  return v_result;
end;
$$;

create or replace function public.api_list_film_catalog(p_org_id uuid)
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
    jsonb_agg(to_jsonb(f) order by f.manufacturer asc, f.film_name asc, f.film_key asc),
    '[]'::jsonb
  )
  into v_result
  from app.film_catalog f
  where f.org_id = p_org_id;

  return v_result;
end;
$$;

create or replace function public.api_list_allocations(p_org_id uuid)
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
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.allocation_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.allocations a
  where a.org_id = p_org_id;

  return v_result;
end;
$$;

create or replace function public.api_list_allocations_by_box(
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
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.allocation_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.allocations a
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id);

  return v_result;
end;
$$;

create or replace function public.api_list_allocations_by_job(
  p_org_id uuid,
  p_job_number text
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
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.allocation_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.allocations a
  where a.org_id = p_org_id
    and upper(a.job_number) = upper(app_api.trim_text(p_job_number));

  return v_result;
end;
$$;

create or replace function public.api_list_allocations_by_film_order_id(
  p_org_id uuid,
  p_film_order_id text
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
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.allocation_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.allocations a
  where a.org_id = p_org_id
    and a.film_order_id = app_api.trim_text(p_film_order_id);

  return v_result;
end;
$$;

create or replace function public.api_list_allocations_by_ids(
  p_org_id uuid,
  p_allocation_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_ids text[] := coalesce(p_allocation_ids, array[]::text[]);
  v_result jsonb;
begin
  perform app_api.require_org_member(p_org_id);

  select coalesce(
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.allocation_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.allocations a
  where a.org_id = p_org_id
    and a.allocation_id = any(v_ids);

  return v_result;
end;
$$;

create or replace function public.api_list_active_allocations(p_org_id uuid)
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
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.allocation_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.allocations a
  where a.org_id = p_org_id
    and a.status = 'ACTIVE';

  return v_result;
end;
$$;

create or replace function public.api_list_film_orders(p_org_id uuid)
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
    jsonb_agg(to_jsonb(f) order by f.created_at desc, f.film_order_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.film_orders f
  where f.org_id = p_org_id;

  return v_result;
end;
$$;

create or replace function public.api_list_film_orders_by_job(
  p_org_id uuid,
  p_job_number text
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
    jsonb_agg(to_jsonb(f) order by f.created_at desc, f.film_order_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.film_orders f
  where f.org_id = p_org_id
    and upper(f.job_number) = upper(app_api.trim_text(p_job_number));

  return v_result;
end;
$$;

create or replace function public.api_find_film_order_by_id(
  p_org_id uuid,
  p_film_order_id text
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

  select to_jsonb(f)
  into v_result
  from app.film_orders f
  where f.org_id = p_org_id
    and f.film_order_id = app_api.trim_text(p_film_order_id);

  return v_result;
end;
$$;

create or replace function public.api_list_film_order_links(p_org_id uuid)
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
    jsonb_agg(to_jsonb(l) order by l.created_at desc, l.link_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.film_order_box_links l
  where l.org_id = p_org_id;

  return v_result;
end;
$$;

create or replace function public.api_list_film_order_links_by_film_order_id(
  p_org_id uuid,
  p_film_order_id text
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
    jsonb_agg(to_jsonb(l) order by l.created_at desc, l.link_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.film_order_box_links l
  where l.org_id = p_org_id
    and l.film_order_id = app_api.trim_text(p_film_order_id);

  return v_result;
end;
$$;

create or replace function public.api_list_film_order_links_by_box_id(
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
    jsonb_agg(to_jsonb(l) order by l.created_at desc, l.link_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.film_order_box_links l
  where l.org_id = p_org_id
    and l.box_id = app_api.trim_text(p_box_id);

  return v_result;
end;
$$;

create or replace function public.api_list_jobs(p_org_id uuid)
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
    jsonb_agg(to_jsonb(j) order by j.due_date desc nulls last, j.updated_at desc, j.job_number desc),
    '[]'::jsonb
  )
  into v_result
  from app.jobs j
  where j.org_id = p_org_id;

  return v_result;
end;
$$;

create or replace function public.api_find_job_by_number(
  p_org_id uuid,
  p_job_number text
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

  select to_jsonb(j)
  into v_result
  from app.jobs j
  where j.org_id = p_org_id
    and j.job_number = app_api.trim_text(p_job_number);

  return v_result;
end;
$$;

create or replace function public.api_list_job_requirements(p_org_id uuid)
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
      to_jsonb(q)
      order by q.job_number asc, q.manufacturer asc, q.film_name asc, q.width_in asc
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select r.*, j.job_number
    from app.job_requirements r
    join app.jobs j on j.id = r.job_id
    where r.org_id = p_org_id
  ) q;

  return v_result;
end;
$$;

create or replace function public.api_list_job_requirements_by_job(
  p_org_id uuid,
  p_job_number text
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
      to_jsonb(q)
      order by q.manufacturer asc, q.film_name asc, q.width_in asc
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select r.*, j.job_number
    from app.job_requirements r
    join app.jobs j on j.id = r.job_id
    where r.org_id = p_org_id
      and j.job_number = app_api.trim_text(p_job_number)
  ) q;

  return v_result;
end;
$$;

create or replace function public.api_list_audit_entries(p_org_id uuid)
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
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.log_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.audit_log a
  where a.org_id = p_org_id;

  return v_result;
end;
$$;

create or replace function public.api_list_audit_entries_by_box(
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
    jsonb_agg(to_jsonb(a) order by a.created_at desc, a.log_id desc),
    '[]'::jsonb
  )
  into v_result
  from app.audit_log a
  where a.org_id = p_org_id
    and a.box_id = app_api.trim_text(p_box_id);

  return v_result;
end;
$$;

create or replace function public.api_find_audit_entry_by_log_id(
  p_org_id uuid,
  p_log_id text
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

  select to_jsonb(a)
  into v_result
  from app.audit_log a
  where a.org_id = p_org_id
    and a.log_id = app_api.trim_text(p_log_id);

  return v_result;
end;
$$;

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
      order by r.checked_in_at desc nulls last, r.created_at desc nulls last, r.log_id desc
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

grant execute on function public.api_list_memberships() to authenticated;
grant execute on function public.api_list_boxes(uuid) to authenticated;
grant execute on function public.api_find_box_by_id(uuid, text) to authenticated;
grant execute on function public.api_list_film_catalog(uuid) to authenticated;
grant execute on function public.api_list_allocations(uuid) to authenticated;
grant execute on function public.api_list_allocations_by_box(uuid, text) to authenticated;
grant execute on function public.api_list_allocations_by_job(uuid, text) to authenticated;
grant execute on function public.api_list_allocations_by_film_order_id(uuid, text) to authenticated;
grant execute on function public.api_list_allocations_by_ids(uuid, text[]) to authenticated;
grant execute on function public.api_list_active_allocations(uuid) to authenticated;
grant execute on function public.api_list_film_orders(uuid) to authenticated;
grant execute on function public.api_list_film_orders_by_job(uuid, text) to authenticated;
grant execute on function public.api_find_film_order_by_id(uuid, text) to authenticated;
grant execute on function public.api_list_film_order_links(uuid) to authenticated;
grant execute on function public.api_list_film_order_links_by_film_order_id(uuid, text) to authenticated;
grant execute on function public.api_list_film_order_links_by_box_id(uuid, text) to authenticated;
grant execute on function public.api_list_jobs(uuid) to authenticated;
grant execute on function public.api_find_job_by_number(uuid, text) to authenticated;
grant execute on function public.api_list_job_requirements(uuid) to authenticated;
grant execute on function public.api_list_job_requirements_by_job(uuid, text) to authenticated;
grant execute on function public.api_list_audit_entries(uuid) to authenticated;
grant execute on function public.api_list_audit_entries_by_box(uuid, text) to authenticated;
grant execute on function public.api_find_audit_entry_by_log_id(uuid, text) to authenticated;
grant execute on function public.api_list_roll_history_by_box(uuid, text) to authenticated;
