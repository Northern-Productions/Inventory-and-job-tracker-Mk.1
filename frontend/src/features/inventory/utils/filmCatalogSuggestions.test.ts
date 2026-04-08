import { describe, expect, it } from 'vitest';
import type { FilmCatalogEntry } from '../../../domain';
import { getFilmNameSuggestions } from './filmCatalogSuggestions';

function catalogEntry(
  manufacturer: string,
  filmName: string,
  filmKey = `${manufacturer.toUpperCase()}|${filmName.toUpperCase()}`
): FilmCatalogEntry {
  return {
    filmKey,
    manufacturer,
    filmName,
    updatedAt: '2026-03-05T12:00:00.000Z'
  };
}

describe('getFilmNameSuggestions', () => {
  it('matches case-insensitively and returns the Madico graffiti film for g/G input', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('Madico', 'Graffiti Free 600 PS SR'),
      catalogEntry('Madico', 'Safety Shield 8'),
      catalogEntry('3M', 'Prestige 40')
    ];

    expect(getFilmNameSuggestions(entries, 'Madico', 'g').map((entry) => entry.filmName)).toEqual([
      'Graffiti Free 600 PS SR'
    ]);
    expect(getFilmNameSuggestions(entries, 'Madico', 'G').map((entry) => entry.filmName)).toEqual([
      'Graffiti Free 600 PS SR'
    ]);
  });

  it('ranks prefix matches before contains and ordered subsequence matches', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('3M', 'Alpha Guard'),
      catalogEntry('3M', 'X Alpha Coat'),
      catalogEntry('3M', 'A L P H A Flex')
    ];

    expect(getFilmNameSuggestions(entries, '3M', 'alpha').map((entry) => entry.filmName)).toEqual([
      'Alpha Guard',
      'X Alpha Coat',
      'A L P H A Flex'
    ]);
  });

  it('constrains suggestions to manufacturer when an exact manufacturer match exists', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('Madico', 'Graffiti Free 600 PS SR'),
      catalogEntry('3M', 'Graffiti Shield 200')
    ];

    expect(getFilmNameSuggestions(entries, 'Madico', 'gra').map((entry) => entry.manufacturer)).toEqual([
      'Madico'
    ]);
  });

  it('falls back to global matches when scoped manufacturer has no text hits', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('3M Solar', 'Night Vision 15'),
      catalogEntry('Security', '3M Ultra Prestige 40'),
      catalogEntry('Security', '3M Ultra Prestige 70')
    ];

    expect(getFilmNameSuggestions(entries, '3M Solar', 'pr').map((entry) => entry.filmName)).toEqual([
      '3M Ultra Prestige 40',
      '3M Ultra Prestige 70'
    ]);
  });

  it('keeps strict manufacturer-first behavior when scoped matches exist', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('3M Solar', 'Prestige Solar 40'),
      catalogEntry('Security', '3M Ultra Prestige 40'),
      catalogEntry('Security', '3M Ultra Prestige 70')
    ];

    expect(getFilmNameSuggestions(entries, '3M Solar', 'pr').map((entry) => entry.filmName)).toEqual([
      'Prestige Solar 40'
    ]);
  });

  it('treats legacy manufacturer aliases as canonical equivalents', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('3M Solar', 'Prestige 40'),
      catalogEntry('3M Fasara', 'Luce')
    ];

    const suggestions = getFilmNameSuggestions(entries, '3M', 'pre');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].manufacturer).toBe('3M Solar');
  });

  it('falls back to global suggestions when manufacturer is blank or unknown', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('Madico', 'Safety Shield'),
      catalogEntry('3M', 'Prestige 40'),
      catalogEntry('Solar Gard', 'Silver 20')
    ];

    expect(getFilmNameSuggestions(entries, '', 'pr').map((entry) => entry.filmName)).toEqual([
      'Prestige 40'
    ]);
    expect(getFilmNameSuggestions(entries, 'Unknown', 'pr').map((entry) => entry.filmName)).toEqual([
      'Prestige 40'
    ]);
  });

  it('caps the results to the requested limit of 3 suggestions', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('3M', 'ProShield 1'),
      catalogEntry('3M', 'ProShield 2'),
      catalogEntry('3M', 'ProShield 3'),
      catalogEntry('3M', 'ProShield 4'),
      catalogEntry('3M', 'ProShield 5')
    ];

    expect(getFilmNameSuggestions(entries, '3M', 'pro').length).toBe(3);
    expect(getFilmNameSuggestions(entries, '3M', 'pro', 2).length).toBe(2);
  });

  it('still applies the result limit during global fallback', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('3M Solar', 'Night Vision 15'),
      catalogEntry('Security', '3M Ultra Prestige 20'),
      catalogEntry('Security', '3M Ultra Prestige 40'),
      catalogEntry('Security', '3M Ultra Prestige 70')
    ];

    const suggestions = getFilmNameSuggestions(entries, '3M Solar', 'pr', 2);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((entry) => entry.filmName)).toEqual([
      '3M Ultra Prestige 20',
      '3M Ultra Prestige 40'
    ]);
  });

  it('normalizes 3M Solar NV variants to Night Vision labels', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('3M Solar', 'NV 15'),
      catalogEntry('3M Solar', 'NV 15 F168325129'),
      catalogEntry('3M Solar', 'Ultra SNV25'),
      catalogEntry('3M Solar', 'Night Vision 25'),
      catalogEntry('3M Solar', 'NV35'),
      catalogEntry('3M Solar', 'Security 3M S35NV')
    ];

    expect(getFilmNameSuggestions(entries, '3M Solar', 'n').map((entry) => entry.filmName)).toEqual([
      'Night Vision 15',
      'Night Vision 25',
      'Night Vision 35'
    ]);
  });

  it('omits deprecated roll-specific film key variants from suggestions', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('3M Solar', 'Prestige 20 Exterior'),
      catalogEntry('3M Solar', 'Prestige 20X 60" F254325')
    ];

    expect(getFilmNameSuggestions(entries, '3M Solar', 'prestige 20').map((entry) => entry.filmName)).toEqual([
      'Prestige 20 Exterior'
    ]);
  });

  it('keeps descriptive Security Madico variants available as distinct suggestions', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('Security', 'Madico Safetyshield 800'),
      catalogEntry('Security', 'Madico Safetyshield 800 Silver 20')
    ];

    expect(getFilmNameSuggestions(entries, 'Security', 'silver').map((entry) => entry.filmName)).toEqual([
      'Madico Safetyshield 800 Silver 20'
    ]);
    expect(getFilmNameSuggestions(entries, 'Security', 'safetyshield 800').map((entry) => entry.filmName)).toEqual([
      'Madico Safetyshield 800',
      'Madico Safetyshield 800 Silver 20'
    ]);
  });

  it('dedupes repeated manufacturer and film-name combinations using the latest entry', () => {
    const entries: FilmCatalogEntry[] = [
      catalogEntry('Madico', 'Graffiti Free 600 PS SR', 'OLD'),
      catalogEntry('  madico  ', '  graffiti   free 600 ps sr ', 'NEW')
    ];

    const suggestions = getFilmNameSuggestions(entries, 'Madico', 'gra');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].filmKey).toBe('NEW');
    expect(suggestions[0].filmName).toBe('graffiti free 600 ps sr');
    expect(suggestions[0].manufacturer).toBe('madico');
  });
});
