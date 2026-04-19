import {
  WAREHOUSE_CODES,
  type Box,
  type JobListEntry,
  type SetBoxStatusPayload,
  type Warehouse
} from '../../../../domain';
import type { ConfirmState, TransferDestinationAnalysis } from './types';

export function createStatusConfirmState(
  boxId: string,
  status: SetBoxStatusPayload['status'],
  message: string
): Exclude<ConfirmState, null> {
  return {
    type: status === 'CHECKED_OUT' ? 'checkout' : 'checkin',
    payload: {
      boxId,
      status
    },
    message
  };
}

export function buildTransferDestinationAnalysis(
  box: Box | undefined,
  allocations: Array<{ status: string; jobNumber: string }>,
  allocationJobs: Array<Pick<JobListEntry, 'jobNumber' | 'warehouse'>>,
  allocationQueryState: { isLoading?: boolean; isFetching?: boolean; isError?: boolean }
): TransferDestinationAnalysis {
  if (!box) {
    return {
      suggestedDestination: '',
      conflictMessage: '',
      isResolvingAllocations: false,
      resolutionWarning: ''
    };
  }

  const activeJobAllocations = allocations.filter(
    (entry) => entry.status === 'ACTIVE' && entry.jobNumber.trim()
  );

  if (!activeJobAllocations.length) {
    return {
      suggestedDestination: '',
      conflictMessage: '',
      isResolvingAllocations: false,
      resolutionWarning: ''
    };
  }

  const isResolvingAllocations =
    Boolean(allocationQueryState.isLoading) || Boolean(allocationQueryState.isFetching);

  if (isResolvingAllocations) {
    return {
      suggestedDestination: '',
      conflictMessage: '',
      isResolvingAllocations: true,
      resolutionWarning: ''
    };
  }

  if (allocationQueryState.isError) {
    return {
      suggestedDestination: '',
      conflictMessage: '',
      isResolvingAllocations: false,
      resolutionWarning:
        'Some allocation destinations could not be loaded. You can still try the transfer and the server will verify it.'
    };
  }

  const destinationWarehouseByJobNumber = new Map<string, Warehouse>();
  for (let index = 0; index < allocationJobs.length; index += 1) {
    const entry = allocationJobs[index];
    if (!entry?.jobNumber || !entry?.warehouse) {
      continue;
    }

    destinationWarehouseByJobNumber.set(entry.jobNumber, entry.warehouse);
  }

  const destinationWarehouses = new Set<Warehouse>();
  let hasSameWarehouseAllocation = false;

  for (let index = 0; index < activeJobAllocations.length; index += 1) {
    const destinationWarehouse = destinationWarehouseByJobNumber.get(activeJobAllocations[index].jobNumber.trim());
    if (!destinationWarehouse) {
      continue;
    }

    if (destinationWarehouse === box.warehouse) {
      hasSameWarehouseAllocation = true;
      continue;
    }

    destinationWarehouses.add(destinationWarehouse);
  }

  if (hasSameWarehouseAllocation) {
    return {
      suggestedDestination: '',
      conflictMessage:
        'This box is still allocated to a job in its current warehouse. Remove that allocation before starting a transfer.',
      isResolvingAllocations: false,
      resolutionWarning: ''
    };
  }

  if (destinationWarehouses.size > 1) {
    return {
      suggestedDestination: '',
      conflictMessage:
        'This box is allocated to jobs in more than one destination warehouse. Remove the conflicting allocations before starting a transfer.',
      isResolvingAllocations: false,
      resolutionWarning: ''
    };
  }

  return {
    suggestedDestination: destinationWarehouses.size === 1 ? Array.from(destinationWarehouses)[0] : '',
    conflictMessage: '',
    isResolvingAllocations: false,
    resolutionWarning: ''
  };
}

export async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const didCopy = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!didCopy) {
    throw new Error('Clipboard access is not available.');
  }
}

export async function createBlobFromDataUrl(dataUrl: string) {
  const response = await fetch(dataUrl);
  return response.blob();
}

export function createFallbackBox(boxId: string): Box {
  return {
    boxId,
    warehouse: WAREHOUSE_CODES[0],
    dealer: '',
    manufacturer: '',
    filmName: '',
    widthIn: 36,
    initialFeet: 0,
    feetAvailable: 0,
    allocationPlanningFeet: 0,
    lotRun: '',
    status: 'ORDERED',
    orderDate: '',
    receivedDate: '',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}
