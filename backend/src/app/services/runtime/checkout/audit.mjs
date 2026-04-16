import {
  asTrimmedString,
  listAuditEntriesByBox,
} from '../../runtimeDeps.mjs';

async function findLatestCheckoutAuditEntryByBoxId(client, orgId, boxId) {
  const entries = await listAuditEntriesByBox(client, orgId, boxId);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.action !== 'SET_STATUS') {
      continue;
    }

    if (entry.after && entry.after.status === 'CHECKED_OUT') {
      return entry;
    }
  }

  return null;
}

function getCheckoutJobNumberFromAuditNotes(notes) {
  const text = asTrimmedString(notes);
  const match = text.match(/^Checked out for job\s+(.+)$/i);
  return match ? asTrimmedString(match[1]) : '';
}

export {
  findLatestCheckoutAuditEntryByBoxId,
  getCheckoutJobNumberFromAuditNotes,
};
