import { describe, expect, it } from 'vitest';
import {
  canonicalizeManufacturerLabel,
  normalizeManufacturerLookupKey
} from './manufacturerCanonicalization';

describe('manufacturer canonicalization', () => {
  it('maps legacy aliases to canonical labels', () => {
    expect(canonicalizeManufacturerLabel('3M')).toBe('3M Solar');
    expect(canonicalizeManufacturerLabel('Fasara')).toBe('3M Fasara');
    expect(canonicalizeManufacturerLabel('Avery')).toBe('Avery Dennison');
    expect(canonicalizeManufacturerLabel('Solar Guard')).toBe('Solar Gard');
  });

  it('preserves non-aliased labels including 3M Fasara', () => {
    expect(canonicalizeManufacturerLabel('3M Fasara')).toBe('3M Fasara');
    expect(canonicalizeManufacturerLabel('Llumar')).toBe('Llumar');
  });

  it('normalizes lookup keys case-insensitively', () => {
    expect(normalizeManufacturerLookupKey('  solar   guard ')).toBe('solar gard');
    expect(normalizeManufacturerLookupKey('3M')).toBe('3m solar');
  });
});
