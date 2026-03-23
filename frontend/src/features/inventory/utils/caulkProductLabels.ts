function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCaulkProductName(manufacturer: string, productName: string) {
  const trimmedManufacturer = manufacturer.trim();
  const trimmedProductName = productName.trim();

  if (!trimmedManufacturer || !trimmedProductName) {
    return trimmedProductName;
  }

  return trimmedProductName
    .replace(new RegExp(`^${escapeRegExp(trimmedManufacturer)}\\s+`, 'i'), '')
    .trim();
}

export function buildCaulkProductLabel(
  manufacturer: string,
  productName: string,
  productCode: string
) {
  const title = [manufacturer.trim(), normalizeCaulkProductName(manufacturer, productName)]
    .filter(Boolean)
    .join(' ')
    .trim();

  return productCode ? `${title} (${productCode})` : title;
}
