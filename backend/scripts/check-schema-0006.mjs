import '../load-env.mjs';
import { Client } from 'pg';

const DATABASE_URL = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
const SKIP_SCHEMA_CHECK = String(process.env.SCHEMA_CHECK_SKIP || '').trim().toLowerCase() === 'true';

const REQUIRED_OBJECTS = [
  { kind: 'table', signature: 'app.access_requests' },
  { kind: 'column', signature: 'app.access_requests.requested_by_name' },
  { kind: 'table', signature: 'app.username_change_requests' },
  { kind: 'table', signature: 'app.general_feature_permissions' },
  { kind: 'table', signature: 'app.admin_feature_permissions' },
  { kind: 'table', signature: 'app.owner_notification_preferences' },
  { kind: 'function', signature: 'public.api_get_auth_context(uuid)' },
  { kind: 'function', signature: 'public.api_request_username_change(uuid, text, jsonb)' },
  { kind: 'function', signature: 'public.api_list_username_change_requests(uuid, text)' },
  { kind: 'function', signature: 'public.api_get_user_feature_permissions(uuid, uuid)' },
  { kind: 'function', signature: 'public.api_update_user_feature_permissions(uuid, text, jsonb)' }
];

async function runSchemaCheck() {
  if (SKIP_SCHEMA_CHECK) {
    console.log('[schema-check] Skipped because SCHEMA_CHECK_SKIP=true');
    return;
  }

  if (!DATABASE_URL) {
    throw new Error('[schema-check] DATABASE_URL (or SUPABASE_DB_URL) is required.');
  }

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
            ('table'::text, 'app.access_requests'::text),
            ('column'::text, 'app.access_requests.requested_by_name'::text),
            ('table'::text, 'app.username_change_requests'::text),
            ('table'::text, 'app.general_feature_permissions'::text),
            ('table'::text, 'app.admin_feature_permissions'::text),
            ('table'::text, 'app.owner_notification_preferences'::text),
            ('function'::text, 'public.api_get_auth_context(uuid)'::text),
            ('function'::text, 'public.api_request_username_change(uuid, text, jsonb)'::text),
            ('function'::text, 'public.api_list_username_change_requests(uuid, text)'::text),
            ('function'::text, 'public.api_get_user_feature_permissions(uuid, uuid)'::text),
            ('function'::text, 'public.api_update_user_feature_permissions(uuid, text, jsonb)'::text)
        )
        select
          kind,
          signature,
          case
            when kind = 'table' then to_regclass(signature) is not null
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
        '[schema-check] Missing required migration objects (0006/0007/0008/0009):\n' +
          `${details}\n` +
          'Run backend/migrations/0006_access_control_and_approvals.sql, backend/migrations/0007_access_request_display_name.sql, backend/migrations/0008_username_change_requests.sql, and backend/migrations/0009_user_feature_overrides.sql against this database.'
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
