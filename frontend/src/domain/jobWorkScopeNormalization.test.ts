import { describe, expect, it } from 'vitest';
import {
  BLANK_WORK_SCOPE_KEY,
  normalizeJobSectionsDisplay,
  normalizeJobSectionsKey,
  normalizeJobWorkScopeDisplay,
  normalizeJobWorkScopeKey
} from './jobWorkScopeNormalization.mjs';

describe('jobWorkScopeNormalization', () => {
  it('normalizes blank work scope display values to null and blank keys', () => {
    expect(normalizeJobWorkScopeDisplay(null)).toBeNull();
    expect(normalizeJobWorkScopeDisplay(undefined)).toBeNull();
    expect(normalizeJobWorkScopeDisplay('')).toBeNull();
    expect(normalizeJobWorkScopeDisplay('   \t  \n ')).toBeNull();

    expect(normalizeJobWorkScopeKey(null)).toBe(BLANK_WORK_SCOPE_KEY);
    expect(normalizeJobWorkScopeKey(undefined)).toBe(BLANK_WORK_SCOPE_KEY);
    expect(normalizeJobWorkScopeKey('')).toBe(BLANK_WORK_SCOPE_KEY);
    expect(normalizeJobWorkScopeKey('   \t  \n ')).toBe(BLANK_WORK_SCOPE_KEY);
  });

  it('preserves display casing and punctuation while collapsing whitespace', () => {
    expect(normalizeJobWorkScopeDisplay('  Lobby   Phase,   North  ')).toBe('Lobby Phase, North');
    expect(normalizeJobWorkScopeKey('  Lobby   Phase,   North  ')).toBe('text:lobby phase,north');
  });

  it('normalizes casing differences and comma spacing in free text keys', () => {
    expect(normalizeJobWorkScopeKey('Lobby, North')).toBe('text:lobby,north');
    expect(normalizeJobWorkScopeKey('  LOBBY ,   north  ')).toBe('text:lobby,north');
  });

  it('normalizes section prefixes and numeric section lists to stable keys', () => {
    expect(normalizeJobWorkScopeKey('Section 1')).toBe('section:1');
    expect(normalizeJobWorkScopeKey('Sections 01')).toBe('section:1');
    expect(normalizeJobWorkScopeKey('sec. 001')).toBe('section:1');
    expect(normalizeJobWorkScopeKey('secs 1')).toBe('section:1');
  });

  it('sorts equivalent section lists regardless of order or separators', () => {
    expect(normalizeJobWorkScopeKey('1, 2')).toBe('section:1,2');
    expect(normalizeJobWorkScopeKey('2,1')).toBe('section:1,2');
    expect(normalizeJobWorkScopeKey('section 1 and 2')).toBe('section:1,2');
    expect(normalizeJobWorkScopeKey('section 2; 1 & 02')).toBe('section:1,2');
  });

  it('deduplicates repeated section numbers', () => {
    expect(normalizeJobWorkScopeKey('Sections 1, 01, 2, 2')).toBe('section:1,2');
  });

  it('keeps mixed work scope text out of pure section-list normalization', () => {
    expect(normalizeJobWorkScopeKey('Section 1 Lobby')).toBe('text:section 1 lobby');
    expect(normalizeJobWorkScopeKey('Lobby 1 and 2')).toBe('text:lobby 1 and 2');
    expect(normalizeJobWorkScopeKey('Phase 2, Section 1')).toBe('text:phase 2,section 1');
  });

  it('keeps legacy sections aliases compatible with work scope normalization', () => {
    expect(normalizeJobSectionsDisplay('  Sections   4,  5  ')).toBe('Sections 4, 5');
    expect(normalizeJobSectionsKey('  Sections   4,  5  ')).toBe('section:4,5');
  });
});
