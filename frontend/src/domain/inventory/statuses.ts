import {
  ALLOCATION_JOB_STATUSES as RUNTIME_ALLOCATION_JOB_STATUSES,
  ALLOCATION_SOURCES as RUNTIME_ALLOCATION_SOURCES,
  BOX_STATUSES as RUNTIME_BOX_STATUSES,
  FILM_ORDER_STATUSES as RUNTIME_FILM_ORDER_STATUSES,
  JOB_STATUSES as RUNTIME_JOB_STATUSES
} from '../runtimeContract.mjs';

export const BOX_STATUSES = [...RUNTIME_BOX_STATUSES] as const;
export type BoxStatus = (typeof BOX_STATUSES)[number];
export const BOX_TRANSFER_STATUSES = ['PENDING', 'RECEIVED', 'CANCELLED'] as const;
export type BoxTransferStatus = (typeof BOX_TRANSFER_STATUSES)[number];
export const CAULK_TRANSFER_STATUSES = ['PENDING', 'RECEIVED', 'CANCELLED'] as const;
export type CaulkTransferStatus = (typeof CAULK_TRANSFER_STATUSES)[number];
export const CORE_TYPES = [
  'White plastic',
  'Red plastic',
  'Cardboard 1/8"',
  'Cardboard 3/8"',
  'SECURITY 1/4" Cardboard',
  'SECURITY White plastic 3/8"'
] as const;
export type CoreType = (typeof CORE_TYPES)[number];
export type BoxCoreType = CoreType | '';
export const ALLOCATION_STATUSES = ['ACTIVE', 'FULFILLED', 'CANCELLED'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];
export const ALLOCATION_KINDS = ['REQUIREMENT', 'EXTRA'] as const;
export type AllocationKind = (typeof ALLOCATION_KINDS)[number];
export const ALLOCATION_SOURCES = [...RUNTIME_ALLOCATION_SOURCES] as const;
export type AllocationSource = (typeof ALLOCATION_SOURCES)[number];
export const FILM_ORDER_STATUSES = [...RUNTIME_FILM_ORDER_STATUSES] as const;
export type FilmOrderStatus = (typeof FILM_ORDER_STATUSES)[number];
export const ALLOCATION_JOB_STATUSES = [...RUNTIME_ALLOCATION_JOB_STATUSES] as const;
export type AllocationJobStatus = (typeof ALLOCATION_JOB_STATUSES)[number];
export const JOB_STATUSES = [...RUNTIME_JOB_STATUSES] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
