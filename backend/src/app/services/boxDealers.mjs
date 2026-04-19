import { queryRow, queryRows } from '../../db/client.mjs';
import { requireString } from '../core/helpers.mjs';
import { mapBoxDealerRow } from '../repositories/mappers.mjs';

const DEFAULT_BOX_DEALER_NAMES = [
  'Eastman Performance Films',
  'Energy Products Distribution',
  'Accent',
  'Decorative Films',
  'Kingston Coatings',
];

async function seedDefaultBoxDealers(client, orgId) {
  await queryRows(
    client,
    `
      with defaults(name) as (
        values
          ('Eastman Performance Films'::text),
          ('Energy Products Distribution'::text),
          ('Accent'::text),
          ('Decorative Films'::text),
          ('Kingston Coatings'::text)
      )
      insert into app.box_dealers (
        org_id,
        name,
        lookup_key
      )
      select
        $1::uuid,
        defaults.name,
        app_api.normalize_catalog_lookup_key(defaults.name)
      from defaults
      on conflict (org_id, lookup_key) do nothing
      returning id
    `,
    [orgId]
  );
}

async function listBoxDealers(client, orgId) {
  await seedDefaultBoxDealers(client, orgId);

  const rows = await queryRows(
    client,
    `
      select
        d.id as dealer_id,
        d.name,
        d.lookup_key,
        d.updated_at
      from app.box_dealers d
      where d.org_id = $1::uuid
      order by lower(d.name), d.updated_at desc, d.id asc
    `,
    [orgId]
  );

  return rows.map(mapBoxDealerRow);
}

async function upsertBoxDealer(client, orgId, _actor, payload) {
  await seedDefaultBoxDealers(client, orgId);

  const name = requireString(payload.name, 'Name');
  const row = await queryRow(
    client,
    `
      insert into app.box_dealers (
        org_id,
        name,
        lookup_key
      )
      values (
        $1::uuid,
        $2::text,
        app_api.normalize_catalog_lookup_key($2::text)
      )
      on conflict (org_id, lookup_key) do update set
        name = excluded.name,
        updated_at = timezone('utc', now())
      returning
        id as dealer_id,
        name,
        lookup_key,
        updated_at
    `,
    [orgId, name]
  );

  return mapBoxDealerRow(row);
}

export {
  DEFAULT_BOX_DEALER_NAMES,
  listBoxDealers,
  seedDefaultBoxDealers,
  upsertBoxDealer,
};
