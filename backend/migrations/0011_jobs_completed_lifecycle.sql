do $$
begin
  alter type app.job_lifecycle_status add value if not exists 'COMPLETED';
exception
  when duplicate_object then
    null;
end;
$$;

create or replace function app_api.normalize_job_lifecycle_status(p_value text)
returns app.job_lifecycle_status
language plpgsql
immutable
as $$
begin
  return case
    when upper(app_api.trim_text(p_value)) = 'CANCELLED' then 'CANCELLED'::app.job_lifecycle_status
    when upper(app_api.trim_text(p_value)) = 'COMPLETED' then 'COMPLETED'::app.job_lifecycle_status
    else 'ACTIVE'::app.job_lifecycle_status
  end;
end;
$$;
