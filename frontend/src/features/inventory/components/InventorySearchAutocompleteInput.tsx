import { useEffect, useId, useState } from 'react';
import type { InventorySearchSuggestion } from '../utils/inventorySearchSuggestions';

interface InventorySearchAutocompleteInputProps {
  label: string;
  value: string;
  suggestions: InventorySearchSuggestion[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function InventorySearchAutocompleteInput({
  label,
  value,
  suggestions,
  placeholder,
  disabled = false,
  onChange
}: InventorySearchAutocompleteInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [lockedSuggestionLength, setLockedSuggestionLength] = useState<number | null>(null);
  const listboxId = useId();
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

  const selectSuggestion = (entry: InventorySearchSuggestion) => {
    setLockedSuggestionLength(entry.boxId.length);
    onChange(entry.boxId);
    setIsOpen(false);
    setHighlightedIndex(-1);
  };

  const handleArrowDown = () => {
    if (!suggestions.length) {
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
    if (!suggestions.length) {
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
      <div className="film-name-autocomplete inventory-search-autocomplete">
        <input
          className="field-input"
          value={value}
          disabled={disabled}
          autoComplete="off"
          placeholder={placeholder}
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
                  key={entry.boxId}
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
                  <span>{entry.boxId}</span>
                  <small>{entry.manufacturer} {entry.filmName}</small>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </label>
  );
}
