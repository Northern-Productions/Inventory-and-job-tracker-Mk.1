import { queryRow } from '../../db/client.mjs';
import { requireString } from '../core/helpers.mjs';

export async function selectOrganization(client, payload) {
  const orgId = requireString(payload?.orgId, 'orgId');
  const row = await queryRow(
    client,
    'select public.api_select_organization($1::uuid) as result',
    [orgId]
  );
  return row?.result && typeof row.result === 'object' ? row.result : { orgId };
}
