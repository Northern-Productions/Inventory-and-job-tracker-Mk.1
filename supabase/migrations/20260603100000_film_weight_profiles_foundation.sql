-- Film Weight Chart Phase 4A foundation.
-- Adds source-of-truth profile/sample/review tables plus ordered-receive sample logging.
-- This migration intentionally does not backfill historical samples.

create table if not exists app.film_weight_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  manufacturer text not null,
  film_name text not null,
  film_key text not null,
  core_type text not null,
  core_weight_lbs numeric(12,4) not null,
  average_normalized_lbs_per_inch_foot numeric(18,12) not null,
  average_lbs_per_sq_ft numeric(18,12) not null,
  accepted_sample_count integer not null default 0,
  pending_review_count integer not null default 0,
  confidence text not null default 'starter',
  status text not null default 'active',
  source_policy text not null default 'trusted_order_receive',
  first_sample_at timestamptz,
  last_sample_at timestamptz,
  last_review_at timestamptz,
  manually_overridden boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  created_by text not null default '',
  updated_by text not null default '',
  unique (org_id, film_key, core_type)
);

alter table app.film_weight_profiles
  drop constraint if exists film_weight_profiles_identity_not_blank;
alter table app.film_weight_profiles
  add constraint film_weight_profiles_identity_not_blank check (
    btrim(manufacturer) <> ''
    and btrim(film_name) <> ''
    and btrim(film_key) <> ''
    and btrim(core_type) <> ''
  );

alter table app.film_weight_profiles
  drop constraint if exists film_weight_profiles_values_valid;
alter table app.film_weight_profiles
  add constraint film_weight_profiles_values_valid check (
    core_weight_lbs > 0
    and average_normalized_lbs_per_inch_foot > 0
    and average_lbs_per_sq_ft > 0
    and accepted_sample_count >= 0
    and pending_review_count >= 0
  );

alter table app.film_weight_profiles
  drop constraint if exists film_weight_profiles_confidence_valid;
alter table app.film_weight_profiles
  add constraint film_weight_profiles_confidence_valid check (
    confidence in ('starter', 'building', 'solid', 'needs_review')
  );

alter table app.film_weight_profiles
  drop constraint if exists film_weight_profiles_status_valid;
alter table app.film_weight_profiles
  add constraint film_weight_profiles_status_valid check (
    status in ('active', 'disabled', 'needs_review')
  );

create index if not exists idx_film_weight_profiles_org_status
  on app.film_weight_profiles (org_id, status, updated_at desc);

create table if not exists app.film_weight_samples (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  profile_id uuid references app.film_weight_profiles(id) on delete set null,
  source_type text not null,
  source_box_id text not null,
  source_box_record_id uuid references app.boxes(id) on delete set null,
  source_box_code text not null default '',
  film_order_id text,
  manufacturer text not null default '',
  film_name text not null default '',
  film_key text not null default '',
  width_inches numeric(10,4),
  recorded_lf numeric(12,4),
  measured_roll_weight_lbs numeric(12,4),
  core_type text not null default '',
  core_weight_lbs numeric(12,4),
  film_only_weight_lbs numeric(12,6),
  normalized_lbs_per_inch_foot numeric(18,12),
  lbs_per_sq_ft numeric(18,12),
  sample_date timestamptz,
  date_basis text,
  acceptance_status text not null,
  estimated_lf_against_profile numeric(12,4),
  lf_error_against_profile numeric(12,4),
  review_reason text,
  review_reasons jsonb not null default '[]'::jsonb,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (org_id, source_type, source_box_id)
);

alter table app.film_weight_samples
  drop constraint if exists film_weight_samples_source_valid;
alter table app.film_weight_samples
  add constraint film_weight_samples_source_valid check (
    source_type in ('ordered_received_box', 'manual_review_approved', 'manual_override', 'future_other')
    and btrim(source_box_id) <> ''
  );

alter table app.film_weight_samples
  drop constraint if exists film_weight_samples_acceptance_valid;
alter table app.film_weight_samples
  add constraint film_weight_samples_acceptance_valid check (
    acceptance_status in ('accepted', 'pending_review', 'rejected')
  );

alter table app.film_weight_samples
  drop constraint if exists film_weight_samples_date_basis_valid;
alter table app.film_weight_samples
  add constraint film_weight_samples_date_basis_valid check (
    date_basis is null
    or date_basis in ('last_weighed_date', 'received_date', 'created_at')
  );

alter table app.film_weight_samples
  drop constraint if exists film_weight_samples_accepted_complete;
alter table app.film_weight_samples
  add constraint film_weight_samples_accepted_complete check (
    acceptance_status <> 'accepted'
    or (
      profile_id is not null
      and btrim(manufacturer) <> ''
      and btrim(film_name) <> ''
      and btrim(film_key) <> ''
      and width_inches > 0
      and recorded_lf > 0
      and measured_roll_weight_lbs > 0
      and btrim(core_type) <> ''
      and core_weight_lbs > 0
      and film_only_weight_lbs > 0
      and normalized_lbs_per_inch_foot > 0
      and lbs_per_sq_ft > 0
      and sample_date is not null
    )
  );

create index if not exists idx_film_weight_samples_org_profile
  on app.film_weight_samples (org_id, profile_id, acceptance_status, sample_date desc);

create index if not exists idx_film_weight_samples_org_film
  on app.film_weight_samples (org_id, film_key, core_type, sample_date desc);

create table if not exists app.film_weight_pending_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  profile_id uuid references app.film_weight_profiles(id) on delete set null,
  sample_id uuid references app.film_weight_samples(id) on delete cascade,
  source_box_id text not null,
  manufacturer text not null default '',
  film_name text not null default '',
  film_key text not null default '',
  reason text not null default '',
  reasons jsonb not null default '[]'::jsonb,
  status text not null default 'open',
  user_action_hint text not null default 'review_sample',
  created_at timestamptz not null default timezone('utc', now()),
  resolved_at timestamptz,
  resolved_by text,
  notes text not null default ''
);

alter table app.film_weight_pending_reviews
  drop constraint if exists film_weight_pending_reviews_status_valid;
alter table app.film_weight_pending_reviews
  add constraint film_weight_pending_reviews_status_valid check (
    status in ('open', 'resolved', 'rejected')
  );

alter table app.film_weight_pending_reviews
  drop constraint if exists film_weight_pending_reviews_box_not_blank;
alter table app.film_weight_pending_reviews
  add constraint film_weight_pending_reviews_box_not_blank check (btrim(source_box_id) <> '');

create unique index if not exists idx_film_weight_pending_reviews_one_open_per_sample
  on app.film_weight_pending_reviews (sample_id)
  where sample_id is not null and status = 'open';

create index if not exists idx_film_weight_pending_reviews_org_status
  on app.film_weight_pending_reviews (org_id, status, created_at desc);

drop trigger if exists trg_film_weight_profiles_set_updated_at on app.film_weight_profiles;
create trigger trg_film_weight_profiles_set_updated_at
before update on app.film_weight_profiles
for each row
execute function app.set_updated_at();

drop trigger if exists trg_film_weight_samples_set_updated_at on app.film_weight_samples;
create trigger trg_film_weight_samples_set_updated_at
before update on app.film_weight_samples
for each row
execute function app.set_updated_at();

alter table app.film_weight_profiles enable row level security;
alter table app.film_weight_samples enable row level security;
alter table app.film_weight_pending_reviews enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'app'
      and tablename = 'film_weight_profiles'
      and policyname = 'film_weight_profiles_rw'
  ) then
    create policy film_weight_profiles_rw on app.film_weight_profiles
    for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'app'
      and tablename = 'film_weight_samples'
      and policyname = 'film_weight_samples_rw'
  ) then
    create policy film_weight_samples_rw on app.film_weight_samples
    for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'app'
      and tablename = 'film_weight_pending_reviews'
      and policyname = 'film_weight_pending_reviews_rw'
  ) then
    create policy film_weight_pending_reviews_rw on app.film_weight_pending_reviews
    for all using (app.is_org_member(org_id)) with check (app.is_org_member(org_id));
  end if;
end;
$$;

create or replace function app_api.film_weight_profile_confidence(
  p_accepted_sample_count integer,
  p_pending_review_count integer
)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_pending_review_count, 0) > 0 then 'needs_review'
    when coalesce(p_accepted_sample_count, 0) <= 1 then 'starter'
    when coalesce(p_accepted_sample_count, 0) <= 3 then 'building'
    else 'solid'
  end;
$$;

create or replace function app_api.film_weight_user_action_hint(p_reasons text[])
returns text
language plpgsql
immutable
as $$
begin
  if p_reasons is null or coalesce(array_length(p_reasons, 1), 0) = 0 then
    return 'review_sample';
  end if;

  if 'missing_core_type' = any(p_reasons) or 'missing_core_weight' = any(p_reasons) then
    return 'add_core_type';
  end if;

  if 'missing_measured_roll_weight' = any(p_reasons)
     or 'film_only_weight_not_positive' = any(p_reasons)
     or 'normalized_weight_invalid' = any(p_reasons) then
    return 're_weigh';
  end if;

  if 'missing_lf' = any(p_reasons) then
    return 'correct_lf';
  end if;

  if 'missing_canonical_film_identity' = any(p_reasons) then
    return 'split_film_identity';
  end if;

  if 'outside_10_lf_tolerance' = any(p_reasons) then
    return 'approve_sample';
  end if;

  return 'review_sample';
end;
$$;

create or replace function app_api.recalculate_film_weight_profile(
  p_org_id uuid,
  p_profile_id uuid
)
returns app.film_weight_profiles
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_profile app.film_weight_profiles;
  v_accepted_count integer := 0;
  v_pending_count integer := 0;
  v_avg_normalized numeric;
  v_first_sample_at timestamptz;
  v_last_sample_at timestamptz;
begin
  select *
  into v_profile
  from app.film_weight_profiles p
  where p.org_id = p_org_id
    and p.id = p_profile_id
  for update;

  if not found then
    return null;
  end if;

  select
    count(*)::integer,
    avg(s.normalized_lbs_per_inch_foot),
    min(s.sample_date),
    max(s.sample_date)
  into
    v_accepted_count,
    v_avg_normalized,
    v_first_sample_at,
    v_last_sample_at
  from app.film_weight_samples s
  where s.org_id = p_org_id
    and s.profile_id = p_profile_id
    and s.acceptance_status = 'accepted';

  select count(*)::integer
  into v_pending_count
  from app.film_weight_pending_reviews r
  where r.org_id = p_org_id
    and r.profile_id = p_profile_id
    and r.status = 'open';

  update app.film_weight_profiles
  set accepted_sample_count = v_accepted_count,
      pending_review_count = v_pending_count,
      average_normalized_lbs_per_inch_foot = coalesce(v_avg_normalized, average_normalized_lbs_per_inch_foot),
      average_lbs_per_sq_ft = coalesce(v_avg_normalized * 12, average_lbs_per_sq_ft),
      confidence = app_api.film_weight_profile_confidence(v_accepted_count, v_pending_count),
      status = case when v_pending_count > 0 then 'needs_review' else 'active' end,
      first_sample_at = coalesce(v_first_sample_at, first_sample_at),
      last_sample_at = coalesce(v_last_sample_at, last_sample_at),
      updated_at = timezone('utc', now())
  where org_id = p_org_id
    and id = p_profile_id
  returning * into v_profile;

  return v_profile;
end;
$$;

create or replace function app_api.record_film_weight_sample_from_box(
  p_org_id uuid,
  p_box_id text,
  p_actor text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_lookup_box_id text := app_api.resolve_box_id_alias(p_org_id, app_api.require_text(p_box_id, 'BoxID'));
  v_box app.boxes;
  v_link app.film_order_box_links;
  v_existing_sample app.film_weight_samples;
  v_sample app.film_weight_samples;
  v_profile app.film_weight_profiles;
  v_previous_profile_id uuid;
  v_effective_profile_id uuid;
  v_manufacturer text := '';
  v_film_name text := '';
  v_film_key text := '';
  v_core_type text := '';
  v_core_weight_lbs numeric;
  v_profile_core_weight_lbs numeric;
  v_recorded_lf numeric;
  v_measured_roll_weight_lbs numeric;
  v_width_inches numeric;
  v_sample_date timestamptz;
  v_date_basis text;
  v_film_only_weight_lbs numeric;
  v_normalized_lbs_per_inch_foot numeric;
  v_lbs_per_sq_ft numeric;
  v_estimated_lf numeric;
  v_lf_error numeric;
  v_reasons text[] := array[]::text[];
  v_acceptance_status text := 'pending_review';
  v_decision text := 'pending_review';
  v_action_hint text := 'review_sample';
  v_review_id uuid;
begin
  select *
  into v_box
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Box not found.');
  end if;

  select *
  into v_link
  from app.film_order_box_links l
  where l.org_id = p_org_id
    and l.box_id = v_lookup_box_id
  order by l.created_at desc, l.link_id desc
  limit 1;

  if not found then
    return jsonb_build_object('decision', 'skipped', 'reason', 'not_film_order_linked');
  end if;

  if v_box.received_date is null and upper(coalesce(v_box.status::text, '')) = 'ORDERED' then
    return jsonb_build_object('decision', 'skipped', 'reason', 'ordered_not_received');
  end if;

  if v_box.last_weighed_date is not null then
    v_sample_date := v_box.last_weighed_date::timestamptz;
    v_date_basis := 'last_weighed_date';
  elsif v_box.received_date is not null then
    v_sample_date := v_box.received_date::timestamptz;
    v_date_basis := 'received_date';
  elsif v_box.created_at is not null then
    v_sample_date := v_box.created_at;
    v_date_basis := 'created_at';
  end if;

  if v_sample_date is null then
    v_reasons := array_append(v_reasons, 'missing_trusted_sample_date');
  elsif v_sample_date::date < date '2026-04-05' then
    return jsonb_build_object('decision', 'skipped', 'reason', 'before_trusted_sample_cutoff');
  end if;

  v_manufacturer := app_api.canonical_manufacturer_label(v_box.manufacturer);
  v_film_name := app_api.normalize_collapsed_catalog_label(
    app_api.resolve_canonical_film_name(p_org_id, v_manufacturer, v_box.film_name)
  );
  v_film_key := app_api.normalize_requirement_film_key(p_org_id, v_manufacturer, v_film_name);
  v_width_inches := v_box.width_in;
  v_recorded_lf := v_box.initial_feet;
  v_measured_roll_weight_lbs := coalesce(v_box.last_roll_weight_lbs, v_box.initial_weight_lbs);
  v_core_type := app_api.trim_text(v_box.core_type);
  v_core_weight_lbs := v_box.core_weight_lbs;

  if v_manufacturer = '' or v_film_name = '' or v_film_key = '' then
    v_reasons := array_append(v_reasons, 'missing_canonical_film_identity');
  end if;
  if v_width_inches is null or v_width_inches <= 0 then
    v_reasons := array_append(v_reasons, 'missing_width');
  end if;
  if v_recorded_lf is null or v_recorded_lf <= 0 then
    v_reasons := array_append(v_reasons, 'missing_lf');
  end if;
  if v_measured_roll_weight_lbs is null or v_measured_roll_weight_lbs <= 0 then
    v_reasons := array_append(v_reasons, 'missing_measured_roll_weight');
  end if;
  if v_core_type = '' then
    v_reasons := array_append(v_reasons, 'missing_core_type');
  end if;
  if v_core_weight_lbs is null or v_core_weight_lbs <= 0 then
    v_reasons := array_append(v_reasons, 'missing_core_weight');
  end if;

  if coalesce(array_length(v_reasons, 1), 0) = 0 then
    v_film_only_weight_lbs := round(v_measured_roll_weight_lbs - v_core_weight_lbs, 6);
    v_normalized_lbs_per_inch_foot := round(v_film_only_weight_lbs / (v_width_inches * v_recorded_lf), 12);
    v_lbs_per_sq_ft := round(v_normalized_lbs_per_inch_foot * 12, 12);

    if v_film_only_weight_lbs <= 0 then
      v_reasons := array_append(v_reasons, 'film_only_weight_not_positive');
    end if;
    if v_normalized_lbs_per_inch_foot is null or v_normalized_lbs_per_inch_foot <= 0 then
      v_reasons := array_append(v_reasons, 'normalized_weight_invalid');
    end if;
  end if;

  select *
  into v_existing_sample
  from app.film_weight_samples s
  where s.org_id = p_org_id
    and s.source_type = 'ordered_received_box'
    and s.source_box_id = v_lookup_box_id
  for update;
  v_previous_profile_id := v_existing_sample.profile_id;

  if coalesce(array_length(v_reasons, 1), 0) = 0 then
    select *
    into v_profile
    from app.film_weight_profiles p
    where p.org_id = p_org_id
      and p.film_key = v_film_key
      and p.core_type = v_core_type
    for update;

    if not found then
      v_profile_core_weight_lbs := app_api.derive_core_weight_lbs(v_core_type, 72);
      insert into app.film_weight_profiles (
        org_id,
        manufacturer,
        film_name,
        film_key,
        core_type,
        core_weight_lbs,
        average_normalized_lbs_per_inch_foot,
        average_lbs_per_sq_ft,
        accepted_sample_count,
        confidence,
        status,
        first_sample_at,
        last_sample_at,
        created_by,
        updated_by
      )
      values (
        p_org_id,
        v_manufacturer,
        v_film_name,
        v_film_key,
        v_core_type,
        v_profile_core_weight_lbs,
        v_normalized_lbs_per_inch_foot,
        v_lbs_per_sq_ft,
        0,
        'starter',
        'active',
        v_sample_date,
        v_sample_date,
        coalesce(p_actor, ''),
        coalesce(p_actor, '')
      )
      on conflict (org_id, film_key, core_type) do update set
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        updated_at = timezone('utc', now()),
        updated_by = coalesce(p_actor, app.film_weight_profiles.updated_by)
      returning * into v_profile;

      v_decision := 'accepted_starter_profile';
      v_acceptance_status := 'accepted';
      v_estimated_lf := v_recorded_lf;
      v_lf_error := 0;
    elsif v_profile.manually_overridden then
      v_reasons := array_append(v_reasons, 'profile_manually_overridden');
    else
      v_estimated_lf := round(
        v_film_only_weight_lbs / (v_profile.average_normalized_lbs_per_inch_foot * v_width_inches),
        4
      );
      v_lf_error := round(abs(v_estimated_lf - v_recorded_lf), 4);
      if v_lf_error <= 10 then
        v_decision := 'accepted_within_tolerance';
        v_acceptance_status := 'accepted';
      else
        v_reasons := array_append(v_reasons, 'outside_10_lf_tolerance');
      end if;
    end if;
  end if;

  if coalesce(array_length(v_reasons, 1), 0) > 0 then
    v_acceptance_status := 'pending_review';
    v_decision := 'pending_review';
  end if;

  v_effective_profile_id := coalesce(v_profile.id, v_existing_sample.profile_id);
  v_action_hint := app_api.film_weight_user_action_hint(v_reasons);

  insert into app.film_weight_samples (
    org_id,
    profile_id,
    source_type,
    source_box_id,
    source_box_record_id,
    source_box_code,
    film_order_id,
    manufacturer,
    film_name,
    film_key,
    width_inches,
    recorded_lf,
    measured_roll_weight_lbs,
    core_type,
    core_weight_lbs,
    film_only_weight_lbs,
    normalized_lbs_per_inch_foot,
    lbs_per_sq_ft,
    sample_date,
    date_basis,
    acceptance_status,
    estimated_lf_against_profile,
    lf_error_against_profile,
    review_reason,
    review_reasons
  )
  values (
    p_org_id,
    v_effective_profile_id,
    'ordered_received_box',
    v_lookup_box_id,
    v_box.id,
    v_lookup_box_id,
    v_link.film_order_id,
    v_manufacturer,
    v_film_name,
    v_film_key,
    v_width_inches,
    v_recorded_lf,
    v_measured_roll_weight_lbs,
    v_core_type,
    v_core_weight_lbs,
    v_film_only_weight_lbs,
    v_normalized_lbs_per_inch_foot,
    v_lbs_per_sq_ft,
    v_sample_date,
    v_date_basis,
    v_acceptance_status,
    v_estimated_lf,
    v_lf_error,
    array_to_string(v_reasons, ','),
    to_jsonb(v_reasons)
  )
  on conflict (org_id, source_type, source_box_id) do update set
    profile_id = excluded.profile_id,
    source_box_record_id = excluded.source_box_record_id,
    source_box_code = excluded.source_box_code,
    film_order_id = excluded.film_order_id,
    manufacturer = excluded.manufacturer,
    film_name = excluded.film_name,
    film_key = excluded.film_key,
    width_inches = excluded.width_inches,
    recorded_lf = excluded.recorded_lf,
    measured_roll_weight_lbs = excluded.measured_roll_weight_lbs,
    core_type = excluded.core_type,
    core_weight_lbs = excluded.core_weight_lbs,
    film_only_weight_lbs = excluded.film_only_weight_lbs,
    normalized_lbs_per_inch_foot = excluded.normalized_lbs_per_inch_foot,
    lbs_per_sq_ft = excluded.lbs_per_sq_ft,
    sample_date = excluded.sample_date,
    date_basis = excluded.date_basis,
    acceptance_status = excluded.acceptance_status,
    estimated_lf_against_profile = excluded.estimated_lf_against_profile,
    lf_error_against_profile = excluded.lf_error_against_profile,
    review_reason = excluded.review_reason,
    review_reasons = excluded.review_reasons,
    updated_at = timezone('utc', now())
  returning * into v_sample;

  if v_sample.acceptance_status = 'pending_review' then
    update app.film_weight_pending_reviews
    set profile_id = v_sample.profile_id,
        source_box_id = v_sample.source_box_id,
        manufacturer = v_sample.manufacturer,
        film_name = v_sample.film_name,
        film_key = v_sample.film_key,
        reason = coalesce(v_sample.review_reason, ''),
        reasons = v_sample.review_reasons,
        status = 'open',
        user_action_hint = v_action_hint,
        notes = '',
        resolved_at = null,
        resolved_by = null
    where sample_id = v_sample.id
      and status = 'open'
    returning id into v_review_id;

    if v_review_id is null then
      insert into app.film_weight_pending_reviews (
        org_id,
        profile_id,
        sample_id,
        source_box_id,
        manufacturer,
        film_name,
        film_key,
        reason,
        reasons,
        status,
        user_action_hint
      )
      values (
        p_org_id,
        v_sample.profile_id,
        v_sample.id,
        v_sample.source_box_id,
        v_sample.manufacturer,
        v_sample.film_name,
        v_sample.film_key,
        coalesce(v_sample.review_reason, ''),
        v_sample.review_reasons,
        'open',
        v_action_hint
      )
      returning id into v_review_id;
    end if;
  else
    update app.film_weight_pending_reviews
    set status = 'resolved',
        resolved_at = timezone('utc', now()),
        resolved_by = coalesce(p_actor, ''),
        notes = 'Resolved by accepted sample re-evaluation.'
    where sample_id = v_sample.id
      and status = 'open';
  end if;

  if v_sample.profile_id is not null then
    perform app_api.recalculate_film_weight_profile(p_org_id, v_sample.profile_id);
  end if;

  if v_previous_profile_id is not null and v_previous_profile_id is distinct from v_sample.profile_id then
    perform app_api.recalculate_film_weight_profile(p_org_id, v_previous_profile_id);
  end if;

  return jsonb_build_object(
    'decision', v_decision,
    'sampleId', v_sample.id,
    'profileId', v_sample.profile_id,
    'pendingReviewId', v_review_id,
    'sourceBoxId', v_sample.source_box_id,
    'acceptanceStatus', v_sample.acceptance_status,
    'reasons', v_sample.review_reasons,
    'estimatedLf', v_sample.estimated_lf_against_profile,
    'lfError', v_sample.lf_error_against_profile
  );
end;
$$;

create or replace function public.api_acl_record_film_weight_sample_from_box(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  return app_api.record_film_weight_sample_from_box(
    p_org_id,
    app_api.require_text(coalesce(p_payload->>'boxId', p_payload->>'sourceBoxId'), 'BoxID'),
    p_actor
  );
end;
$$;

create or replace function public.api_acl_get_film_weight_pending_review_count(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_count integer := 0;
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'read');

  select count(*)::integer
  into v_count
  from app.film_weight_pending_reviews r
  where r.org_id = p_org_id
    and r.status = 'open';

  return coalesce(v_count, 0);
end;
$$;

do $$
declare
  v_def text;
  v_next text;
begin
  select pg_get_functiondef('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');

  if position('app_api.record_film_weight_sample_from_box(p_org_id, v_lookup_box_id, p_actor)' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
  return jsonb_build_object(
$old$, E'\r\n', E'\n'),
      replace($new$
  begin
    perform app_api.record_film_weight_sample_from_box(p_org_id, v_lookup_box_id, p_actor);
  exception
    when others then
      v_warnings := v_warnings || array[
        'Film weight profile logging could not be completed; receive succeeded and the sample can be reviewed later.'
      ];
  end;

  return jsonb_build_object(
$new$, E'\r\n', E'\n')
    );

    if position('app_api.record_film_weight_sample_from_box(p_org_id, v_lookup_box_id, p_actor)' in v_next) = 0 then
      raise exception 'api_acl_boxes_receive_ordered film weight logging patch did not match expected snippet';
    end if;

    execute v_next;
  end if;
end;
$$;

do $$
declare
  v_def text;
  v_next text;
begin
  select pg_get_functiondef('public.api_acl_boxes_add(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');

  if position('app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>''boxId''), p_actor)' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
  return public.api_boxes_add(p_org_id, p_actor, v_payload);
$old$, E'\r\n', E'\n'),
      replace($new$
  v_result := public.api_boxes_add(p_org_id, p_actor, v_payload);
  begin
    perform app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>'boxId'), p_actor);
  exception
    when others then
      null;
  end;
  return v_result;
$new$, E'\r\n', E'\n')
    );

    if position('v_result := public.api_boxes_add(p_org_id, p_actor, v_payload);' in v_next) = 0 then
      v_next := replace(
        v_next,
        replace($old$
  return public.api_boxes_add(p_org_id, p_actor, p_payload);
$old$, E'\r\n', E'\n'),
        replace($new$
  v_result := public.api_boxes_add(p_org_id, p_actor, p_payload);
  begin
    perform app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>'boxId'), p_actor);
  exception
    when others then
      null;
  end;
  return v_result;
$new$, E'\r\n', E'\n')
      );
    end if;

    if position('app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>''boxId''), p_actor)' in v_next) = 0 then
      raise exception 'api_acl_boxes_add film weight logging patch did not match expected snippet';
    end if;

    if position('v_result jsonb;' in v_next) = 0 then
      v_next := replace(v_next, E'declare\n', E'declare\n  v_result jsonb;\n');
    end if;

    execute v_next;
  end if;
end;
$$;

do $$
declare
  v_def text;
  v_next text;
begin
  select pg_get_functiondef('public.api_acl_boxes_update(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');

  if position('app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>''boxId''), p_actor)' in v_next) = 0 then
    v_next := replace(
      v_next,
      replace($old$
  return v_result;
$old$, E'\r\n', E'\n'),
      replace($new$
  begin
    perform app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>'boxId'), p_actor);
  exception
    when others then
      null;
  end;
  return v_result;
$new$, E'\r\n', E'\n')
    );

    if position('app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>''boxId''), p_actor)' in v_next) = 0 then
      v_next := replace(
        v_next,
      replace($old$
  return public.api_boxes_update(p_org_id, p_actor, v_payload);
$old$, E'\r\n', E'\n'),
      replace($new$
  v_result := public.api_boxes_update(p_org_id, p_actor, v_payload);
  begin
    perform app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>'boxId'), p_actor);
  exception
    when others then
      null;
  end;
  return v_result;
$new$, E'\r\n', E'\n')
      );
    end if;

    if position('v_result := public.api_boxes_update(p_org_id, p_actor, v_payload);' in v_next) = 0 then
      v_next := replace(
        v_next,
        replace($old$
  return public.api_boxes_update(p_org_id, p_actor, p_payload);
$old$, E'\r\n', E'\n'),
        replace($new$
  v_result := public.api_boxes_update(p_org_id, p_actor, p_payload);
  begin
    perform app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>'boxId'), p_actor);
  exception
    when others then
      null;
  end;
  return v_result;
$new$, E'\r\n', E'\n')
      );
    end if;

    if position('app_api.record_film_weight_sample_from_box(p_org_id, app_api.trim_text(v_result->>''boxId''), p_actor)' in v_next) = 0 then
      raise exception 'api_acl_boxes_update film weight logging patch did not match expected snippet';
    end if;

    if position('v_result jsonb;' in v_next) = 0 then
      v_next := replace(v_next, E'declare\n', E'declare\n  v_result jsonb;\n');
    end if;

    execute v_next;
  end if;
end;
$$;

select app_api.grant_execute_if_exists('public.api_acl_record_film_weight_sample_from_box(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_record_film_weight_sample_from_box(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_get_film_weight_pending_review_count(uuid)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_get_film_weight_pending_review_count(uuid)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_receive_ordered(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_boxes_add(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_add(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_boxes_update(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_boxes_update(uuid, text, jsonb)', 'service_role');
