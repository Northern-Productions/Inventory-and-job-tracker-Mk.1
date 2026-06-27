import { describe, expect, it } from 'vitest';
import { formatOwnerCompanyLabel } from './ownership';

describe('formatOwnerCompanyLabel', () => {
  it('shows one value when code and display name match case-insensitively', () => {
    expect(formatOwnerCompanyLabel({ code: 'MGT', displayName: 'MGT' })).toBe('MGT');
    expect(formatOwnerCompanyLabel({ code: 'mgt', displayName: 'MGT' })).toBe('mgt');
  });

  it('combines code and display name when both are useful', () => {
    expect(formatOwnerCompanyLabel({ code: 'MGT', displayName: 'Management Group' })).toBe(
      'MGT - Management Group'
    );
  });

  it('falls back safely when code or display name is missing', () => {
    expect(formatOwnerCompanyLabel({ code: 'EDH', displayName: '' })).toBe('EDH');
    expect(formatOwnerCompanyLabel({ code: '', displayName: 'Example Display Name' })).toBe(
      'Example Display Name'
    );
    expect(formatOwnerCompanyLabel()).toBe('');
  });
});
