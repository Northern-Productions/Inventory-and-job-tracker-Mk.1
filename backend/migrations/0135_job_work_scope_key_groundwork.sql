create or replace function app_api.normalize_job_work_scope_key(p_value text)
returns text
language plpgsql
immutable
as $$
declare
  v_display text := regexp_replace(btrim(coalesce(p_value, '')), '[[:space:]]+', ' ', 'g');
  v_normalized text;
  v_section_candidate text;
  v_token_source text;
  v_section_numbers text[];
begin
  if v_display = '' then
    return 'blank:';
  end if;

  v_normalized := lower(v_display);
  v_normalized := regexp_replace(v_normalized, '[[:space:]]*,[[:space:]]*', ',', 'g');
  v_normalized := regexp_replace(v_normalized, '[[:space:]]+', ' ', 'g');
  v_normalized := btrim(v_normalized);

  v_section_candidate := regexp_replace(v_normalized, '^(sections?|secs?)\.?[[:space:]]+', '');
  v_token_source := regexp_replace(v_section_candidate, '\mand\M', ',', 'g');
  v_token_source := regexp_replace(v_token_source, '[;&]', ',', 'g');

  if v_token_source ~ '^[0-9,[:space:]]+$' then
    with raw_tokens as (
      select regexp_replace(token, '^0+', '') as token
      from regexp_split_to_table(v_token_source, '[,[:space:]]+') as parts(token)
      where parts.token <> ''
    ),
    normalized_tokens as (
      select case when token = '' then '0' else token end as token
      from raw_tokens
    )
    select array_agg(token order by length(token), token)
    into v_section_numbers
    from (
      select distinct token
      from normalized_tokens
    ) deduped;

    if coalesce(array_length(v_section_numbers, 1), 0) > 0 then
      return 'section:' || array_to_string(v_section_numbers, ',');
    end if;
  end if;

  return 'text:' || v_normalized;
end;
$$;

alter table app.jobs
  add column if not exists work_scope_key text
  generated always as (app_api.normalize_job_work_scope_key(sections)) stored;

create index if not exists idx_jobs_org_job_number_work_scope_key
  on app.jobs (org_id, job_number, work_scope_key);
