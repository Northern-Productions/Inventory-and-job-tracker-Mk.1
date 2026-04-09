import { queryRow, queryRows } from '../../db/client.mjs';
import { asTrimmedString, createLogId } from '../core/helpers.mjs';
import { normalizeCanonicalManufacturerAndFilm } from '../core/catalog.mjs';
import { resolveBoxIdAlias } from './boxesRepository.mjs';
import { mapDbAuditRow, mapDbRollHistoryRow } from './mappers.mjs';

async function listAuditEntries(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.audit_log
      where org_id = $1
      order by created_at desc, log_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbAuditRow);
}

async function listAuditEntriesByBox(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const rows = await queryRows(
    client,
    `
      select *
      from app.audit_log
      where org_id = $1
        and box_id = $2
      order by created_at desc, log_id desc
    `,
    [orgId, canonicalBoxId]
  );

  return rows.map(mapDbAuditRow);
}

async function findAuditEntryByLogId(client, orgId, logId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.audit_log
      where org_id = $1
        and log_id = $2
    `,
    [orgId, logId]
  );

  return mapDbAuditRow(row);
}

async function appendAuditEntry(client, orgId, action, boxId, beforeState, afterState, actor, notes) {
  const logId = createLogId();
  await client.query(
    `
      insert into app.audit_log (
        org_id,
        log_id,
        action,
        box_id,
        before_state,
        after_state,
        actor,
        notes,
        created_at
      )
      values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::timestamptz)
    `,
    [
      orgId,
      logId,
      action,
      boxId,
      beforeState === null ? null : JSON.stringify(beforeState),
      afterState === null ? null : JSON.stringify(afterState),
      actor,
      asTrimmedString(notes),
      new Date().toISOString(),
    ]
  );
  return logId;
}

async function listRollHistoryByBox(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const rows = await queryRows(
    client,
    `
      select *
      from app.roll_weight_log
      where org_id = $1
        and box_id = $2
      order by checked_in_at desc nulls last, checked_out_at desc nulls last, log_id desc
    `,
    [orgId, canonicalBoxId]
  );

  return rows.map(mapDbRollHistoryRow);
}

async function listRollHistoryByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.roll_weight_log
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
      order by checked_in_at desc nulls last, checked_out_at desc nulls last, log_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbRollHistoryRow);
}

async function appendRollHistoryEntry(client, orgId, entry) {
  const normalized = normalizeCanonicalManufacturerAndFilm(entry.manufacturer, entry.filmName);
  const manufacturer = normalized.manufacturer;
  const filmName = normalized.filmName;
  await client.query(
    `
      insert into app.roll_weight_log (
        org_id,
        log_id,
        box_id,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        job_number,
        checked_out_at,
        checked_out_by,
        checked_out_weight_lbs,
        checked_in_at,
        checked_in_by,
        checked_in_weight_lbs,
        weight_delta_lbs,
        feet_before,
        feet_after,
        notes,
        created_at
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,
        nullif($9, '')::timestamptz,
        $10,$11,
        nullif($12, '')::timestamptz,
        $13,$14,$15,$16,$17,$18,now()
      )
    `,
    [
      orgId,
      entry.logId || createLogId(),
      entry.boxId,
      entry.warehouse,
      manufacturer,
      filmName,
      entry.widthIn,
      entry.jobNumber,
      entry.checkedOutAt,
      entry.checkedOutBy,
      entry.checkedOutWeightLbs,
      entry.checkedInAt,
      entry.checkedInBy,
      entry.checkedInWeightLbs,
      entry.weightDeltaLbs,
      entry.feetBefore,
      entry.feetAfter,
      entry.notes,
    ]
  );
}

export {
  listAuditEntries,
  listAuditEntriesByBox,
  findAuditEntryByLogId,
  appendAuditEntry,
  listRollHistoryByBox,
  listRollHistoryByJob,
  appendRollHistoryEntry,
};
