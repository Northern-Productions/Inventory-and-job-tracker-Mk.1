import '../load-env.mjs';
import { Client } from 'pg';

const DATABASE_URL = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
const SKIP_SCHEMA_CHECK = String(process.env.SCHEMA_CHECK_SKIP || '').trim().toLowerCase() === 'true';
const LATEST_MIGRATION = '0071_box_dealers_and_guided_receive_support.sql';

const REQUIRED_OBJECTS = [
  { kind: 'table', signature: 'app.access_requests' },
  { kind: 'column', signature: 'app.access_requests.requested_by_name' },
  { kind: 'table', signature: 'app.username_change_requests' },
  { kind: 'table', signature: 'app.general_feature_permissions' },
  { kind: 'table', signature: 'app.admin_feature_permissions' },
  { kind: 'table', signature: 'app.owner_notification_preferences' },
  { kind: 'column', signature: 'app.jobs.is_labor_only' },
  { kind: 'column', signature: 'app.jobs.is_staged_for_pickup' },
  { kind: 'table', signature: 'app.caulk_transfers' },
  { kind: 'table', signature: 'app.box_dealers' },
  { kind: 'type', signature: 'app.caulk_transfer_status' },
  { kind: 'column', signature: 'app.boxes.dealer' },
  { kind: 'function', signature: 'public.api_get_auth_context(uuid)' },
  { kind: 'function', signature: 'public.api_request_username_change(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_list_username_change_requests(uuid, text)' },
  { kind: 'function', signature: 'public.api_get_user_feature_permissions(uuid, uuid)' },
  { kind: 'function', signature: 'public.api_update_user_feature_permissions(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_boxes_delete(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_boxes_delete(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_boxes_receive_ordered(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_list_box_dealers(uuid)' },
  { kind: 'function', signature: 'public.api_acl_box_dealers_upsert(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_boxes_set_status(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_jobs_set_staged_pickup(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_jobs_set_staged_pickup(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_list_caulk_job_allocations_by_job(uuid, text)' },
  { kind: 'function', signature: 'public.api_acl_list_caulk_transfers(uuid, text, uuid)' },
  { kind: 'function', signature: 'public.api_acl_caulk_upsert_product(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_caulk_add(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_caulk_update(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_allocations_caulk_remove(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_caulk_transfer_receive(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_acl_caulk_transfer_cancel(uuid, text, jsonb)' },
  { kind: 'function', signature: 'app_api.total_active_allocated_feet_for_box(uuid, text)' },
  { kind: 'function', signature: 'app_api.locked_allocated_feet_for_box(uuid, text)' },
  { kind: 'function', signature: 'app_api.placeholder_allocated_feet_for_box(uuid, text)' },
  { kind: 'function', signature: 'app_api.box_physical_feet_available(app.boxes)' },
  { kind: 'function', signature: 'app_api.box_allocatable_now_feet(app.boxes)' },
  { kind: 'function', signature: 'app_api.recalculate_physical_box_allocatable_now(uuid, text, integer)' },
  { kind: 'function', signature: 'app_api.recalculate_film_order(uuid, text, text)' },
  { kind: 'function', signature: 'app_api.process_linked_box_receipt(uuid, app.boxes, text)' },
  { kind: 'function', signature: 'app_api.upsert_box_dealer(uuid, text)' },
  { kind: 'function', signature: 'app_api.sync_active_job_schedule_allocations(uuid, text, date, text)' },
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
    includes: ['v_recalculate_film_order_ids', 'perform app_api.recalculate_film_order(p_org_id, v_recalculate_film_order_id, p_actor);'],
    excludes: ['v_box.feet_available <= 0']
  },
  {
    signature: 'public.api_acl_boxes_receive_ordered(uuid, text, jsonb)',
    includes: [
      'public.api_boxes_update(p_org_id, p_actor, v_payload)',
      "set action = 'SET_STATUS'",
      'app_api.locked_allocated_feet_for_box(p_org_id, v_lookup_box_id)'
    ],
    excludes: []
  },
  {
    signature: 'public.api_boxes_set_status(uuid, text, jsonb)',
    includes: ['perform app_api.recalculate_film_orders_for_box_links(p_org_id, v_box.box_id, p_actor);'],
    excludes: []
  },
  {
    signature: 'app_api.save_box(app.boxes)',
    includes: ['perform app_api.upsert_box_dealer(p_box.org_id, p_box.dealer);', 'dealer = excluded.dealer'],
    excludes: []
  },
  {
    signature: 'app_api.public_box_json(app.boxes)',
    includes: ["'dealer', coalesce(p_box.dealer, '')"],
    excludes: []
  },
  {
    signature: 'app_api.public_box_state_to_box_row(uuid, jsonb, uuid)',
    includes: ["v_box.dealer := coalesce(p_state->>'dealer', '');"],
    excludes: []
  },
  {
    signature: 'public.api_boxes_add(uuid, text, jsonb)',
    includes: ["v_box.dealer := app_api.trim_text(p_payload->>'dealer');"],
    excludes: []
  },
  {
    signature: 'public.api_boxes_update(uuid, text, jsonb)',
    includes: ['v_box.dealer := case', "then app_api.trim_text(p_payload->>'dealer')", "else coalesce(v_existing.dealer, '')"],
    excludes: []
  }
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
      semanticRows.rows.map((row) => [row.signature, String(row.definition || '')])
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
