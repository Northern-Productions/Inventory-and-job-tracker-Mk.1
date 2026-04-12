export interface TransferredBoxIdDescriptor {
  currentPrefix: string;
  localSegments: string[];
  originPrefix: string;
  extraSegments: string[];
  isTransferred: boolean;
}

export function describeTransferredBoxId(
  boxId: unknown,
  currentPrefix: unknown,
  warehousePrefixes?: unknown[]
): TransferredBoxIdDescriptor;

export function buildTransferredBoxId(
  boxId: unknown,
  sourcePrefix: unknown,
  destinationPrefix: unknown,
  warehousePrefixes?: unknown[]
): string;

export function planTransferredBoxId(
  boxId: unknown,
  sourcePrefix: unknown,
  destinationPrefix: unknown,
  warehousePrefixes?: unknown[],
  destinationBoxIdOverride?: unknown
): string;
