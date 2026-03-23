import type { CaulkProductEntry } from '../../../domain';

function normalizeValue(value: string) {
  return value.trim().toLowerCase();
}

export function getPreferredCaulkProductId(entries: CaulkProductEntry[]) {
  const exactDow995Black = entries.find((entry) => {
    const manufacturer = normalizeValue(entry.manufacturer);
    const productName = normalizeValue(entry.productName);
    const productCode = normalizeValue(entry.productCode);

    return (
      manufacturer === 'dow' &&
      productCode === 'dow-995' &&
      productName.includes('995 black') &&
      !productName.includes('cart')
    );
  });

  if (exactDow995Black) {
    return exactDow995Black.productId;
  }

  return entries[0]?.productId || '';
}
