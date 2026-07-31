function asText(value) {
  return String(value ?? '').trim();
}

function upperText(value) {
  return asText(value).toUpperCase();
}

function boxLabel(box) {
  return asText(box?.boxId) || 'This box';
}

function isPendingTransfer(pendingTransfer) {
  return upperText(pendingTransfer?.status) === 'PENDING';
}

function getFilmBoxAllocationEligibility(box, pendingTransfer, jobWarehouse, options = {}) {
  const status = upperText(box?.status);
  const boxWarehouse = upperText(box?.warehouse);
  const destinationWarehouse = upperText(jobWarehouse);
  const allowTransferAssist = options?.allowTransferAssist !== false;
  const hasReservations = options?.hasReservations === true;

  if (status === 'TRANSFER' || isPendingTransfer(pendingTransfer)) {
    return {
      eligible: false,
      requiresTransfer: false,
      reason: `${boxLabel(box)} has a pending transfer and is not physically available until receipt.`
    };
  }

  if (!destinationWarehouse || !boxWarehouse || boxWarehouse === destinationWarehouse) {
    const eligible = status === 'IN_STOCK' || status === 'ORDERED' || status === 'CHECKED_OUT';
    return {
      eligible,
      requiresTransfer: false,
      reason: eligible ? '' : `${boxLabel(box)} is not in an allocatable state.`
    };
  }

  if (!allowTransferAssist) {
    return {
      eligible: false,
      requiresTransfer: false,
      reason: `${boxLabel(box)} must be received at ${destinationWarehouse} before this allocation mode can use it.`
    };
  }

  if (status !== 'IN_STOCK') {
    return {
      eligible: false,
      requiresTransfer: false,
      reason: `${boxLabel(box)} must be in stock before a transfer-assisted allocation can begin.`
    };
  }

  if (hasReservations) {
    return {
      eligible: false,
      requiresTransfer: false,
      reason: `${boxLabel(box)} already has reserved film and cannot begin a transfer-assisted allocation.`
    };
  }

  return {
    eligible: true,
    requiresTransfer: true,
    reason: ''
  };
}

export {
  getFilmBoxAllocationEligibility,
  isPendingTransfer
};
