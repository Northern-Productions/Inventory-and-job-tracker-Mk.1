import type { BoxDealerEntry } from '../../../../domain';

export const ADD_NEW_DEALER_OPTION = '__add_new_dealer__';

export function buildDealerOptions(dealerEntries?: BoxDealerEntry[]) {
  return Array.from(
    new Set(
      (dealerEntries || [])
        .map((entry) => String(entry.name || '').trim())
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));
}

export function resolveDealerFieldState(
  dealerValue: string,
  dealerOptions: string[],
  isAddingCustomDealer: boolean
) {
  const normalizedDealer = dealerValue.trim();
  const isKnownDealer = dealerOptions.includes(normalizedDealer);
  const isCustomDealerSelected = isAddingCustomDealer || (Boolean(normalizedDealer) && !isKnownDealer);

  return {
    isCustomDealerSelected,
    dealerSelectValue: isCustomDealerSelected ? ADD_NEW_DEALER_OPTION : normalizedDealer
  };
}

export function applyDealerSelectValue(
  selectedValue: string,
  currentDealer: string,
  dealerOptions: string[]
) {
  if (selectedValue === ADD_NEW_DEALER_OPTION) {
    return {
      dealer: dealerOptions.includes(currentDealer.trim()) ? '' : currentDealer,
      isAddingCustomDealer: true
    };
  }

  return {
    dealer: selectedValue,
    isAddingCustomDealer: false
  };
}
