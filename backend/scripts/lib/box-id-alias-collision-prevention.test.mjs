import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readRepoFile(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('box identity collision migration is mirrored for backend and Supabase', async () => {
  const backendMigration = await readRepoFile('migrations/0162_prevent_box_id_alias_collisions.sql');
  const supabaseMigration = await readRepoFile(
    '../supabase/migrations/20260617100000_prevent_box_id_alias_collisions.sql'
  );

  assert.equal(supabaseMigration, backendMigration);
});

test('box alias resolver prefers direct box rows before historical aliases', async () => {
  const migration = await readRepoFile('migrations/0162_prevent_box_id_alias_collisions.sql');
  const directLookupIndex = migration.indexOf('from app.boxes b');
  const aliasLookupIndex = migration.indexOf('from app.box_id_aliases a');

  assert.match(migration, /create or replace function app_api\.resolve_box_id_alias/);
  assert.ok(directLookupIndex > 0, 'resolver should check app.boxes for exact direct rows');
  assert.ok(aliasLookupIndex > directLookupIndex, 'resolver should only check aliases after direct rows');
  assert.match(migration, /return v_input;/, 'direct row match should return the requested BoxID');
});

test('box identity guard migration blocks future ambiguous direct IDs and aliases without repairing old data', async () => {
  const migration = await readRepoFile('migrations/0162_prevent_box_id_alias_collisions.sql');

  assert.match(migration, /create or replace function app_api\.box_id_identity_collision_diagnostics/);
  assert.match(migration, /DIRECT_BOX_MATCHES_ALIAS_OLD_BOX_ID/);
  assert.match(migration, /create trigger trg_boxes_prevent_alias_old_collision/);
  assert.match(migration, /create trigger trg_box_id_aliases_prevent_direct_collision/);
  assert.match(migration, /BoxID %s is reserved as a historical transfer alias/);
  assert.match(migration, /Existing direct rows may already collide with legacy aliases/);
  assert.doesNotMatch(
    migration,
    /validate constraint|delete from app\.box_id_aliases|update app\.boxes set box_id/i,
    'migration must not validate/repair existing collisions such as IL2-2'
  );
});

test('safe next BoxID suggestion considers boxes, aliases, and pending transfer destinations', async () => {
  const migration = await readRepoFile('migrations/0162_prevent_box_id_alias_collisions.sql');

  assert.match(migration, /create or replace function app_api\.suggest_next_box_id/);
  assert.match(migration, /from app\.boxes b/);
  assert.match(migration, /select a\.old_box_id/);
  assert.match(migration, /select a\.canonical_box_id/);
  assert.match(migration, /select t\.destination_box_id/);
  assert.match(migration, /t\.status = 'PENDING'/);
  assert.match(migration, /public\.api_acl_suggest_next_box_id/);
});

test('local and Edge read routes expose the safe next BoxID suggestion', async () => {
  const localHandlers = await readRepoFile('src/app/handlers/readHandlers.mjs');
  const fallbackRoutes = await readRepoFile('src/routes/localFallbackRoutes.mjs');
  const edgeHandlers = await readRepoFile('../supabase/functions/_shared/routes/readHandlers.ts');
  const edgeApiHandler = await readRepoFile('../supabase/functions/_shared/api-handler.ts');

  assert.match(localHandlers, /'\/boxes\/suggest-next-id'/);
  assert.match(localHandlers, /suggestNextBoxId\(client,\s*orgId/);
  assert.match(fallbackRoutes, /"\/boxes\/suggest-next-id"/);
  assert.match(edgeHandlers, /"\/boxes\/suggest-next-id"/);
  assert.match(edgeApiHandler, /api_acl_suggest_next_box_id/);
});

test('Add Box uses the backend safe suggestion before falling back to visible box math', async () => {
  const addBoxPage = await readRepoFile('../frontend/src/features/inventory/pages/AddBoxPage.tsx');
  const boxDrafts = await readRepoFile('../frontend/src/features/inventory/utils/box/boxDrafts.ts');
  const crud = await readRepoFile('src/app/services/runtime/boxes/crud.mjs');

  assert.match(addBoxPage, /useSuggestedNextBoxId\(safeWarehouse/);
  assert.match(addBoxPage, /suggestedBoxIdIsAlreadyKnown/);
  assert.match(addBoxPage, /suggestedBoxId && !suggestedBoxIdIsAlreadyKnown/);
  assert.doesNotMatch(boxDrafts, /ACTIVE_CANONICAL_BOX_STATUSES/);
  assert.match(crud, /conflictType === 'alias'/);
  assert.match(crud, /historical transfer alias/);
});
