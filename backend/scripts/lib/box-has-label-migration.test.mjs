import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backendMigration = readFileSync(new URL('../../migrations/0113_box_has_label.sql', import.meta.url), 'utf8');
const supabaseMigration = readFileSync(
  new URL('../../../supabase/migrations/20260510120000_box_has_label.sql', import.meta.url),
  'utf8'
);
const schemaCheck = readFileSync(new URL('../check-schema-latest.mjs', import.meta.url), 'utf8');
const runtimeCollectionsAndBoxes = readFileSync(
  new URL('../../src/app/services/runtime/runtimeCollectionsAndBoxes.mjs', import.meta.url),
  'utf8'
);

test('box label tracking migration is mirrored for Supabase deploys', () => {
  assert.equal(supabaseMigration, backendMigration);
});

test('box label tracking migration adds the field with a labeled default', () => {
  assert.match(backendMigration, /add column if not exists has_label boolean not null default true/i);
  assert.match(backendMigration, /set has_label = true/i);
});

test('box label tracking migration exposes hasLabel in public box JSON and undo state', () => {
  assert.match(backendMigration, /'hasLabel', coalesce\(p_box\.has_label, true\)/);
  assert.match(backendMigration, /v_box\.has_label := coalesce\(\(p_state->>'hasLabel'\)::boolean, true\);/);
  assert.match(backendMigration, /coalesce\(p_box\.has_label, true\)/);
  assert.match(backendMigration, /has_label = excluded\.has_label/);
});

test('box label tracking migration marks ordered receipts as unlabeled', () => {
  assert.match(backendMigration, /v_box\.has_label := false;/);
  assert.match(backendMigration, /api_acl_boxes_receive_ordered/);
  assert.match(
    backendMigration,
    /v_box\.feet_available := greatest\(coalesce\(v_existing\.initial_feet, 0\) - coalesce\(v_locked_allocated_feet, 0\), 0\);/
  );
  assert.match(
    backendMigration,
    /if v_next = v_base then\s+v_next := replace\(/m
  );
});

test('local add and edit box runtime keeps unlabeled boxes unlabeled until printed', () => {
  assert.match(runtimeCollectionsAndBoxes, /hasLabel: existingBox \? existingBox\.hasLabel !== false : false/);
  assert.doesNotMatch(runtimeCollectionsAndBoxes, /hasLabel:\s*true/);
});

test('box label tracking migration adds a mark-printed RPC with audit entries', () => {
  assert.match(backendMigration, /create or replace function public\.api_acl_boxes_mark_labels_printed/);
  assert.match(backendMigration, /jsonb_typeof\(p_payload->'boxIds'\)/);
  assert.match(backendMigration, /set has_label = true/);
  assert.match(backendMigration, /'UPDATE_BOX'/);
  assert.match(backendMigration, /Label printed for box %s\./);
});

test('schema guard tracks the box label migration and required objects', () => {

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0194_scoped_job_summary_reads\.sql';/);

  assert.match(schemaCheck, /signature: 'app\.boxes\.has_label'/);
  assert.match(schemaCheck, /signature: 'public\.api_acl_boxes_mark_labels_printed\(uuid, text, jsonb\)'/);
  assert.match(schemaCheck, /v_box\.has_label := false;/);
  assert.match(schemaCheck, /'hasLabel', coalesce\(p_box\.has_label, true\)/);
});
