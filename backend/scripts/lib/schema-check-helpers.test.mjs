import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeFunctionDefinitionForSemanticCheck } from './schema-check-helpers.mjs';

test('schema semantic check normalizes CRLF and CR function bodies to LF', () => {
  const definition = 'insert into app.roll_weight_log (\r\n    created_at\r  )\r\nvalues (now())';

  assert.equal(
    normalizeFunctionDefinitionForSemanticCheck(definition),
    'insert into app.roll_weight_log (\n    created_at\n  )\nvalues (now())'
  );
});

test('schema semantic check normalization preserves required snippet strictness', () => {
  const safeDefinition = 'insert into app.roll_weight_log (\r\n    created_at\r\n  )';
  const unsafeDefinition = 'insert into app.roll_weight_log (\r\n    notes\r\n  )';
  const requiredSnippet = 'created_at\n  )';

  assert.equal(normalizeFunctionDefinitionForSemanticCheck(safeDefinition).includes(requiredSnippet), true);
  assert.equal(normalizeFunctionDefinitionForSemanticCheck(unsafeDefinition).includes(requiredSnippet), false);
});
