import '../load-env.mjs';
import { Client } from 'pg';
import { normalizeFunctionDefinitionForSemanticCheck } from './lib/schema-check-helpers.mjs';

const DATABASE_URL = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
const SKIP_SCHEMA_CHECK = String(process.env.SCHEMA_CHECK_SKIP || '').trim().toLowerCase() === 'true';
const LATEST_MIGRATION = '0142_requirement_actual_usage_state.sql';

const REQUIRED_OBJECTS = [
  { kind: 'table', signature: 'app.access_requests' },
  { kind: 'column', signature: 'app.access_requests.requested_by_name' },
  { kind: 'table', signature: 'app.username_change_requests' },
  { kind: 'table', signature: 'app.general_feature_permissions' },
  { kind: 'table', signature: 'app.admin_feature_permissions' },
  { kind: 'table', signature: 'app.owner_notification_preferences' },
  { kind: 'column', signature: 'app.jobs.is_labor_only' },
  { kind: 'column', signature: 'app.jobs.is_staged_for_pickup' },
  { kind: 'column', signature: 'app.jobs.work_scope_key' },
  { kind: 'table', signature: 'app.caulk_transfers' },
  { kind: 'table', signature: 'app.box_dealers' },
  { kind: 'type', signature: 'app.allocation_source' },
  { kind: 'type', signature: 'app.caulk_transfer_status' },
  { kind: 'column', signature: 'app.boxes.dealer' },
  { kind: 'column', signature: 'app.boxes.has_label' },
  { kind: 'column', signature: 'app.boxes.last_checkout_job_id' },
  { kind: 'column', signature: 'app.allocations.allocation_source' },
  { kind: 'column', signature: 'app.caulk_job_allocations.allocation_source' },
  { kind: 'column', signature: 'app.roll_weight_log.created_at' },
  { kind: 'column', signature: 'app.roll_weight_log.job_id' },
  { kind: 'column', signature: 'app.job_requirements.status' },
  { kind: 'column', signature: 'app.job_requirements.actual_used_feet' },
  { kind: 'column', signature: 'app.job_requirements.completed_at' },
  { kind: 'column', signature: 'app.job_requirements.completed_by' },
  { kind: 'column', signature: 'app.film_orders.requirement_id' },
  { kind: 'table', signature: 'app.allocation_planner_suppressions' },
  { kind: 'function', signature: 'public.api_get_auth_context(uuid)' },
  { kind: 'function', signature: 'public.api_list_access_requests(uuid, text)' },
  { kind: 'function', signature: 'public.api_approve_access_request(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_deny_access_request(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_request_username_change(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_list_username_change_requests(uuid, text)' },
  { kind: 'function', signature: 'public.api_approve_username_change_request(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_deny_username_change_request(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_get_member_feature_permissions(uuid)' },
  { kind: 'function', signature: 'public.api_update_member_feature_permissions(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_get_user_feature_permissions(uuid, uuid)' },
  { kind: 'function', signature: 'public.api_update_user_feature_permissions(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_get_admin_feature_permissions(uuid)' },
  { kind: 'function', signature: 'public.api_update_admin_feature_permissions(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_promote_member_to_admin(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_demote_admin_to_member(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_promote_admin_to_owner(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_find_job_by_id(uuid, uuid)' },
  { kind: 'function', signature: 'public.api_acl_find_job_by_id(uuid, uuid)' },
  { kind: 'function', signature: 'app_api.normalize_job_work_scope(text)' },
  { kind: 'function', signature: 'app_api.normalize_job_work_scope_key(text)' },
  { kind: 'function', signature: 'app_api.normalize_requirement_film_family_name(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.normalize_requirement_match_surface_film_name(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.normalize_requirement_film_family_key(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.strip_requirement_match_trailing_code_alias(text)' },
  { kind: 'function', signature: 'app_api.requirement_film_is_exterior(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.requirement_film_is_compatible(uuid, text, text, text, text)' },
  { kind: 'function', signature: 'public.api_acl_boxes_delete(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_boxes_delete(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_boxes_receive_ordered(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_boxes_mark_labels_printed(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_allocations_apply(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_apply(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_allocations_remove_box(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_remove_box(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_film_orders_create(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_film_orders_cancel(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_film_orders_cancel(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_film_orders_delete(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_film_orders_delete(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_jobs_update(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_boxes_update(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_boxes_set_status(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_boxes_resolve_checkout_allocations(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_list_box_dealers(uuid)' },
  { kind: 'function', signature: 'public.api_acl_box_dealers_upsert(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_boxes_set_status(uuid, text, jsonb)' },
  { kind: 'function', signature: 'app_api.resolve_allocations_for_checkout(uuid, text, text, text, uuid)' },
  { kind: 'function', signature: 'app_api.film_order_matches_requirement(uuid, uuid, text, text, numeric, uuid, text, text, numeric)' },
  { kind: 'function', signature: 'app_api.reconcile_existing_film_order_need_for_requirement(uuid, text, uuid)' },
  { kind: 'function', signature: 'app_api.reconcile_box_checkin_allocations(uuid, text, text, integer)' },
  { kind: 'function', signature: 'app_api.normalize_requirement_status(text)' },
  { kind: 'function', signature: 'app_api.record_requirement_actual_usage_for_checkin(uuid, text, text, uuid, text, integer)' },
  { kind: 'function', signature: 'public.api_acl_job_requirement_set_state(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_jobs_set_staged_pickup(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_jobs_set_staged_pickup(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_list_job_caulk_requirements_by_job(uuid, text)' },
  { kind: 'function', signature: 'public.api_acl_list_caulk_job_allocations_by_job(uuid, text)' },
  { kind: 'function', signature: 'public.api_acl_list_caulk_transfers(uuid, text, uuid)' },
  { kind: 'function', signature: 'public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)' },
  { kind: 'function', signature: 'public.api_acl_caulk_upsert_product(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_caulk_add(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_caulk_update(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_caulk_remove(uuid, text, jsonb)' },
  { kind: 'function', signature: 'app_api.cancel_active_caulk_allocations_for_job_id(uuid, text, uuid, text, text, boolean)' },
  { kind: 'function', signature: 'public.api_acl_jobs_cancel_caulk_allocations(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_caulk_transfer_receive(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_caulk_transfer_cancel(uuid, text, jsonb)' },
  { kind: 'function', signature: 'app_api.total_active_allocated_feet_for_box(uuid, text)' },
  { kind: 'function', signature: 'app_api.locked_allocated_feet_for_box(uuid, text)' },
  { kind: 'function', signature: 'app_api.placeholder_allocated_feet_for_box(uuid, text)' },
  { kind: 'function', signature: 'app_api.compute_allocation_planning_feet(text, integer, integer, integer)' },
  { kind: 'function', signature: 'app_api.box_physical_feet_available(app.boxes)' },
  { kind: 'function', signature: 'app_api.box_allocatable_now_feet(app.boxes)' },
  { kind: 'function', signature: 'app_api.recalculate_physical_box_allocatable_now(uuid, text, integer)' },
  { kind: 'function', signature: 'app_api.recalculate_film_order(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.film_box_planner_physical_capacity(app.boxes)' },
  { kind: 'function', signature: 'app_api.film_allocation_reserves_capacity(app.allocations, text)' },
  { kind: 'function', signature: 'app_api.film_allocation_consumes_stored_capacity(app.allocations, text)' },
  { kind: 'function', signature: 'app_api.reserved_film_allocated_feet_for_box(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.stored_film_allocated_feet_for_box(uuid, text)' },
  { kind: 'function', signature: 'app_api.active_film_allocated_feet_for_box(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.physical_film_commitment_feet_for_box(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.find_order_receipt_requirement_id(uuid, text, text, text, numeric)' },
  { kind: 'function', signature: 'app_api.assert_film_box_allocation_capacity(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.create_or_merge_manual_requirement_allocation_with_coverage(uuid, app.boxes, jsonb, integer, integer, text, text, text, uuid)' },
  { kind: 'function', signature: 'app_api.auto_planner_scope_job_numbers(uuid, jsonb)' },
  { kind: 'function', signature: 'app_api.auto_planner_scope_job_ids(uuid, jsonb)' },
  { kind: 'function', signature: 'app_api.auto_planner_scope_jobs(uuid, jsonb)' },
  { kind: 'function', signature: 'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_reconcile_auto_planned_allocations(uuid, text, jsonb)' },
  { kind: 'function', signature: 'app_api.film_requirement_planner_signature(text, text, numeric, integer)' },
  { kind: 'function', signature: 'app_api.caulk_requirement_planner_signature(uuid, text, integer)' },
  { kind: 'function', signature: 'app_api.requirement_rows_from_payload_with_ids(jsonb)' },
  {
    kind: 'function',
    signature: 'app_api.replace_job_requirements(uuid, app.jobs, jsonb, text, timestamp with time zone)'
  },
  { kind: 'function', signature: 'app_api.record_auto_planned_allocation_suppression(uuid, text, text, text)' },
  { kind: 'function', signature: 'app_api.record_auto_planned_caulk_allocation_suppression(uuid, text, text, text)' },
  { kind: 'function', signature: 'app_api.clear_allocation_planner_suppression_for_requirement(uuid, text, text, uuid, text)' },
  { kind: 'function', signature: 'app_api.clear_caulk_allocation_planner_suppression_for_requirement(uuid, text, text, uuid, text)' },
  { kind: 'function', signature: 'app_api.clear_stale_allocation_planner_suppressions_for_job(uuid, text, uuid, text)' },
  { kind: 'function', signature: 'public.api_acl_record_auto_planned_allocation_suppression(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_clear_allocation_planner_suppression(uuid, text, jsonb)' },
  { kind: 'function', signature: 'app_api.save_allocation(app.allocations)' },
  { kind: 'function', signature: 'app_api.save_job(app.jobs)' },
  { kind: 'function', signature: 'app_api.process_linked_box_receipt(uuid, app.boxes, text)' },
  { kind: 'function', signature: 'app_api.append_roll_history(uuid, text, text, text, text, numeric, text, text, text, numeric, timestamp with time zone, text, numeric, numeric, integer, integer, text)' },
  { kind: 'function', signature: 'app_api.append_roll_history(uuid, text, text, text, text, numeric, text, text, text, numeric, timestamp without time zone, text, numeric, numeric, integer, integer, text)' },
  { kind: 'function', signature: 'app_api.append_roll_history(uuid, text, text, text, text, numeric, text, uuid, text, text, numeric, timestamp with time zone, text, numeric, numeric, integer, integer, text)' },
  { kind: 'function', signature: 'app_api.append_roll_history(uuid, text, text, text, text, numeric, text, uuid, text, text, numeric, timestamp without time zone, text, numeric, numeric, integer, integer, text)' },
  { kind: 'function', signature: 'app_api.cancel_active_allocations_for_box_job(uuid, text, text, text, text)' },
  { kind: 'function', signature: 'app_api.cancel_active_allocations_for_box_job(uuid, text, text, text, text, uuid)' },
  { kind: 'function', signature: 'app_api.upsert_box_dealer(uuid, text)' },
  { kind: 'function', signature: 'app_api.sync_active_job_schedule_allocations(uuid, text, date, text)' },
  { kind: 'function', signature: 'app_api.sync_active_job_schedule_allocations_by_job_id(uuid, uuid, date, text)' },
  { kind: 'function', signature: 'app_api.reconcile_auto_shortage_film_orders_for_job(uuid, text, text, boolean)' },
  { kind: 'function', signature: 'app_api.reconcile_auto_shortage_film_orders_for_box(uuid, text, text, boolean)' },
];

const REQUIRED_FUNCTION_SEMANTICS = [
  {
    signature: 'app_api.recalculate_film_order(uuid, text, text)',
    includes: [
      'v_link_count > 0',
      "upper(coalesce(b.status::text, '')) <> 'ORDERED'",
      'v_received_link_count = v_link_count'
    ],
    excludes: []
  },
  {
    signature: 'app_api.process_linked_box_receipt(uuid, app.boxes, text)',
    includes: [
      'v_recalculate_film_order_ids',
      'app_api.find_order_receipt_requirement_id(',
      'app_api.requirement_film_is_compatible(',
      'round(coalesce(r.width_in, 0)::numeric, 4) = round(coalesce(v_order.width_in, 0)::numeric, 4)',
      'Resolved ordered-box placeholder on receipt for Film Order %s.',
      'Split from ordered-box placeholder %s on receipt for Film Order %s.',
      "v_existing_allocation.allocation_source := 'FILM_ORDER_RECEIPT'::app.allocation_source;",
      'v_box.feet_available := greatest(v_box.feet_available - v_reused_feet, 0);',
      'perform app_api.recalculate_film_order(p_org_id, v_recalculate_film_order_id, p_actor);'
    ],
    excludes: ['v_box.feet_available <= 0', 'app_api.normalize_job_requirement_lookup_key(']
  },
  {
    signature: 'app_api.find_order_receipt_requirement_id(uuid, text, text, text, numeric)',
    includes: [
      'app_api.requirement_film_is_compatible(',
      'round(coalesce(r.width_in, 0)::numeric, 4) = round(coalesce(p_width_in, 0)::numeric, 4)'
    ],
    excludes: ['app_api.normalize_job_requirement_lookup_key(']
  },
  {
    signature: 'app_api.physical_film_commitment_feet_for_box(uuid, text, text)',
    includes: [
      "coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'",
      'a.requirement_id is not null',
      "app_api.trim_text(a.film_order_id) <> ''",
      "coalesce(a.allocation_source::text, 'MANUAL') = 'FILM_ORDER_RECEIPT'"
    ],
    excludes: [
      "and a.job_date is not null\n    and ("
    ]
  },
  {
    signature: 'app_api.film_allocation_consumes_stored_capacity(app.allocations, text)',
    includes: [
      'app_api.film_allocation_reserves_capacity(p_allocation, p_box_status)',
      "coalesce((p_allocation).allocation_source::text, 'MANUAL') = 'FILM_ORDER_RECEIPT'",
      "coalesce((p_allocation).allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'"
    ],
    excludes: [
      "and (p_allocation).job_date is not null\n    and upper"
    ]
  },
  {
    signature: 'public.api_acl_boxes_receive_ordered(uuid, text, jsonb)',
    includes: [
      'v_locked_allocated_feet := app_api.physical_film_commitment_feet_for_box(p_org_id, v_lookup_box_id);',
      'v_box.feet_available := greatest(coalesce(v_existing.initial_feet, 0) - coalesce(v_locked_allocated_feet, 0), 0);',
      "v_core_type := app_api.normalize_core_type(v_payload->>'coreType', true);",
      'v_box.core_weight_lbs := app_api.derive_core_weight_lbs(v_core_type, v_box.width_in);',
      'v_box.has_label := false;',
      'v_receipt_result := app_api.process_linked_box_receipt(p_org_id, v_box, p_actor);',
      'perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);',
      "v_log_id := app_api.append_audit_entry(",
      "'SET_STATUS'",
      'app_api.reconcile_auto_shortage_film_orders_for_box('
    ],
    excludes: [
      'public.api_boxes_update(p_org_id, p_actor, v_payload)',
      'v_locked_allocated_feet := app_api.locked_allocated_feet_for_box(p_org_id, v_lookup_box_id);'
    ]
  },
  {
    signature: 'public.api_acl_boxes_mark_labels_printed(uuid, text, jsonb)',
    includes: [
      "jsonb_typeof(p_payload->'boxIds')",
      'set has_label = true',
      "'UPDATE_BOX'",
      'Label printed for box %s.'
    ],
    excludes: ['label_applied_at', 'label_required_at']
  },
  {
    signature: 'app_api.normalize_job_sections(text)',
    includes: ['app_api.normalize_job_work_scope(p_value)'],
    excludes: ['Sections must contain numbers separated by commas.']
  },
  {
    signature: 'app_api.normalize_job_work_scope_key(text)',
    includes: [
      "return 'blank:';",
      "regexp_replace(v_normalized, '[[:space:]]*,[[:space:]]*', ',', 'g')",
      "regexp_replace(v_section_candidate, '\\mand\\M', ',', 'g')",
      "regexp_split_to_table(v_token_source, '[,[:space:]]+')",
      'array_agg(token order by length(token), token)',
      "return 'section:' || array_to_string(v_section_numbers, ',');",
      "return 'text:' || v_normalized;"
    ],
    excludes: ['app_api.normalize_job_work_scope(p_value)', 'update app.jobs']
  },
  {
    signature: 'public.api_jobs_create(uuid, text, jsonb)',
    includes: [
      "v_job_number text := app_api.require_job_number_digits(p_payload->>'jobNumber', 'Job ID number');",
      'v_work_scope_key text := app_api.normalize_job_work_scope_key(v_sections);',
      'and j.work_scope_key = v_work_scope_key',
      "perform app_api.raise_http(409, format('Job %s already exists.', v_job_number));",
      "case when p_payload ? 'workScope' then p_payload->>'workScope' else p_payload->>'sections' end",
      'app_api.normalize_job_work_scope(',
      "'jobId', v_job.id::text"
    ],
    excludes: [
      "app_api.normalize_job_sections(p_payload->>'sections')",
      'if not found then'
    ]
  },
  {
    signature: 'app_api.save_job(app.jobs)',
    includes: [
      'coalesce(p_job.id, gen_random_uuid())',
      'on conflict (id) do update set',
      'job_number = excluded.job_number',
      'updated_by = excluded.updated_by\n  returning * into v_row;'
    ],
    excludes: [
      'on conflict (org_id, job_number)',
      'where app.jobs.org_id = excluded.org_id\n    and app.jobs.job_number = excluded.job_number'
    ]
  },
  {
    signature: 'public.api_jobs_update(uuid, text, jsonb)',
    includes: [
      "v_job_id_text text := app_api.trim_text(p_payload->>'jobId');",
      'where j.org_id = p_org_id\n      and j.id = v_job_id\n    for update;',
      'Job identity mismatch: selected job does not match jobNumber.',
      "if p_payload ? 'workScope' or p_payload ? 'sections' then",
      "case when p_payload ? 'workScope' then p_payload->>'workScope' else p_payload->>'sections' end",
      'app_api.normalize_job_work_scope('
    ],
    excludes: ["if p_payload ? 'sections' then\n    v_job.sections := app_api.normalize_job_sections"]
  },
  {
    signature: 'public.api_acl_allocations_apply(uuid, text, jsonb)',
    includes: [
      "v_job_id_text text := app_api.trim_text(p_payload->>'jobId');",
      'Job identity mismatch: selected job does not match jobNumber.',
      'v_result := public.api_allocations_apply(p_org_id, p_actor, p_payload);',
      'perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_box_id);',
      'perform app_api.reconcile_auto_planned_allocations(',
      "'jobIds',",
      'jsonb_build_array(v_job.id)',
      "'boxIds',"
    ],
    excludes: ['perform app_api.reconcile_auto_shortage_film_orders_for_job(']
  },
  {
    signature: 'public.api_allocations_apply(uuid, text, jsonb)',
    includes: [
      "v_job_id_text text := app_api.trim_text(p_payload->>'jobId');",
      'jobId must be a valid UUID.',
      'and j.id = v_job_id',
      'Job identity mismatch: selected job does not match jobNumber.',
      'and r.job_id = v_job_id',
      'Reactivate it before allocating film.',
      'app_api.create_or_merge_manual_requirement_allocation_with_coverage(',
      'if not app_api.requirement_film_is_compatible(',
      'when v_requirement_id is not null then app_api.requirement_film_is_compatible(',
      'Extra box %s must use a compatible film and meet the requested width for this allocation.',
      "Only in-stock, ordered, or transfer boxes can be allocated.",
      "'filmOrderId', ''::text"
    ],
    excludes: [
      'Only in-stock, ordered, or matching transfer boxes can be allocated.',
      'is in transfer status but no pending transfer was found.',
      'is transferring to %s and cannot be allocated to a job in %s.',
      'Created from a shortage while trying to allocate',
      'delete from app.film_orders'
    ]
  },
  {
    signature: 'public.api_allocations_remove_box(uuid, text, jsonb)',
    includes: [
      "v_allocation_id text := app_api.require_text(v_payload->>'allocationId', 'AllocationID');",
      "v_job_id_text text := app_api.trim_text(v_payload->>'jobId');",
      'v_has_valid_job_id boolean := v_job_id_text ~*',
      'j.id = v_job_id',
      'Job identity mismatch: selected job does not match jobNumber.',
      'v_allocation.job_id is distinct from v_job.id',
      'from app.allocations a',
      'and a.allocation_id = v_allocation_id',
      'for update;',
      'update app.allocations',
      'where org_id = p_org_id',
      'and allocation_id = v_allocation.allocation_id',
      'perform app_api.record_auto_planned_allocation_suppression(',
      'perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_box.box_id);',
      'perform app_api.recalculate_film_order(p_org_id, v_film_order_id, v_actor);',
      'perform app_api.reconcile_auto_planned_allocations(',
      "'jobIds', jsonb_build_array(v_job.id)",
      "'warnings', to_jsonb(v_warnings)"
    ],
    excludes: ['auto_planner_scope_job_numbers(']
  },
  {
    signature: 'public.api_acl_allocations_remove_box(uuid, text, jsonb)',
    includes: [
      "perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write');",
      'return public.api_allocations_remove_box(p_org_id, p_actor, p_payload);'
    ],
    excludes: []
  },
  {
    signature: 'public.api_film_orders_create(uuid, text, jsonb)',
    includes: [
      "v_job_id_text text := app_api.trim_text(p_payload->>'jobId');",
      'v_has_job_id boolean := v_job_id_text <> \'\';',
      'jobId must be a valid UUID.',
      'and j.id = v_job_id',
      'Job was not found.',
      'Job identity mismatch: selected job does not match jobNumber.',
      'Job %s is closed and cannot receive film orders.',
      'RequirementID is required when jobId is supplied.',
      'RequirementID must belong to the selected job.',
      'v_requirement.job_id is distinct from v_order.job_id',
      'when v_has_job_id then fo.job_id = v_order.job_id',
      'when v_has_job_id then v_job.id',
      'when v_has_job_id then v_job.job_number',
      "coalesce(fo.status::text, '') in ('FILM_ORDER', 'FILM_ON_THE_WAY')",
      'app_api.film_order_matches_requirement(',
      'Film order product and width must match the selected requirement.',
      'Reactivate it before ordering more film.',
      'perform app_api.raise_http(',
      'Cancel it before creating another order.',
      'v_order := app_api.save_film_order(v_order);'
    ],
    excludes: ['Created from a shortage while trying to allocate']
  },
  {
    signature: 'public.api_film_orders_delete(uuid, text, jsonb)',
    includes: [
      "coalesce(v_order.status::text, '') <> 'FILM_ORDER'",
      "nullif(app_api.trim_text(v_order.source_box_id), '') is not null",
      'coalesce(v_order.covered_feet, 0) > 0 or coalesce(v_order.ordered_feet, 0) > 0',
      'from app.film_order_box_links l',
      "a.status <> 'CANCELLED'",
      'Film orders with linked ordered boxes cannot be cancelled.',
      'Film orders with fulfillment allocations cannot be cancelled.'
    ],
    excludes: []
  },
  {
    signature: 'public.api_film_orders_cancel(uuid, text, jsonb)',
    includes: [
      "v_job_id_text text := app_api.trim_text(v_payload->>'jobId');",
      'from app.jobs j',
      'and j.id = v_job_id',
      'Job identity mismatch: jobId %s belongs to job %s, not %s.',
      'and a.job_id = v_selected_job.id',
      "v_entry.status := 'CANCELLED';",
      'perform app_api.save_allocation(v_entry);',
      'app_api.next_feet_available_after_allocation_release(',
      'and f.job_id = v_selected_job.id',
      'perform app_api.delete_film_order_links_by_film_order_id(p_org_id, v_order.film_order_id);',
      'perform app_api.delete_film_order(p_org_id, v_order.film_order_id);',
      'and id = v_selected_job.id',
      "lifecycle_status = 'CANCELLED'",
      'Released %s active film allocation%s across %s box%s and deleted %s film order%s.'
    ],
    excludes: [
      'app_api.cancel_active_caulk_allocations_for_job(',
      'JOB_ALLOCATION_CANCEL_RETURN',
      'caulk_job_allocations'
    ]
  },
  {
    signature: 'app_api.cancel_active_caulk_allocations_for_job_id(uuid, text, uuid, text, text, boolean)',
    includes: [
      'from app.jobs j',
      'and j.id = p_job_id',
      "perform app_api.raise_http(400, 'jobId does not match jobNumber.');",
      'and a.job_id = v_job.id',
      'app_api.caulk_cancel_pending_transfer_internal(',
      "'JOB_ALLOCATION_CANCEL_RETURN'",
      "'jobId', v_job.id::text",
      "'jobNumber', v_job_number"
    ],
    excludes: [
      'upper(a.job_number) = upper(v_job_number)',
      'upper(c.job_number) = upper(v_job_number)'
    ]
  },
  {
    signature: 'public.api_acl_jobs_cancel_caulk_allocations(uuid, text, jsonb)',
    includes: [
      "v_job_id_text text := app_api.trim_text(v_payload->>'jobId');",
      "if v_job_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then",
      'app_api.cancel_active_caulk_allocations_for_job_id(',
      'app_api.cancel_active_caulk_allocations_for_job('
    ],
    excludes: []
  },
  {
    signature: 'app_api.compute_allocation_planning_feet(text, integer, integer, integer)',
    includes: [
      "when 'TRANSFER' then greatest(coalesce(p_feet_available, 0), 0)",
      "when 'ORDERED' then greatest(coalesce(p_initial_feet, 0) - coalesce(p_active_allocated_feet, 0), 0)"
    ],
    excludes: []
  },
  {
    signature: 'app_api.normalize_requirement_film_family_name(uuid, text, text)',
    includes: [
      'app_api.normalize_requirement_match_surface_film_name(',
      "regexp_replace(v_film_name, '[[:space:]]+Exterior[[:space:]]*$', '', 'i')"
    ],
    excludes: []
  },
  {
    signature: 'app_api.normalize_requirement_match_surface_film_name(uuid, text, text)',
    includes: [
      'app_api.strip_requirement_match_trailing_code_alias(v_film_name);'
    ],
    excludes: []
  },
  {
    signature: 'app_api.strip_requirement_match_trailing_code_alias(text)',
    includes: [
      "regexp_match(v_current, '^(.*?)(?:\\s*\\(([^()]*)\\))$')",
      'position(v_base_digits in v_alias_compact) = 0'
    ],
    excludes: []
  },
  {
    signature: 'app_api.requirement_film_is_exterior(uuid, text, text)',
    includes: [
      'app_api.normalize_requirement_match_surface_film_name(',
      "'(^|[[:space:]])Exterior[[:space:]]*$'"
    ],
    excludes: []
  },
  {
    signature: 'app_api.requirement_film_is_compatible(uuid, text, text, text, text)',
    includes: [
      'candidate.manufacturer_key = requirement.manufacturer_key',
      'not requirement.is_exterior',
      'or candidate.is_exterior'
    ],
    excludes: []
  },
  {
    signature: 'app_api.append_roll_history(uuid, text, text, text, text, numeric, text, text, text, numeric, timestamp with time zone, text, numeric, numeric, integer, integer, text)',
    includes: [
      'insert into app.roll_weight_log (',
      'created_at\n  )',
      "upper(app_api.require_text(p_warehouse, 'Warehouse'))",
      "app_api.require_text(p_box_id, 'BoxID')",
      "coalesce(nullif(app_api.trim_text(p_job_number), ''), 'UNKNOWN')",
      'return v_log_id;'
    ],
    excludes: [
      'app_api.append_roll_history_entry(',
      '::app.roll_weight_log',
      '::app.warehouse'
    ]
  },
  {
    signature: 'app_api.append_roll_history(uuid, text, text, text, text, numeric, text, text, text, numeric, timestamp without time zone, text, numeric, numeric, integer, integer, text)',
    includes: [
      'insert into app.roll_weight_log (',
      'created_at\n  )',
      "upper(app_api.require_text(p_warehouse, 'Warehouse'))",
      "app_api.require_text(p_box_id, 'BoxID')",
      "coalesce(nullif(app_api.trim_text(p_job_number), ''), 'UNKNOWN')",
      'coalesce(p_checked_in_at::timestamptz, now())',
      'return v_log_id;'
    ],
    excludes: [
      'app_api.append_roll_history_entry(',
      '::app.roll_weight_log',
      '::app.warehouse'
    ]
  },
  {
    signature: 'app_api.cancel_active_allocations_for_box_job(uuid, text, text, text, text)',
    includes: [
      'return app_api.cancel_active_allocations_for_box_job_checkin(',
      'p_actor,',
      'p_box_id,',
      'p_job_number,'
    ],
    excludes: []
  },
  {
    signature: 'app_api.cancel_active_allocations_for_box_job(uuid, text, text, text, text, uuid)',
    includes: [
      'p_job_id uuid',
      'p_job_id is not null and a.job_id = p_job_id',
      'p_job_id is null',
      "upper(coalesce(a.job_number, '')) = upper(app_api.trim_text(p_job_number))",
      'perform app_api.recalculate_film_order(p_org_id, v_film_order_id, p_actor);'
    ],
    excludes: []
  },
  {
    signature: 'public.api_acl_jobs_update(uuid, text, jsonb)',
    includes: [
      "v_job_id_text text := app_api.trim_text(p_payload->>'jobId');",
      'perform app_api.sync_active_job_schedule_allocations_by_job_id(',
      'perform app_api.sync_active_job_schedule_allocations(',
      'perform app_api.reconcile_auto_planned_allocations(',
      "'jobIds', jsonb_build_array(v_updated_job.id)",
      "'jobNumbers', jsonb_build_array(v_updated_job.job_number)"
    ],
    excludes: ['perform app_api.reconcile_auto_shortage_film_orders_for_job(']
  },
  {
    signature: 'app_api.sync_active_job_schedule_allocations_by_job_id(uuid, uuid, date, text)',
    includes: [
      'a.job_id = p_job_id',
      'f.job_id = p_job_id',
      'perform app_api.recalculate_physical_box_allocatable_now('
    ],
    excludes: [
      'upper(trim(a.job_number)) = upper(trim(app_api.trim_text(p_job_number)))',
      'upper(trim(f.job_number)) = upper(trim(app_api.trim_text(p_job_number)))'
    ]
  },
  {
    signature: 'app_api.requirement_rows_from_payload_with_ids(jsonb)',
    includes: [
      "v_requirement_id := nullif(app_api.trim_text(v_value->>'requirementId'), '')::uuid;",
      "nullif(app_api.trim_text(value->>'requirementId'), '')::uuid as requirement_id",
      '(array_agg(n.requirement_id order by n.ordinality) filter (where n.requirement_id is not null))[1] as requirement_id'
    ],
    excludes: []
  },
  {
    signature: 'app_api.replace_job_requirements(uuid, app.jobs, jsonb, text, timestamp with time zone)',
    includes: [
      'from app_api.requirement_rows_from_payload_with_ids(p_requirements)',
      'and r.id = v_requirement.requirement_id',
      'and not (r.id = any(v_retained_ids))',
      'v_next_id := coalesce(v_existing.id, gen_random_uuid());',
      'and not (id = any(v_retained_ids));'
    ],
    excludes: [
      'DELETE FROM app.job_requirements\n  WHERE org_id = p_org_id\n    AND job_id = p_job.id;\n  FOR v_requirement IN'
    ]
  },
  {
    signature: 'public.api_acl_boxes_update(uuid, text, jsonb)',
    includes: [
      'perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);',
      'perform app_api.reconcile_auto_planned_allocations('
    ],
    excludes: ['perform app_api.reconcile_auto_shortage_film_orders_for_box(']
  },
  {
    signature: 'public.api_acl_boxes_set_status(uuid, text, jsonb)',
    includes: [
      'perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_lookup_box_id);',
      'perform app_api.reconcile_auto_planned_allocations(',
      "'boxIds', jsonb_build_array(v_lookup_box_id)",
      "'jobIds', jsonb_build_array(v_result->>'jobId')",
      "'jobNumbers', jsonb_build_array(v_result->>'jobNumber')"
    ],
    excludes: ['perform app_api.reconcile_auto_shortage_film_orders_for_box(']
  },
  {
    signature: 'public.api_boxes_set_status(uuid, text, jsonb)',
    includes: [
      "perform app_api.assert_direct_to_job_site_flag_is_server_owned(p_payload, 'Set Box Status');",
      "perform app_api.assert_no_ship_direct_to_job_site_flag(p_payload, 'Set Box Status');",
      "if v_status not in ('IN_STOCK', 'CHECKED_OUT') then",
      "perform app_api.raise_http(400, 'Status must be IN_STOCK or CHECKED_OUT.');",
      "v_payload_job_id_text text := app_api.trim_text(p_payload->>'jobId');",
      "if v_payload_job_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then",
      "perform app_api.raise_http(400, 'jobId must be a valid UUID.');",
      'and j.id = v_checkout_job_id',
      "perform app_api.raise_http(400, 'jobId does not match jobNumber.');",
      'v_legacy_checkout_job_match_count integer := 0;',
      "perform app_api.raise_http(\n          409,\n          format('Job number %s matches multiple jobs. Choose a Work Scope to continue.', v_checkout_job)\n        );",
      'v_box.last_checkout_job_id := v_checkout_job_id;',
      'perform app_api.assert_can_checkout_box_from_warehouse(v_existing);',
      'v_checkout_job_id := v_selected_job.id;',
      'v_checkout_job := v_selected_job.job_number;',
      'v_checkout_job_id is not null and a.job_id = v_checkout_job_id',
      'v_checkout_job_id is null',
      'v_reconciliation_result jsonb',
      'v_requirement_usage_result jsonb',
      'app_api.record_requirement_actual_usage_for_checkin',
      'v_reconciliation_result := app_api.reconcile_box_checkin_allocations',
      'v_box.last_checkout_job_id := null;',
      'v_checkout_job_id,',
      'perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);',
      "'jobId', v_checkout_job_id::text",
    ],
    excludes: [
      "Received physical LF cannot be lower than the box''s active allocated feet",
      "Released %s active planning allocation%s totaling %s LF for job %s during check-in."
    ]
  },
  {
    signature: 'app_api.reconcile_box_checkin_allocations(uuid, text, text, integer)',
    includes: [
      'for update;',
      'case when a.job_date is not null then 0 else 1 end',
      'a.job_date asc nulls last',
      'coalesce(j.created_at, a.created_at) asc',
      "coalesce(j.id::text, a.job_id::text, '') asc",
      'app_api.compute_covered_feet_from_allocation(',
      "set status = 'CANCELLED'",
      'app_api.reconcile_existing_film_order_need_for_requirement(',
      "'updatedFilmOrderIds'",
      "'warnings'"
    ],
    excludes: ['order by a.created_at asc, a.allocation_id asc', 'due_date', 'install date']
  },
  {
    signature: 'app_api.build_box_from_payload(uuid, jsonb, text)',
    includes: [
      'v_use_partial_receiving_metrics boolean := false;',
      'if not v_has_full_receiving_metrics and p_existing_box_id is not null then',
      'v_use_partial_receiving_metrics := true;',
      'v_active_allocated_feet := app_api.physical_film_commitment_feet_for_box(',
      'coalesce(v_existing.feet_available, v_feet_available)',
      'v_feet_available := greatest(v_initial_feet - v_active_allocated_feet, 0);'
    ],
    excludes: [
      'if v_initial_weight_input is null and v_existing.initial_weight_lbs is null then',
      'v_feet_available := app_api.clamp_feet_to_initial_range(v_feet_available, v_initial_feet);',
      "select coalesce(sum(a.allocated_feet), 0)::integer\n    into v_active_allocated_feet\n    from app.allocations a\n    where a.org_id = p_org_id\n      and a.box_id = v_box_id\n      and a.status = 'ACTIVE';"
    ]
  },
  {
    signature: 'public.api_boxes_add(uuid, text, jsonb)',
    includes: [
      "v_box := jsonb_populate_record(null::app.boxes, v_receipt_result->'box');",
      'perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);'
    ],
    excludes: []
  },
  {
    signature: 'app_api.reconcile_auto_shortage_film_orders_for_job(uuid, text, text, boolean)',
    includes: [
      'return jsonb_build_object(',
      "'createdCount', 0",
      "'updatedCount', 0",
      "'deletedCount', 0"
    ],
    excludes: [
      'perform app_api.save_film_order(',
      'delete from app.film_orders',
      'v_target_orphan_requested_feet'
    ]
  },
  {
    signature: 'app_api.reconcile_auto_shortage_film_orders_for_box(uuid, text, text, boolean)',
    includes: [
      'return jsonb_build_object(',
      "'createdCount', 0",
      "'updatedCount', 0",
      "'deletedCount', 0"
    ],
    excludes: [
      'perform app_api.save_film_order(',
      'delete from app.film_orders',
      'v_target_orphan_requested_feet'
    ]
  },
  {
    signature: 'app_api.save_allocation(app.allocations)',
    includes: [
      'allocation_source',
      "coalesce(p_allocation.allocation_source, 'MANUAL'::app.allocation_source)",
      'perform app_api.assert_film_box_allocation_capacity(v_row.org_id, v_row.box_id, v_row.allocation_id);'
    ],
    excludes: []
  },
  {
    signature: 'app_api.auto_planner_scope_job_numbers(uuid, jsonb)',
    includes: [
      'auto_planner_scope_jobs',
      'auto_planner_scope_boxes',
      'auto_planner_scope_caulk_pairs',
      'app_api.requirement_film_is_compatible(',
      "sb.status = 'IN_STOCK'",
      'j.lifecycle_status = \'ACTIVE\''
    ],
    excludes: [
      'auto_planner_scope_warehouses',
      'upper(j.warehouse::text) in (select warehouse from auto_planner_scope_warehouses)'
    ]
  },
  {
    signature: 'app_api.auto_planner_scope_job_ids(uuid, jsonb)',
    includes: [
      "coalesce(p_scope, '{}'::jsonb)->'jobIds'",
      'btrim(value)::uuid',
      'group by btrim(value)::uuid',
      'j.org_id = p_org_id',
      'j.id = r.job_id',
      'order by\n    r.first_position'
    ],
    excludes: [
      'upper(trim(j.job_number))',
      'auto_planner_scope_job_numbers('
    ]
  },
  {
    signature: 'app_api.auto_planner_scope_jobs(uuid, jsonb)',
    includes: [
      "v_scope->'jobIds'",
      "v_scope->'jobNumbers'",
      "v_scope->'boxIds'",
      "v_scope->'caulkProductWarehousePairs'",
      'auto_planner_scope_job_id_candidates',
      'auto_planner_scope_job_number_candidates',
      'auto_planner_scope_box_candidates',
      'auto_planner_scope_caulk_pair_candidates',
      'v_has_valid_job_ids',
      'j.id = s.candidate_job_id',
      'upper(btrim(j.job_number)) = s.job_number_key',
      'a.job_id is not null and j.id = a.job_id',
      'a.job_id is null',
      'app_api.requirement_film_is_compatible(',
      'r.product_id = sc.product_id'
    ],
    excludes: [
      'auto_planner_scope_job_numbers('
    ]
  },
  {
    signature: 'app_api.reconcile_auto_planned_allocations(uuid, text, jsonb)',
    includes: [
      'perform pg_advisory_xact_lock',
      'create temporary table if not exists auto_planner_explicit_job_id_scope',
      'create temporary table if not exists auto_planner_explicit_job_scope',
      'create temporary table if not exists auto_planner_explicit_box_scope',
      'create temporary table if not exists auto_planner_explicit_caulk_scope',
      'create temporary table if not exists auto_planner_warnings',
      'create temporary table if not exists auto_planner_suppressed_film',
      'create temporary table if not exists auto_planner_suppressed_caulk',
      'app.allocation_planner_suppressions',
      'if v_is_suppressed then',
      'from auto_planner_suppressed_caulk s',
      'truncate auto_planner_desired_caulk',
      'app_api.film_allocation_reserves_capacity(a, b.status::text)',
      "coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'",
      "upper(coalesce(b.status::text, '')) = 'IN_STOCK'",
      "coalesce(upper(b.status::text), '') <> 'CHECKED_OUT'",
      'app_api.plan_allocation_coverage(',
      "coalesce(r.status, 'ACTIVE') = 'ACTIVE'",
      "'AUTO_PLANNED allocation created by planner reconciliation.'",
      'on conflict (box_id) do nothing;',
      'perform 1\n  from app.boxes b\n  join auto_planner_boxes bx',
      'create temporary table if not exists auto_planner_fixed_box_commitments',
      'left join auto_planner_jobs scoped_job',
      "scoped_job.job_id is not null\n      and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'\n      and upper(coalesce(b.status::text, '')) = 'IN_STOCK'",
      'join app_api.auto_planner_scope_jobs(p_org_id, coalesce(p_scope, \'{}\'::jsonb)) s\n    on s.job_id = j.id',
      'not exists (select 1 from auto_planner_explicit_job_id_scope)',
      'fixed_reserved_feet > bx.capacity',
      'AUTO planner capacity invariant failed',
      'select j.*\n    from auto_planner_jobs j',
      'select min(a.created_at)',
      'select min(a.allocation_id)',
      'where auto_planner_desired_film.job_id = excluded.job_id\n          and auto_planner_desired_film.requirement_id = excluded.requirement_id\n          and auto_planner_desired_film.box_id = excluded.box_id;',
      'where auto_planner_desired_caulk.job_id = excluded.job_id\n        and auto_planner_desired_caulk.requirement_id = excluded.requirement_id\n        and auto_planner_desired_caulk.product_id = excluded.product_id\n        and auto_planner_desired_caulk.warehouse = excluded.warehouse;'
    ],
    excludes: [
      'perform app_api.save_film_order(',
      'delete from app.film_orders',
      'upper(coalesce(b.warehouse::text, \'\')) in (select warehouse from auto_planner_jobs)\n      or exists',
      "upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'\n          and not bx.skipped",
      'set remaining = bx.capacity - coalesce((\n    select sum(a.allocated_feet)::integer\n    from app.allocations a\n    where a.org_id = p_org_id\n      and a.box_id = bx.box_id\n      and app_api.film_allocation_reserves_capacity(a, bx.status)\n      and coalesce(a.allocation_source::text, \'MANUAL\') <> \'AUTO_PLANNED\'\n  ), 0)\n  where bx.box_id is not null;',
      'set remaining = bx.remaining - coalesce((\n    select sum(a.allocated_feet)::integer\n    from app.allocations a\n    join app.boxes b\n      on b.org_id = a.org_id\n     and b.box_id = a.box_id\n    where a.org_id = p_org_id\n      and a.box_id = bx.box_id\n      and app_api.film_allocation_reserves_capacity(a, b.status::text)\n      and coalesce(a.allocation_source::text, \'MANUAL\') = \'AUTO_PLANNED\'\n      and upper(coalesce(b.status::text, \'\')) = \'CHECKED_OUT\'\n  ), 0)\n  where bx.box_id is not null;',
      'set remaining = bx.capacity - coalesce((\n    select sum(a.allocated_feet)::integer\n    from app.allocations a\n    where a.org_id = p_org_id\n      and a.box_id = bx.box_id\n      and app_api.film_allocation_reserves_capacity(a, bx.status)\n      and coalesce(a.allocation_source::text, \'MANUAL\') <> \'AUTO_PLANNED\'\n  ), 0);',
      'set remaining = bx.remaining - coalesce((\n    select sum(a.allocated_feet)::integer\n    from app.allocations a\n    join app.boxes b\n      on b.org_id = a.org_id\n     and b.box_id = a.box_id\n    where a.org_id = p_org_id\n      and a.box_id = bx.box_id\n      and app_api.film_allocation_reserves_capacity(a, b.status::text)\n      and coalesce(a.allocation_source::text, \'MANUAL\') = \'AUTO_PLANNED\'\n      and upper(coalesce(b.status::text, \'\')) = \'CHECKED_OUT\'\n  ), 0);',
      'auto_planner_scope_job_numbers(',
      'select *\n    from auto_planner_jobs\n    order by\n      case when install_date is null then 1 else 0 end,\n      install_date nulls last,\n      created_at,\n      job_number,\n      job_id',
      'covered_feet = auto_planner_desired_film.covered_feet + excluded.covered_feet;',
      'allocated_tubes = auto_planner_desired_caulk.allocated_tubes + excluded.allocated_tubes;'
    ]
  },
  {
    signature: 'public.api_acl_clear_allocation_planner_suppression(uuid, text, jsonb)',
    includes: [
      "perform app_api.require_effective_feature_access(p_org_id, 'allocations', 'write')",
      "v_job_id_text text := app_api.trim_text(v_payload->>'jobId')",
      'where j.org_id = p_org_id\n      and j.id = v_job_id',
      'Job identity mismatch: selected job does not match jobNumber.',
      'from app.job_requirements r\n      where r.org_id = p_org_id\n        and r.job_id = v_job.id',
      'from app.job_caulk_requirements r\n      where r.org_id = p_org_id\n        and r.job_id = v_job.id',
      'app_api.clear_allocation_planner_suppression_for_requirement(',
      'app_api.clear_caulk_allocation_planner_suppression_for_requirement(',
      "v_material_type text := upper(coalesce",
      "'jobIds', jsonb_build_array(v_job.id)",
      "'caulkProductWarehousePairs'",
      'perform app_api.reconcile_auto_planned_allocations('
    ],
    excludes: [
      'auto_planner_scope_job_numbers('
    ]
  },
  {
    signature: 'public.api_acl_list_job_caulk_requirements_by_job(uuid, text)',
    includes: [
      'auto_planning_suppressed',
      'app.allocation_planner_suppressions',
      'app_api.caulk_requirement_planner_signature('
    ],
    excludes: []
  },
  {
    signature: 'public.api_acl_allocations_caulk_remove(uuid, text, jsonb)',
    includes: [
      'and a.caulk_allocation_id = v_caulk_allocation_id',
      'and j.id = v_allocation.job_id',
      'Job for caulk allocation %s was not found.',
      'Caulk allocation %s is not active.',
      'Caulk allocation %s has %s open checkout%s. Check in first.',
      'app_api.record_auto_planned_caulk_allocation_suppression(',
      'app_api.caulk_cancel_pending_transfer_internal(',
      'JOB_ALLOCATION_CANCEL_RETURN',
      'app_api.reconcile_auto_planned_allocations(',
      "'jobIds', jsonb_build_array(v_job.id)",
      "'jobNumbers', jsonb_build_array(v_job.job_number)",
      "'caulkProductWarehousePairs'",
      "'jobId', v_job.id::text",
      "'jobNumber', v_job.job_number"
    ],
    excludes: [
      'app_api.require_active_job_for_caulk(p_org_id, v_allocation.job_number)',
      'Job %s is closed and cannot receive caulk allocations.'
    ]
  },
  {
    signature: 'public.api_acl_caulk_transfer_receive(uuid, text, jsonb)',
    includes: [
      'app_api.caulk_receive_pending_transfer_internal(',
      'app_api.reconcile_auto_planned_allocations(',
      "'jobIds', jsonb_build_array(v_result->>'jobId')",
      "'jobNumbers', jsonb_build_array(v_result->>'jobNumber')",
      "'caulkProductWarehousePairs'",
      "'warehouse', v_result->>'sourceWarehouse'",
      "'warehouse', v_result->>'destinationWarehouse'",
      "return jsonb_set(v_result, '{warnings}', v_warnings, true)"
    ],
    excludes: []
  },
  {
    signature: 'public.api_acl_caulk_transfer_cancel(uuid, text, jsonb)',
    includes: [
      'app_api.caulk_cancel_pending_transfer_internal(',
      'app_api.reconcile_auto_planned_allocations(',
      "'jobIds', jsonb_build_array(v_result->>'jobId')",
      "'jobNumbers', jsonb_build_array(v_result->>'jobNumber')",
      "'caulkProductWarehousePairs'",
      "'warehouse', v_result->>'sourceWarehouse'",
      "'warehouse', v_result->>'destinationWarehouse'",
      "return jsonb_set(v_result, '{warnings}', v_warnings, true)"
    ],
    excludes: []
  },
  {
    signature: 'public.api_acl_allocations_caulk_update(uuid, text, jsonb)',
    includes: [
      'and a.caulk_allocation_id = v_caulk_allocation_id',
      'and j.id = v_allocation.job_id',
      'Job for caulk allocation %s was not found.',
      'Job %s is closed and cannot receive caulk allocations.',
      'Receive or cancel transfer %s before editing this allocation.',
      'Product and warehouse cannot be changed after checkout starts.',
      'allocatedTubes cannot drop below already checked-out amount.',
      'app_api.reconcile_auto_planned_allocations(',
      "'jobIds', jsonb_build_array(v_job.id)",
      "'jobNumbers', jsonb_build_array(v_job.job_number)",
      "'caulkProductWarehousePairs'",
      'v_allocation.product_id',
      'v_allocation.warehouse',
      'v_next_product_id',
      'v_next_warehouse',
      "'jobId', v_job.id::text"
    ],
    excludes: ['app_api.require_active_job_for_caulk(p_org_id, v_allocation.job_number)']
  },
  {
    signature: 'public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)',
    includes: [
      'and j.id = v_allocation.job_id',
      'Job for caulk allocation %s was not found.',
      'Job %s is closed and cannot receive caulk allocations.',
      'v_job.job_number',
      'app_api.reconcile_auto_planned_allocations(',
      "'jobIds', jsonb_build_array(v_job.id)",
      "'jobNumbers', jsonb_build_array(v_job.job_number)",
      "'caulkProductWarehousePairs'",
      "'jobId', v_job.id::text",
      "'productId', v_allocation.product_id::text",
      "'warehouse', v_allocation.warehouse"
    ],
    excludes: ['app_api.require_active_job_for_caulk(p_org_id, v_allocation.job_number)']
  },
  {
    signature: 'public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)',
    includes: [
      'and a.id = v_checkout.caulk_allocation_id',
      'and j.id = v_allocation.job_id',
      'Job for caulk checkout %s was not found.',
      'format(\'Checked in unused caulk from job %s.\', v_job.job_number)',
      'app_api.reconcile_auto_planned_allocations(',
      "'jobIds', jsonb_build_array(v_job.id)",
      "'jobNumbers', jsonb_build_array(v_job.job_number)",
      "'caulkProductWarehousePairs'",
      "'jobId', v_job.id::text",
      "'productId', v_allocation.product_id::text",
      "'warehouse', v_allocation.warehouse"
    ],
    excludes: [
      'app_api.require_active_job_for_caulk(p_org_id, v_allocation.job_number)',
      'Job %s is closed and cannot receive caulk allocations.'
    ]
  },
  {
    signature: 'public.api_list_job_requirements_by_job(uuid, text)',
    includes: [
      'auto_planning_suppressed',
      'app.allocation_planner_suppressions',
      'app_api.film_requirement_planner_signature('
    ],
    excludes: []
  },
  {
    signature: 'app_api.save_box(app.boxes)',
    includes: [
      'perform app_api.upsert_box_dealer(p_box.org_id, p_box.dealer);',
      'dealer = excluded.dealer',
      'coalesce(p_box.has_label, true)',
      'has_label = excluded.has_label'
    ],
    excludes: []
  },
  {
    signature: 'app_api.public_box_json(app.boxes)',
    includes: ["'dealer', coalesce(p_box.dealer, '')", "'hasLabel', coalesce(p_box.has_label, true)"],
    excludes: []
  },
  {
    signature: 'app_api.public_box_state_to_box_row(uuid, jsonb, uuid)',
    includes: [
      "v_box.dealer := coalesce(p_state->>'dealer', '');",
      "v_box.has_label := coalesce((p_state->>'hasLabel')::boolean, true);"
    ],
    excludes: []
  },
  {
    signature: 'public.api_boxes_add(uuid, text, jsonb)',
    includes: ["v_box.dealer := app_api.trim_text(p_payload->>'dealer');"],
    excludes: []
  },
  {
    signature: 'public.api_boxes_update(uuid, text, jsonb)',
    includes: [
      'v_box.dealer := case',
      "then app_api.trim_text(p_payload->>'dealer')",
      "else coalesce(v_existing.dealer, '')",
      "if v_box.status <> 'CHECKED_OUT' then",
      'perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);'
    ],
    excludes: []
  }
];

const AUTHENTICATED_PUBLIC_RPC_ALLOWLIST = [
  'api_get_auth_context',
  'api_list_access_requests',
  'api_approve_access_request',
  'api_deny_access_request',
  'api_request_username_change',
  'api_list_username_change_requests',
  'api_approve_username_change_request',
  'api_deny_username_change_request',
  'api_get_member_feature_permissions',
  'api_update_member_feature_permissions',
  'api_get_user_feature_permissions',
  'api_update_user_feature_permissions',
  'api_get_admin_feature_permissions',
  'api_update_admin_feature_permissions',
  'api_promote_member_to_admin',
  'api_demote_admin_to_member',
  'api_promote_admin_to_owner',
];

const REQUIRED_AUTHENTICATED_PUBLIC_RPC_SIGNATURES = [
  'public.api_get_auth_context(uuid)',
  'public.api_list_access_requests(uuid, text)',
  'public.api_approve_access_request(uuid, text, jsonb)',
  'public.api_deny_access_request(uuid, text, jsonb)',
  'public.api_request_username_change(uuid, text, jsonb)',
  'public.api_list_username_change_requests(uuid, text)',
  'public.api_approve_username_change_request(uuid, text, jsonb)',
  'public.api_deny_username_change_request(uuid, text, jsonb)',
  'public.api_get_member_feature_permissions(uuid)',
  'public.api_update_member_feature_permissions(uuid, text, jsonb)',
  'public.api_get_user_feature_permissions(uuid, uuid)',
  'public.api_update_user_feature_permissions(uuid, text, jsonb)',
  'public.api_get_admin_feature_permissions(uuid)',
  'public.api_update_admin_feature_permissions(uuid, text, jsonb)',
  'public.api_promote_member_to_admin(uuid, text, jsonb)',
  'public.api_demote_admin_to_member(uuid, text, jsonb)',
  'public.api_promote_admin_to_owner(uuid, text, jsonb)',
];

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runSchemaCheck() {
  if (SKIP_SCHEMA_CHECK) {
    console.log('[schema-check] Skipped because SCHEMA_CHECK_SKIP=true');
    return;
  }

  if (!DATABASE_URL) {
    throw new Error('[schema-check] DATABASE_URL (or SUPABASE_DB_URL) is required.');
  }

  const valuesSql = REQUIRED_OBJECTS.map(
    ({ kind, signature }) => `(${sqlLiteral(kind)}::text, ${sqlLiteral(signature)}::text)`
  ).join(',\n            ');

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const { rows } = await client.query(
      `
        with checks(kind, signature) as (
          values
            ${valuesSql}
        )
        select
          kind,
          signature,
          case
            when kind = 'table' then to_regclass(signature) is not null
            when kind = 'index' then to_regclass(signature) is not null
            when kind = 'type' then to_regtype(signature) is not null
            when kind = 'function' then to_regprocedure(signature) is not null
            when kind = 'column' then exists (
              select 1
              from information_schema.columns c
              where c.table_schema = split_part(signature, '.', 1)
                and c.table_name = split_part(signature, '.', 2)
                and c.column_name = split_part(signature, '.', 3)
            )
            else false
          end as exists
        from checks
        order by kind, signature;
      `
    );

    const missing = rows.filter((row) => !row.exists);
    if (missing.length > 0) {
      const details = missing.map((row) => `- ${row.kind}: ${row.signature}`).join('\n');
      throw new Error(
        '[schema-check] Missing required schema objects for the current release.\n' +
          `Apply all checked-in backend migrations in numeric order through ${LATEST_MIGRATION}, then retry.\n` +
          `${details}`
      );
    }

    const workScopeKeyRows = await client.query(
      `
        select
          a.attgenerated = 's' as is_generated_stored,
          coalesce(pg_get_expr(d.adbin, d.adrelid), '') as generation_expression
        from pg_attribute a
        join pg_class c
          on c.oid = a.attrelid
        join pg_namespace n
          on n.oid = c.relnamespace
        left join pg_attrdef d
          on d.adrelid = a.attrelid
          and d.adnum = a.attnum
        where n.nspname = 'app'
          and c.relname = 'jobs'
          and a.attname = 'work_scope_key'
          and not a.attisdropped;
      `
    );

    const workScopeKeyState = workScopeKeyRows.rows[0] || {};
    const workScopeKeyIssues = [];
    if (workScopeKeyState.is_generated_stored !== true) {
      workScopeKeyIssues.push('- generated column mismatch: app.jobs.work_scope_key is not a stored generated column');
    }
    if (!String(workScopeKeyState.generation_expression || '').includes('app_api.normalize_job_work_scope_key(sections)')) {
      workScopeKeyIssues.push(
        '- generated column mismatch: app.jobs.work_scope_key does not derive from app_api.normalize_job_work_scope_key(sections)'
      );
    }

    const workScopeKeyConstraintRows = await client.query(
      `
        select
          c.conname,
          pg_get_constraintdef(c.oid) as definition,
          (
            select array_to_string(array_agg(a.attname::text order by cols.ordinality), ',')
            from unnest(c.conkey) with ordinality as cols(attnum, ordinality)
            join pg_attribute a
              on a.attrelid = c.conrelid
             and a.attnum = cols.attnum
          ) as columns
        from pg_constraint c
        where c.conrelid = 'app.jobs'::regclass
          and c.contype = 'u';
      `
    );

    const uniqueColumnSets = workScopeKeyConstraintRows.rows.map((row) => ({
      columns: String(row.columns || '')
    }));
    const hasTripletUnique = uniqueColumnSets.some((row) => row.columns === 'org_id,job_number,work_scope_key');
    const hasLegacyJobNumberUnique = uniqueColumnSets.some((row) => row.columns === 'org_id,job_number');
    if (!hasTripletUnique) {
      workScopeKeyIssues.push(
        '- uniqueness mismatch: app.jobs must have unique(org_id, job_number, work_scope_key)'
      );
    }
    if (hasLegacyJobNumberUnique) {
      workScopeKeyIssues.push(
        '- uniqueness mismatch: app.jobs must not retain unique(org_id, job_number) after duplicate enablement'
      );
    }

    const workScopeKeySupportIndexRows = await client.query(
      `select to_regclass('app.idx_jobs_org_job_number_work_scope_key') is not null as exists;`
    );
    if (workScopeKeySupportIndexRows.rows[0]?.exists === true) {
      workScopeKeyIssues.push(
        '- index mismatch: app.idx_jobs_org_job_number_work_scope_key must be dropped after duplicate enablement'
      );
    }

    if (workScopeKeyIssues.length > 0) {
      throw new Error(
        '[schema-check] Work Scope key groundwork is out of date for the current release.\n' +
          `Apply all checked-in backend migrations in numeric order through ${LATEST_MIGRATION}, then retry.\n` +
          workScopeKeyIssues.join('\n')
      );
    }

    const semanticRows = await client.query(
      `
        select
          signature,
          pg_get_functiondef(to_regprocedure(signature)) as definition
        from unnest($1::text[]) as required(signature)
      `,
      [REQUIRED_FUNCTION_SEMANTICS.map((entry) => entry.signature)]
    );

    const functionDefinitions = new Map(
      semanticRows.rows.map((row) => [
        row.signature,
        normalizeFunctionDefinitionForSemanticCheck(row.definition)
      ])
    );

    const semanticIssues = [];
    for (const requirement of REQUIRED_FUNCTION_SEMANTICS) {
      const definition = functionDefinitions.get(requirement.signature) || '';
      for (const expectedSnippet of requirement.includes) {
        if (!definition.includes(expectedSnippet)) {
          semanticIssues.push(
            `- function semantic mismatch: ${requirement.signature} is missing snippet ${JSON.stringify(expectedSnippet)}`
          );
        }
      }
      for (const forbiddenSnippet of requirement.excludes) {
        if (definition.includes(forbiddenSnippet)) {
          semanticIssues.push(
            `- function semantic mismatch: ${requirement.signature} still contains forbidden snippet ${JSON.stringify(forbiddenSnippet)}`
          );
        }
      }
    }

    if (semanticIssues.length > 0) {
      throw new Error(
        '[schema-check] Required function bodies are out of date for the current release.\n' +
          `Apply all checked-in backend migrations in numeric order through ${LATEST_MIGRATION}, then retry.\n` +
          semanticIssues.join('\n')
      );
    }

    const publicRpcAllowlistSql = AUTHENTICATED_PUBLIC_RPC_ALLOWLIST.map((entry) => sqlLiteral(entry)).join(', ');
    const requiredAuthenticatedPublicRpcSql = REQUIRED_AUTHENTICATED_PUBLIC_RPC_SIGNATURES.map(
      (signature) => `(${sqlLiteral(signature)}::text)`
    ).join(',\n            ');
    const permissionRows = await client.query(
      `
        with public_api_functions as (
          select
            p.oid,
            p.oid::regprocedure::text as signature,
            p.proname
          from pg_proc p
          join pg_namespace n
            on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname like 'api\\_%' escape '\\'
        ),
        disallowed_authenticated_public_api as (
          select signature
          from public_api_functions
          where proname not like 'api\\_acl\\_%' escape '\\'
            and proname not in (${publicRpcAllowlistSql})
            and has_function_privilege('authenticated', oid, 'EXECUTE')
        ),
        required_authenticated_public_rpcs(signature) as (
          values
            ${requiredAuthenticatedPublicRpcSql}
        ),
        missing_authenticated_required_public_api as (
          select r.signature
          from required_authenticated_public_rpcs r
          left join pg_proc p
            on p.oid = to_regprocedure(r.signature)
          where p.oid is null
            or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
        ),
        anon_executable_required_public_api as (
          select r.signature
          from required_authenticated_public_rpcs r
          join pg_proc p
            on p.oid = to_regprocedure(r.signature)
          where has_function_privilege('anon', p.oid, 'EXECUTE')
        ),
        service_role_executable_required_public_api as (
          select r.signature
          from required_authenticated_public_rpcs r
          join pg_proc p
            on p.oid = to_regprocedure(r.signature)
          where has_function_privilege('service_role', p.oid, 'EXECUTE')
        )
        select
          has_schema_privilege('authenticated', 'public', 'USAGE') as authenticated_public_schema_usage,
          has_function_privilege(
            'authenticated',
            'public.api_get_auth_context(uuid)'::regprocedure,
            'EXECUTE'
          ) as authenticated_auth_context_execute,
          has_function_privilege(
            'authenticated',
            'public.api_list_access_requests(uuid, text)'::regprocedure,
            'EXECUTE'
          ) as authenticated_access_requests_execute,
          has_function_privilege(
            'authenticated',
            'public.api_acl_list_boxes(uuid)'::regprocedure,
            'EXECUTE'
          ) as authenticated_acl_list_boxes_execute,
          case
            when to_regprocedure('public.api_list_boxes(uuid)') is null then false
            else has_function_privilege(
              'authenticated',
              'public.api_list_boxes(uuid)'::regprocedure,
              'EXECUTE'
            )
          end as authenticated_legacy_list_boxes_execute,
          coalesce((select count(*) from disallowed_authenticated_public_api), 0)::integer
            as disallowed_authenticated_public_api_count,
          coalesce(
            (select string_agg(signature, ', ' order by signature) from disallowed_authenticated_public_api),
            ''
          ) as disallowed_authenticated_public_api_signatures,
          coalesce(
            (select string_agg(signature, ', ' order by signature) from missing_authenticated_required_public_api),
            ''
          ) as missing_authenticated_required_public_api_signatures,
          coalesce(
            (select string_agg(signature, ', ' order by signature) from anon_executable_required_public_api),
            ''
          ) as anon_executable_required_public_api_signatures,
          coalesce(
            (select string_agg(signature, ', ' order by signature) from service_role_executable_required_public_api),
            ''
          ) as service_role_executable_required_public_api_signatures,
          case
            when to_regprocedure('public.api_find_job_by_id(uuid, uuid)') is null then false
            else has_function_privilege(
              'public',
              'public.api_find_job_by_id(uuid, uuid)'::regprocedure,
              'EXECUTE'
            )
          end as public_find_job_by_id_execute,
          case
            when to_regprocedure('public.api_find_job_by_id(uuid, uuid)') is null then false
            else has_function_privilege(
              'anon',
              'public.api_find_job_by_id(uuid, uuid)'::regprocedure,
              'EXECUTE'
            )
          end as anon_find_job_by_id_execute,
          case
            when to_regprocedure('public.api_find_job_by_id(uuid, uuid)') is null then false
            else has_function_privilege(
              'authenticated',
              'public.api_find_job_by_id(uuid, uuid)'::regprocedure,
              'EXECUTE'
            )
          end as authenticated_find_job_by_id_execute,
          case
            when to_regprocedure('public.api_find_job_by_id(uuid, uuid)') is null then false
            else has_function_privilege(
              'service_role',
              'public.api_find_job_by_id(uuid, uuid)'::regprocedure,
              'EXECUTE'
            )
          end as service_role_find_job_by_id_execute,
          case
            when to_regprocedure('public.api_acl_find_job_by_id(uuid, uuid)') is null then false
            else has_function_privilege(
              'public',
              'public.api_acl_find_job_by_id(uuid, uuid)'::regprocedure,
              'EXECUTE'
            )
          end as public_acl_find_job_by_id_execute,
          case
            when to_regprocedure('public.api_acl_find_job_by_id(uuid, uuid)') is null then false
            else has_function_privilege(
              'anon',
              'public.api_acl_find_job_by_id(uuid, uuid)'::regprocedure,
              'EXECUTE'
            )
          end as anon_acl_find_job_by_id_execute,
          case
            when to_regprocedure('public.api_acl_find_job_by_id(uuid, uuid)') is null then false
            else has_function_privilege(
              'authenticated',
              'public.api_acl_find_job_by_id(uuid, uuid)'::regprocedure,
              'EXECUTE'
            )
          end as authenticated_acl_find_job_by_id_execute,
          case
            when to_regprocedure('public.api_acl_find_job_by_id(uuid, uuid)') is null then false
            else has_function_privilege(
              'service_role',
              'public.api_acl_find_job_by_id(uuid, uuid)'::regprocedure,
              'EXECUTE'
            )
          end as service_role_acl_find_job_by_id_execute;
      `
    );

    const permissionState = permissionRows.rows[0] || {};
    const permissionIssues = [];
    if (permissionState.authenticated_public_schema_usage !== true) {
      permissionIssues.push('- privilege mismatch: authenticated lacks USAGE on schema public');
    }
    if (permissionState.authenticated_auth_context_execute !== true) {
      permissionIssues.push('- privilege mismatch: authenticated cannot execute public.api_get_auth_context(uuid)');
    }
    if (permissionState.authenticated_access_requests_execute !== true) {
      permissionIssues.push(
        '- privilege mismatch: authenticated cannot execute public.api_list_access_requests(uuid, text)'
      );
    }
    if (permissionState.authenticated_acl_list_boxes_execute !== true) {
      permissionIssues.push('- privilege mismatch: authenticated cannot execute public.api_acl_list_boxes(uuid)');
    }
    if (permissionState.authenticated_legacy_list_boxes_execute === true) {
      permissionIssues.push('- privilege mismatch: authenticated can still execute public.api_list_boxes(uuid)');
    }
    if (Number(permissionState.disallowed_authenticated_public_api_count || 0) > 0) {
      permissionIssues.push(
        '- privilege mismatch: authenticated can execute disallowed public api_* RPCs: ' +
          permissionState.disallowed_authenticated_public_api_signatures
      );
    }
    if (String(permissionState.missing_authenticated_required_public_api_signatures || '').length > 0) {
      permissionIssues.push(
        '- privilege mismatch: authenticated cannot execute required public api_* RPCs: ' +
          permissionState.missing_authenticated_required_public_api_signatures
      );
    }
    if (String(permissionState.anon_executable_required_public_api_signatures || '').length > 0) {
      permissionIssues.push(
        '- privilege mismatch: anon can execute authenticated-only public api_* RPCs: ' +
          permissionState.anon_executable_required_public_api_signatures
      );
    }
    if (String(permissionState.service_role_executable_required_public_api_signatures || '').length > 0) {
      permissionIssues.push(
        '- privilege mismatch: service_role can execute user-session public api_* RPCs: ' +
          permissionState.service_role_executable_required_public_api_signatures
      );
    }
    if (permissionState.public_find_job_by_id_execute === true) {
      permissionIssues.push('- privilege mismatch: public can execute public.api_find_job_by_id(uuid, uuid)');
    }
    if (permissionState.anon_find_job_by_id_execute === true) {
      permissionIssues.push('- privilege mismatch: anon can execute public.api_find_job_by_id(uuid, uuid)');
    }
    if (permissionState.authenticated_find_job_by_id_execute === true) {
      permissionIssues.push('- privilege mismatch: authenticated can execute public.api_find_job_by_id(uuid, uuid)');
    }
    if (permissionState.service_role_find_job_by_id_execute === true) {
      permissionIssues.push('- privilege mismatch: service_role can execute public.api_find_job_by_id(uuid, uuid)');
    }
    if (permissionState.public_acl_find_job_by_id_execute === true) {
      permissionIssues.push('- privilege mismatch: public can execute public.api_acl_find_job_by_id(uuid, uuid)');
    }
    if (permissionState.anon_acl_find_job_by_id_execute === true) {
      permissionIssues.push('- privilege mismatch: anon can execute public.api_acl_find_job_by_id(uuid, uuid)');
    }
    if (permissionState.authenticated_acl_find_job_by_id_execute !== true) {
      permissionIssues.push('- privilege mismatch: authenticated cannot execute public.api_acl_find_job_by_id(uuid, uuid)');
    }
    if (permissionState.service_role_acl_find_job_by_id_execute !== true) {
      permissionIssues.push('- privilege mismatch: service_role cannot execute public.api_acl_find_job_by_id(uuid, uuid)');
    }

    if (permissionIssues.length > 0) {
      throw new Error(
        '[schema-check] Public RPC permissions are out of date for the current release.\n' +
          `Apply all checked-in backend migrations in numeric order through ${LATEST_MIGRATION}, then retry.\n` +
          permissionIssues.join('\n')
      );
    }

    const serviceRoleRows = await client.query(
      `
        select
          has_schema_privilege('service_role', 'app', 'USAGE') as service_role_app_schema_usage,
          has_table_privilege('service_role', 'app.boxes', 'SELECT') as service_role_boxes_select,
          has_table_privilege('service_role', 'app.boxes', 'INSERT') as service_role_boxes_insert,
          has_table_privilege('service_role', 'app.boxes', 'UPDATE') as service_role_boxes_update,
          has_table_privilege('service_role', 'app.boxes', 'DELETE') as service_role_boxes_delete,
          has_schema_privilege('anon', 'app', 'USAGE') as anon_app_schema_usage,
          has_schema_privilege('authenticated', 'app', 'USAGE') as authenticated_app_schema_usage;
      `
    );

    const serviceRoleState = serviceRoleRows.rows[0] || {};
    const serviceRoleIssues = [];
    if (serviceRoleState.service_role_app_schema_usage !== true) {
      serviceRoleIssues.push('- privilege mismatch: service_role lacks USAGE on schema app');
    }
    if (serviceRoleState.service_role_boxes_select !== true) {
      serviceRoleIssues.push('- privilege mismatch: service_role cannot SELECT app.boxes');
    }
    if (serviceRoleState.service_role_boxes_insert !== true) {
      serviceRoleIssues.push('- privilege mismatch: service_role cannot INSERT app.boxes');
    }
    if (serviceRoleState.service_role_boxes_update !== true) {
      serviceRoleIssues.push('- privilege mismatch: service_role cannot UPDATE app.boxes');
    }
    if (serviceRoleState.service_role_boxes_delete !== true) {
      serviceRoleIssues.push('- privilege mismatch: service_role cannot DELETE app.boxes');
    }
    if (serviceRoleState.anon_app_schema_usage === true) {
      serviceRoleIssues.push('- privilege mismatch: anon has direct USAGE on schema app');
    }
    if (serviceRoleState.authenticated_app_schema_usage === true) {
      serviceRoleIssues.push('- privilege mismatch: authenticated has direct USAGE on schema app');
    }

    if (serviceRoleIssues.length > 0) {
      throw new Error(
        '[schema-check] Service-role app schema permissions are out of date for the current release.\n' +
          `Apply all checked-in backend migrations in numeric order through ${LATEST_MIGRATION}, then retry.\n` +
          serviceRoleIssues.join('\n')
      );
    }

    const summary = REQUIRED_OBJECTS.map((item) => `${item.kind}:${item.signature}`).join(', ');
    console.log(`[schema-check] OK (${summary})`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

runSchemaCheck().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
