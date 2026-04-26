/**
 * PURPOSE:
 * Keeps roll history persistence aligned with backend runtime code that writes
 * and reads app.roll_weight_log.created_at.
 *
 * AFFECTS:
 * Film box check-in, roll history logging, and ordered-box allocation flow
 * verification.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend/src/app/repositories/auditRepository.mjs, runtimeTransferUsage.mjs,
 * Supabase roll history services, and schema latest checks.
 */

alter table app.roll_weight_log
  add column if not exists created_at timestamptz not null default now();

create index if not exists idx_roll_weight_log_org_created_at
  on app.roll_weight_log (org_id, created_at desc, id desc);
