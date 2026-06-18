-- Resolve Film Weight Chart pending reviews from the app.

create or replace function app_api.resolve_film_weight_pending_review(
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
  v_review_id_text text := btrim(coalesce(p_payload->>'reviewId', p_payload->>'review_id', ''));
  v_review_id uuid;
  v_decision text := lower(btrim(coalesce(p_payload->>'decision', p_payload->>'resolution', '')));
  v_notes text := btrim(coalesce(p_payload->>'notes', p_payload->>'note', ''));
  v_review app.film_weight_pending_reviews;
  v_sample app.film_weight_samples;
  v_review_status text;
  v_sample_status text;
  v_return_decision text;
  v_pending_count integer := 0;
begin
  if v_review_id_text = '' then
    perform app_api.raise_http(400, 'ReviewId is required.');
  end if;

  if v_review_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform app_api.raise_http(400, 'ReviewId must be a valid UUID.');
  end if;

  v_review_id := v_review_id_text::uuid;

  if v_decision in ('accept', 'accepted', 'approve', 'approved', 'usable', 'mark_usable') then
    v_review_status := 'resolved';
    v_sample_status := 'accepted';
    v_return_decision := 'accept';
  elsif v_decision in ('reject', 'rejected', 'unusable', 'mark_unusable') then
    v_review_status := 'rejected';
    v_sample_status := 'rejected';
    v_return_decision := 'reject';
  else
    perform app_api.raise_http(400, 'Decision must be accept or reject.');
  end if;

  select *
  into v_review
  from app.film_weight_pending_reviews r
  where r.org_id = p_org_id
    and r.id = v_review_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Film weight review was not found.');
  end if;

  if v_review.status <> 'open' then
    perform app_api.raise_http(409, 'Film weight review has already been resolved.');
  end if;

  select *
  into v_sample
  from app.film_weight_samples s
  where s.org_id = p_org_id
    and s.id = v_review.sample_id
  for update;

  if not found then
    perform app_api.raise_http(404, 'Film weight sample was not found.');
  end if;

  update app.film_weight_samples
  set acceptance_status = v_sample_status,
      review_reason = case when v_sample_status = 'accepted' then '' else review_reason end,
      review_reasons = case when v_sample_status = 'accepted' then '[]'::jsonb else review_reasons end,
      updated_at = timezone('utc', now())
  where org_id = p_org_id
    and id = v_sample.id
  returning * into v_sample;

  update app.film_weight_pending_reviews
  set status = v_review_status,
      resolved_at = timezone('utc', now()),
      resolved_by = coalesce(p_actor, ''),
      notes = case
        when v_notes <> '' then v_notes
        when v_review_status = 'resolved' then 'Accepted from Weight Chart review.'
        else 'Rejected from Weight Chart review.'
      end
  where org_id = p_org_id
    and id = v_review.id
  returning * into v_review;

  if v_sample.profile_id is not null then
    perform app_api.recalculate_film_weight_profile(p_org_id, v_sample.profile_id);
  end if;

  if v_review.profile_id is not null and v_review.profile_id is distinct from v_sample.profile_id then
    perform app_api.recalculate_film_weight_profile(p_org_id, v_review.profile_id);
  end if;

  select count(*)::integer
  into v_pending_count
  from app.film_weight_pending_reviews r
  where r.org_id = p_org_id
    and r.profile_id = v_sample.profile_id
    and r.status = 'open';

  return jsonb_build_object(
    'reviewId', v_review.id,
    'sampleId', v_sample.id,
    'profileId', v_sample.profile_id,
    'boxId', v_sample.source_box_id,
    'decision', v_return_decision,
    'status', v_review.status,
    'acceptanceStatus', v_sample.acceptance_status,
    'pendingReviewCount', v_pending_count
  );
end;
$$;

create or replace function public.api_acl_resolve_film_weight_pending_review(
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
  return app_api.resolve_film_weight_pending_review(p_org_id, p_actor, p_payload);
end;
$$;

select app_api.grant_execute_if_exists('app_api.resolve_film_weight_pending_review(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('app_api.resolve_film_weight_pending_review(uuid, text, jsonb)', 'service_role');
select app_api.grant_execute_if_exists('public.api_acl_resolve_film_weight_pending_review(uuid, text, jsonb)', 'authenticated');
select app_api.grant_execute_if_exists('public.api_acl_resolve_film_weight_pending_review(uuid, text, jsonb)', 'service_role');
