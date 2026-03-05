import { useEffect, useId, useMemo, useState } from 'react';
import type { FilmCatalogEntry } from '../../../domain';
import { getFilmNameSuggestions } from '../utils/filmCatalogSuggestions';

export interface FilmNameAutocompleteInputProps {
  label: string;
  value: string;
  manufacturer: string;
  catalogEntries?: FilmCatalogEntry[];
  catalogLoading?: boolean;
  catalogError?: unknown;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}

export function FilmNameAutocompleteInput({
  label,
  value,
  manufacturer,
  catalogEntries,
  catalogLoading = false,
  catalogError,
  required,
  disabled,
  autoFocus,
  onChange
}: FilmNameAutocompleteInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [lockedSuggestionLength, setLockedSuggestionLength] = useState<number | null>(null);
  const listboxId = useId();
  const hasCatalogError = Boolean(catalogError);
  const suggestions = useMemo(
    () => getFilmNameSuggestions(catalogEntries, manufacturer, value, 3),
    [catalogEntries, manufacturer, value]
  );
  const isSuggestionLocked =
    lockedSuggestionLength !== null && value.length === lockedSuggestionLength;

  useEffect(() => {
    if (!isFocused || !value.trim() || suggestions.length === 0 || isSuggestionLocked) {
      setIsOpen(false);
      setHighlightedIndex(-1);
      return;
    }

    setIsOpen(true);
    setHighlightedIndex((current) => (current >= suggestions.length ? suggestions.length - 1 : current));
  }, [isFocused, isSuggestionLocked, suggestions, value]);

  const selectSuggestion = (entry: FilmCatalogEntry) => {
    setLockedSuggestionLength(entry.filmName.length);
    onChange(entry.filmName);
    setIsOpen(false);
    setHighlightedIndex(-1);
  };

  const handleArrowDown = () => {
    if (suggestions.length === 0) {
      return;
    }

    setIsOpen(true);
    setHighlightedIndex((current) => {
      if (current < 0) {
        return 0;
      }

      return (current + 1) % suggestions.length;
    });
  };

  const handleArrowUp = () => {
    if (suggestions.length === 0) {
      return;
    }

    setIsOpen(true);
    setHighlightedIndex((current) => {
      if (current < 0) {
        return suggestions.length - 1;
      }

      return (current - 1 + suggestions.length) % suggestions.length;
    });
  };

  const activeOptionId =
    isOpen && highlightedIndex >= 0 && highlightedIndex < suggestions.length
      ? `${listboxId}-option-${highlightedIndex}`
      : undefined;

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="film-name-autocomplete">
        <input
          className="field-input"
          value={value}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen && suggestions.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false);
            setIsOpen(false);
            setHighlightedIndex(-1);
          }}
          onChange={(event) => {
            const nextValue = event.target.value;
            onChange(nextValue);
            if (lockedSuggestionLength !== null && nextValue.length !== lockedSuggestionLength) {
              setLockedSuggestionLength(null);
            }
            setHighlightedIndex(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              handleArrowDown();
              return;
            }

            if (event.key === 'ArrowUp') {
              event.preventDefault();
              handleArrowUp();
              return;
            }

            if (event.key === 'Enter' && isOpen && highlightedIndex >= 0) {
              event.preventDefault();
              selectSuggestion(suggestions[highlightedIndex]);
              return;
            }

            if (event.key === 'Escape') {
              setIsOpen(false);
              setHighlightedIndex(-1);
            }
          }}
        />
        {isOpen && suggestions.length > 0 ? (
          <ul id={listboxId} className="film-name-autocomplete-menu" role="listbox">
            {suggestions.map((entry, index) => {
              const isActive = highlightedIndex === index;
              return (
                <li
                  key={`${entry.manufacturer}|${entry.filmName}`}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={isActive}
                  className={`film-name-autocomplete-option ${isActive ? 'film-name-autocomplete-option-active' : ''}`.trim()}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectSuggestion(entry);
                  }}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span>{entry.filmName}</span>
                  <small>{entry.manufacturer}</small>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {hasCatalogError ? (
        <span className="field-hint">Film catalog unavailable; continue typing manually.</span>
      ) : null}
      {catalogLoading ? <span className="field-hint">Loading film catalog...</span> : null}
    </label>
  );
}
