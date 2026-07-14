-- Forward-only migration-history remediation for the live jobs calendar schema and read RPCs.
-- Historical migration 0034 remains immutable, and staged-pickup mutations remain owned by 0157.

alter table app.jobs
  add column if not exists is_staged_for_pickup boolean not null default false;

do $jobs_calendar_column_shape$
declare
  v_data_type text;
  v_not_null boolean;
  v_default text;
begin
  select
    format_type(a.atttypid, a.atttypmod),
    a.attnotnull,
    coalesce(pg_get_expr(d.adbin, d.adrelid), '')
  into v_data_type, v_not_null, v_default
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'app'
    and c.relname = 'jobs'
    and a.attname = 'is_staged_for_pickup'
    and not a.attisdropped;

  if not found
    or v_data_type <> 'boolean'
    or not v_not_null
    or v_default not in ('false', 'false::boolean') then
    raise exception 'app.jobs.is_staged_for_pickup does not match boolean not null default false';
  end if;
end;
$jobs_calendar_column_shape$;

create index if not exists idx_jobs_org_due_date_lifecycle
  on app.jobs (org_id, due_date desc, lifecycle_status, job_number);

do $jobs_calendar_index_shape$
declare
  v_definition text;
  v_is_unique boolean;
  v_is_valid boolean;
  v_is_ready boolean;
  v_is_partial boolean;
  v_has_expressions boolean;
begin
  select
    pg_get_indexdef(i.indexrelid),
    i.indisunique,
    i.indisvalid,
    i.indisready,
    i.indpred is not null,
    i.indexprs is not null
  into
    v_definition,
    v_is_unique,
    v_is_valid,
    v_is_ready,
    v_is_partial,
    v_has_expressions
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app'
    and c.relname = 'idx_jobs_org_due_date_lifecycle';

  if not found
    or v_is_unique
    or not v_is_valid
    or not v_is_ready
    or v_is_partial
    or v_has_expressions
    or v_definition <> 'CREATE INDEX idx_jobs_org_due_date_lifecycle ON app.jobs USING btree (org_id, due_date DESC, lifecycle_status, job_number)' then
    raise exception 'app.idx_jobs_org_due_date_lifecycle does not match the canonical jobs calendar index';
  end if;
end;
$jobs_calendar_index_shape$;

create or replace function public.api_jobs_calendar(
  p_org_id uuid,
  p_month text,
  p_lifecycle_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_result jsonb;
  v_month text := app_api.trim_text(p_month);
  v_lifecycle text := upper(app_api.trim_text(p_lifecycle_status));
  v_start date;
  v_end date;
begin
  perform app_api.require_org_member(p_org_id);

  if v_month !~ '^\d{4}-\d{2}$' then
    perform app_api.raise_http(400, 'month must use yyyy-mm.');
  end if;

  if v_lifecycle = '' then
    v_lifecycle := 'ACTIVE';
  end if;

  if v_lifecycle not in ('ACTIVE', 'COMPLETED') then
    perform app_api.raise_http(400, 'lifecycleStatus must be ACTIVE or COMPLETED.');
  end if;

  v_start := (v_month || '-01')::date;
  v_end := (v_start + interval '1 month')::date;

  select coalesce(
    jsonb_agg(to_jsonb(j) order by j.due_date asc nulls last, j.job_number asc),
    '[]'::jsonb
  )
  into v_result
  from app.jobs j
  where j.org_id = p_org_id
    and j.due_date >= v_start
    and j.due_date < v_end
    and j.lifecycle_status::text = v_lifecycle;

  return v_result;
end;
$$;

create or replace function public.api_acl_list_jobs_calendar(
  p_org_id uuid,
  p_month text,
  p_lifecycle_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'jobs', 'read');
  return public.api_jobs_calendar(p_org_id, p_month, p_lifecycle_status);
end;
$$;

-- Preserve environment-specific service_role grants while enforcing the reviewed user-session baseline.
revoke execute on function public.api_jobs_calendar(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.api_acl_list_jobs_calendar(uuid, text, text) from public, anon;
grant execute on function public.api_acl_list_jobs_calendar(uuid, text, text) to authenticated;
