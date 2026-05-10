import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLANK_WORK_SCOPE_KEY,
  normalizeJobSectionsDisplay,
  normalizeJobSectionsKey,
  normalizeJobWorkScopeDisplay,
  normalizeJobWorkScopeKey,
} from '../../../shared/domain/jobWorkScopeNormalization.mjs';

test('work scope display normalization preserves user-facing text while removing unsafe whitespace', () => {
  assert.equal(normalizeJobWorkScopeDisplay(null), null);
  assert.equal(normalizeJobWorkScopeDisplay(undefined), null);
  assert.equal(normalizeJobWorkScopeDisplay('   '), null);
  assert.equal(normalizeJobWorkScopeDisplay('  Sections   4,  5  '), 'Sections 4, 5');
});

test('work scope key normalization produces stable keys for blank, free text, and sections', () => {
  assert.equal(normalizeJobWorkScopeKey(''), BLANK_WORK_SCOPE_KEY);
  assert.equal(normalizeJobWorkScopeKey('LOBBY ,  North'), 'text:lobby,north');
  assert.equal(normalizeJobWorkScopeKey('Section 1'), 'section:1');
  assert.equal(normalizeJobWorkScopeKey('Sections 01'), 'section:1');
  assert.equal(normalizeJobWorkScopeKey('2,1'), 'section:1,2');
  assert.equal(normalizeJobWorkScopeKey('section 1 and 2'), 'section:1,2');
  assert.equal(normalizeJobWorkScopeKey('Sections 1, 01, 2, 2'), 'section:1,2');
  assert.equal(normalizeJobWorkScopeKey('Section 1 Lobby'), 'text:section 1 lobby');
});

test('legacy sections aliases share work scope display and key semantics', () => {
  assert.equal(normalizeJobSectionsDisplay(' Sections 01 '), 'Sections 01');
  assert.equal(normalizeJobSectionsKey(' Sections 01 '), 'section:1');
});
