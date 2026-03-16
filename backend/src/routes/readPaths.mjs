// Purpose: Shared route metadata for routes treated as reads.
import { READ_PATHS as CONTRACT_READ_PATHS } from '../../../frontend/src/domain/runtimeContract.mjs';

export const READ_PATHS = new Set(CONTRACT_READ_PATHS);
