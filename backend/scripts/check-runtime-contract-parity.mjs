import {
  collectRuntimeContractParity,
  formatRuntimeContractMismatches,
} from './lib/runtime-contract-parity.mjs';

const parity = collectRuntimeContractParity();

if (parity.mismatches.length || parity.plannerRouteSetParity.mismatches.length) {
  console.error('[contract:parity] parity check failed');
  console.error(formatRuntimeContractMismatches(parity));
  process.exit(1);
}

console.log('[contract:parity] OK');
