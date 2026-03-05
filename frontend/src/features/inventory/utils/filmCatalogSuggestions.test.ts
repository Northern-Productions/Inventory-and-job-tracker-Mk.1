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
