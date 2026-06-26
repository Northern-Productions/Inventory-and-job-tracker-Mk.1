import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ownershipService = await readFile(new URL('../../src/app/services/ownership.mjs', import.meta.url), 'utf8');

test('local caulk ownership lookup locks only the concrete stock row', () => {
  const match = ownershipService.match(/async function findCaulkStockRow[\s\S]*?if \(!row\)/);
  assert.ok(match, 'Expected findCaulkStockRow local service helper to exist.');

  const helperBody = match[0];
  assert.match(
    helperBody,
    /left join app\.owner_companies current_owner/i,
    'Expected the lookup to retain owner display metadata.'
  );
  assert.match(
    helperBody,
    /for update of s/i,
    'Expected the lookup to lock app.caulk_stock only, not nullable left-joined owner rows.'
  );
  assert.doesNotMatch(
    helperBody,
    /where s\.org_id = \$1::uuid[\s\S]*and s\.id = \$2::uuid[\s\S]*for update\s*(?:\n|`)/i,
    'Bare FOR UPDATE on a left join causes Postgres to reject caulk owner updates.'
  );
});
