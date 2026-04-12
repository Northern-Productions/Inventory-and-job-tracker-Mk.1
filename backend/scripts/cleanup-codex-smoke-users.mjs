import '../load-env.mjs'
import { Client } from 'pg'

const TARGET_EMAIL_PATTERNS = Object.freeze([
  'codex-smoke-%@example.com',
  'codex-transfer-smoke-%@example.com',
])

function parseArgs(argv) {
  const options = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '')
    if (!token.startsWith('--')) {
      continue
    }

    const normalized = token.slice(2)
    const separatorIndex = normalized.indexOf('=')
    if (separatorIndex >= 0) {
      const key = normalized.slice(0, separatorIndex)
      const value = normalized.slice(separatorIndex + 1)
      options[key] = value || true
      continue
    }

    const next = argv[index + 1]
    if (!next || String(next).startsWith('--')) {
      options[normalized] = true
      continue
    }

    options[normalized] = next
    index += 1
  }

  return options
}

function asTrimmedString(value) {
  return String(value ?? '').trim()
}

function assertOk(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function splitEmailList(value) {
  return asTrimmedString(value)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

function buildDatabaseClient(databaseUrl) {
  return new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  })
}

function extractErrorDetail(payload) {
  return (
    asTrimmedString(payload?.msg) ||
    asTrimmedString(payload?.error_description) ||
    asTrimmedString(payload?.error) ||
    asTrimmedString(payload?.message)
  )
}

async function readJson(response) {
  try {
    return await response.json()
  } catch (_error) {
    return null
  }
}

async function loadTargets(client, orgId) {
  const { rows } = await client.query(
    `
      with auth_targets as (
        select
          u.id as user_id,
          lower(btrim(coalesce(u.email, ''))) as email,
          btrim(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')) as display_name
        from auth.users u
        where u.email ilike $2
           or u.email ilike $3
      ),
      access_targets as (
        select
          r.user_id,
          lower(btrim(coalesce(r.requested_by_email, ''))) as email,
          btrim(coalesce(r.requested_by_name, '')) as display_name
        from app.access_requests r
        where r.org_id = $1::uuid
          and (
            r.requested_by_email ilike $2
            or r.requested_by_email ilike $3
          )
      ),
      targets as (
        select * from auth_targets
        union
        select * from access_targets
      )
      select
        t.user_id::text as user_id,
        coalesce(nullif(max(t.email), ''), '') as email,
        coalesce(max(nullif(t.display_name, '')), '') as display_name,
        exists(select 1 from auth.users u where u.id = t.user_id) as auth_user_exists,
        exists(
          select 1
          from app.organization_members m
          where m.org_id = $1::uuid
            and m.user_id = t.user_id
        ) as membership_exists,
        coalesce(
          (
            select lower(btrim(m.role))
            from app.organization_members m
            where m.org_id = $1::uuid
              and m.user_id = t.user_id
            limit 1
          ),
          ''
        ) as membership_role,
        exists(
          select 1
          from app.access_requests r
          where r.org_id = $1::uuid
            and r.user_id = t.user_id
        ) as access_request_exists,
        coalesce(
          (
            select lower(btrim(r.status))
            from app.access_requests r
            where r.org_id = $1::uuid
              and r.user_id = t.user_id
            limit 1
          ),
          ''
        ) as access_request_status,
        exists(
          select 1
          from app.admin_feature_permissions a
          where a.org_id = $1::uuid
            and a.admin_user_id = t.user_id
        ) as admin_feature_rows_exist,
        exists(
          select 1
          from app.username_change_requests ucr
          where ucr.org_id = $1::uuid
            and ucr.user_id = t.user_id
        ) as username_request_exists,
        exists(
          select 1
          from app.owner_notification_preferences o
          where o.org_id = $1::uuid
            and o.owner_user_id = t.user_id
        ) as owner_notification_exists
      from targets t
      group by t.user_id
      order by coalesce(nullif(max(t.email), ''), '') asc, t.user_id asc
    `,
    [orgId, TARGET_EMAIL_PATTERNS[0], TARGET_EMAIL_PATTERNS[1]]
  )

  return rows.map((row) => ({
    userId: asTrimmedString(row.user_id),
    email: asTrimmedString(row.email).toLowerCase(),
    displayName: asTrimmedString(row.display_name),
    authUserExists: row.auth_user_exists === true,
    membershipExists: row.membership_exists === true,
    membershipRole: asTrimmedString(row.membership_role),
    accessRequestExists: row.access_request_exists === true,
    accessRequestStatus: asTrimmedString(row.access_request_status),
    adminFeatureRowsExist: row.admin_feature_rows_exist === true,
    usernameRequestExists: row.username_request_exists === true,
    ownerNotificationExists: row.owner_notification_exists === true,
  }))
}

function logTargets(label, targets) {
  console.log(`${label}: ${targets.length}`)
  for (const target of targets) {
    const parts = [
      target.email || '<missing-email>',
      target.userId,
      `auth=${target.authUserExists ? 'yes' : 'no'}`,
      `membership=${target.membershipExists ? target.membershipRole || 'yes' : 'no'}`,
      `access=${target.accessRequestExists ? target.accessRequestStatus || 'yes' : 'no'}`,
      `adminFeatureRows=${target.adminFeatureRowsExist ? 'yes' : 'no'}`,
      `usernameRequests=${target.usernameRequestExists ? 'yes' : 'no'}`,
    ]

    if (target.ownerNotificationExists) {
      parts.push('ownerPrefs=yes')
    }

    console.log(`- ${parts.join(' | ')}`)
  }
}

async function deleteDatabaseRows(client, orgId, userId) {
  await client.query('begin')

  try {
    const usernameRequests = await client.query(
      `
        delete from app.username_change_requests
        where org_id = $1::uuid
          and user_id = $2::uuid
      `,
      [orgId, userId]
    )
    const accessRequests = await client.query(
      `
        delete from app.access_requests
        where org_id = $1::uuid
          and user_id = $2::uuid
      `,
      [orgId, userId]
    )
    const memberships = await client.query(
      `
        delete from app.organization_members
        where org_id = $1::uuid
          and user_id = $2::uuid
      `,
      [orgId, userId]
    )

    await client.query('commit')

    return {
      usernameRequestRows: usernameRequests.rowCount || 0,
      accessRequestRows: accessRequests.rowCount || 0,
      membershipRows: memberships.rowCount || 0,
    }
  } catch (error) {
    try {
      await client.query('rollback')
    } catch (_rollbackError) {
      // Ignore rollback failure and surface the original error.
    }
    throw error
  }
}

async function deleteAuthUser(supabaseUrl, serviceRoleKey, userId) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  })
  const payload = await readJson(response)

  if (response.status === 404) {
    return {
      deleted: false,
      alreadyMissing: true,
    }
  }

  if (!response.ok) {
    const detail = extractErrorDetail(payload)
    throw new Error(`Unable to delete auth user ${userId}.${detail ? ` ${detail}` : ''}`.trim())
  }

  return {
    deleted: true,
    alreadyMissing: false,
  }
}

async function deleteAuthUserViaDatabase(client, userId) {
  const result = await client.query(
    `
      delete from auth.users
      where id = $1::uuid
    `,
    [userId]
  )

  return {
    deleted: (result.rowCount || 0) > 0,
    alreadyMissing: (result.rowCount || 0) === 0,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apply = args.apply === true
  const databaseUrl = asTrimmedString(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL)
  const orgId = asTrimmedString(process.env.DEFAULT_ORG_ID)
  const supabaseUrl = asTrimmedString(process.env.SUPABASE_URL).replace(/\/+$/g, '')
  const serviceRoleKey = asTrimmedString(process.env.SUPABASE_SERVICE_ROLE_KEY)

  assertOk(databaseUrl, 'DATABASE_URL or SUPABASE_DB_URL is required.')
  assertOk(orgId, 'DEFAULT_ORG_ID is required.')

  const preservedEmails = new Set([
    ...splitEmailList(process.env.SMOKE_USER_EMAIL),
    ...splitEmailList(args['preserve-email']),
  ])

  const client = buildDatabaseClient(databaseUrl)
  await client.connect()

  try {
    const discoveredTargets = await loadTargets(client, orgId)
    const preservedTargets = discoveredTargets.filter((target) => preservedEmails.has(target.email))
    const targets = discoveredTargets.filter((target) => !preservedEmails.has(target.email))

    console.log(`[codex-smoke-cleanup] mode=${apply ? 'apply' : 'dry-run'}`)
    if (preservedEmails.size > 0) {
      console.log(
        `[codex-smoke-cleanup] preserving emails: ${[...preservedEmails].sort((left, right) => left.localeCompare(right)).join(', ')}`
      )
    }

    if (preservedTargets.length > 0) {
      logTargets('Preserved matching targets', preservedTargets)
    }

    if (!targets.length) {
      console.log('[codex-smoke-cleanup] No codex smoke targets found.')
      return
    }

    logTargets('Codex smoke targets', targets)

    if (!apply) {
      console.log('[codex-smoke-cleanup] Dry run only. Re-run with --apply to persist deletions.')
      return
    }

    const canUseAuthAdminApi = Boolean(supabaseUrl && serviceRoleKey)
    if (targets.some((target) => target.authUserExists) && !canUseAuthAdminApi) {
      console.log(
        '[codex-smoke-cleanup] SUPABASE_SERVICE_ROLE_KEY is not configured; falling back to deleting from auth.users via DATABASE_URL.'
      )
    }

    const failures = []
    let processed = 0

    for (const target of targets) {
      console.log(`[codex-smoke-cleanup] Cleaning ${target.email || target.userId}`)

      try {
        const dbResult = await deleteDatabaseRows(client, orgId, target.userId)
        const authResult = target.authUserExists
          ? canUseAuthAdminApi
            ? await deleteAuthUser(supabaseUrl, serviceRoleKey, target.userId)
            : await deleteAuthUserViaDatabase(client, target.userId)
          : { deleted: false, alreadyMissing: false, usedDatabaseFallback: false }

        processed += 1
        console.log(
          `[codex-smoke-cleanup] Result ${target.email || target.userId}: ` +
            `username_requests=${dbResult.usernameRequestRows}, ` +
            `access_requests=${dbResult.accessRequestRows}, ` +
            `memberships=${dbResult.membershipRows}, ` +
            `auth_user=${
              authResult.deleted
                ? canUseAuthAdminApi
                  ? 'deleted'
                  : 'deleted-via-db'
                : authResult.alreadyMissing
                  ? 'missing'
                  : 'skipped'
            }`
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ email: target.email, userId: target.userId, message })
        console.error(`[codex-smoke-cleanup] Failed ${target.email || target.userId}: ${message}`)
      }
    }

    if (failures.length > 0) {
      console.error(`[codex-smoke-cleanup] Cleanup finished with ${failures.length} failure(s).`)
      for (const failure of failures) {
        console.error(`- ${failure.email || '<missing-email>'} | ${failure.userId} | ${failure.message}`)
      }
      process.exitCode = 1
      return
    }

    console.log(`[codex-smoke-cleanup] Cleanup complete. processed=${processed}`)
  } finally {
    await client.end().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(
    '[codex-smoke-cleanup] Cleanup failed:',
    error instanceof Error ? error.message : error
  )
  process.exit(1)
})
