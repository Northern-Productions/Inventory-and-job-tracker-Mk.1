import type { Box, BoxStatus, OwnerCompanyEntry, Warehouse } from '../../../../domain';
import { formatOwnerCompanyLabel } from '../../../../domain';
import { filterOfflineBoxes } from '../../../../lib/offlineInventory';

export const NO_OWNER_FILTER_VALUE = '__NO_OWNER__';

const UNKNOWN_OWNER_FILTER_PREFIX = '__UNKNOWN_OWNER_';
const SAFE_RESOLUTION_ERROR_MESSAGE =
  'Owner company identities could not be resolved safely for this report.';

export type OwnershipOwnerState = 'assigned' | 'unassigned' | 'unresolved';

export interface OwnershipReportFilters {
  warehouse: Warehouse | '';
  manufacturer: string;
  filmName: string;
  width: string;
  status: BoxStatus | '';
  q: string;
  ownerCompanyId: string;
}

export interface OwnershipReportOwner {
  groupKey: string;
  filterValue: string;
  displayLabel: string;
  state: OwnershipOwnerState;
  ownerCompanyId: string | null;
  isActive: boolean | null;
}

export interface OwnershipReportRow {
  box: Box;
  owner: OwnershipReportOwner;
}

export interface OwnershipCountSummary {
  key: string;
  label: string;
  count: number;
}

interface ResolvedRegistryOwner {
  ownerCompanyId: string;
  normalizedId: string;
  normalizedCodeKeys: Set<string>;
  displayLabel: string;
  isActive: boolean;
}

interface OwnershipReportReadModel {
  rows: OwnershipReportRow[];
  registryOwners: ResolvedRegistryOwner[];
  unresolvedBoxCount: number;
}

interface DraftOwnerResolution {
  state: OwnershipOwnerState;
  owner: ResolvedRegistryOwner | null;
  unresolvedIdentityKey: string;
}

export class OwnershipReportResolutionError extends Error {
  constructor() {
    super(SAFE_RESOLUTION_ERROR_MESSAGE);
    this.name = 'OwnershipReportResolutionError';
  }
}

function failResolution(): never {
  throw new OwnershipReportResolutionError();
}

function normalizeIdentity(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function compareCanonicalIdentity(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildRegistry(ownerCompanies: OwnerCompanyEntry[]) {
  const byId = new Map<string, ResolvedRegistryOwner>();
  const byCode = new Map<string, ResolvedRegistryOwner>();

  for (const entry of ownerCompanies) {
    const ownerCompanyId = String(entry.ownerCompanyId || '').trim();
    const normalizedId = normalizeIdentity(ownerCompanyId);
    const normalizedCode = normalizeIdentity(entry.code);
    const normalizedLookupKey = normalizeIdentity(entry.lookupKey);
    const displayLabel = formatOwnerCompanyLabel(entry);

    if (
      !ownerCompanyId ||
      !normalizedId ||
      !normalizedCode ||
      !normalizedLookupKey ||
      !displayLabel
    ) {
      failResolution();
    }
    const normalizedCodeKeys = new Set([normalizedCode, normalizedLookupKey]);
    if (
      byId.has(normalizedId) ||
      Array.from(normalizedCodeKeys).some((codeKey) => byCode.has(codeKey))
    ) {
      failResolution();
    }

    const owner: ResolvedRegistryOwner = {
      ownerCompanyId,
      normalizedId,
      normalizedCodeKeys,
      displayLabel: `${displayLabel}${entry.isActive ? '' : ' (inactive)'}`,
      isActive: entry.isActive
    };
    byId.set(normalizedId, owner);
    normalizedCodeKeys.forEach((codeKey) => byCode.set(codeKey, owner));
  }

  return {
    byId,
    byCode,
    owners: Array.from(byId.values())
  };
}

function validateBoxIdentityMappings(boxes: Box[]) {
  const codeById = new Map<string, string>();
  const idByCode = new Map<string, string>();

  for (const box of boxes) {
    const normalizedId = normalizeIdentity(box.ownerCompanyId);
    const normalizedCode = normalizeIdentity(box.ownerCompanyCode);
    const directDisplayName = String(box.ownerCompanyDisplayName || '').trim();

    if (!normalizedId && !normalizedCode) {
      if (directDisplayName) {
        failResolution();
      }
      continue;
    }

    if (!normalizedId || !normalizedCode) {
      continue;
    }

    const existingCode = codeById.get(normalizedId);
    const existingId = idByCode.get(normalizedCode);
    if ((existingCode && existingCode !== normalizedCode) || (existingId && existingId !== normalizedId)) {
      failResolution();
    }
    codeById.set(normalizedId, normalizedCode);
    idByCode.set(normalizedCode, normalizedId);
  }

  return { codeById, idByCode };
}

function resolveDraftOwner(
  box: Box,
  registry: ReturnType<typeof buildRegistry>,
  boxIdentityMappings: ReturnType<typeof validateBoxIdentityMappings>
): DraftOwnerResolution {
  const normalizedId = normalizeIdentity(box.ownerCompanyId);
  const normalizedCode = normalizeIdentity(box.ownerCompanyCode);

  if (!normalizedId && !normalizedCode) {
    return {
      state: 'unassigned',
      owner: null,
      unresolvedIdentityKey: ''
    };
  }

  if (normalizedId) {
    const ownerById = registry.byId.get(normalizedId);
    if (ownerById) {
      if (normalizedCode && !ownerById.normalizedCodeKeys.has(normalizedCode)) {
        failResolution();
      }
      return {
        state: 'assigned',
        owner: ownerById,
        unresolvedIdentityKey: ''
      };
    }

    if (normalizedCode && registry.byCode.has(normalizedCode)) {
      failResolution();
    }

    return {
      state: 'unresolved',
      owner: null,
      unresolvedIdentityKey: `id:${normalizedId}`
    };
  }

  const ownerByCode = registry.byCode.get(normalizedCode);
  if (ownerByCode) {
    return {
      state: 'assigned',
      owner: ownerByCode,
      unresolvedIdentityKey: ''
    };
  }

  return {
    state: 'unresolved',
    owner: null,
    unresolvedIdentityKey: boxIdentityMappings.idByCode.has(normalizedCode)
      ? `id:${boxIdentityMappings.idByCode.get(normalizedCode)}`
      : `code:${normalizedCode}`
  };
}

function buildUnknownOwnerMetadata(drafts: DraftOwnerResolution[]) {
  const identityKeys = Array.from(
    new Set(
      drafts
        .filter((draft) => draft.state === 'unresolved')
        .map((draft) => draft.unresolvedIdentityKey)
    )
  ).sort(compareCanonicalIdentity);

  return new Map(
    identityKeys.map((identityKey, index) => {
      const ordinal = index + 1;
      return [
        identityKey,
        {
          filterValue: `${UNKNOWN_OWNER_FILTER_PREFIX}${ordinal}__`,
          displayLabel: identityKeys.length === 1 ? 'Unknown owner' : `Unknown owner ${ordinal}`
        }
      ];
    })
  );
}

export function buildOwnershipReportReadModel({
  boxes,
  ownerCompanies
}: {
  boxes: Box[];
  ownerCompanies: OwnerCompanyEntry[];
}): OwnershipReportReadModel {
  const registry = buildRegistry(ownerCompanies);
  const boxIdentityMappings = validateBoxIdentityMappings(boxes);
  const drafts = boxes.map((box) => resolveDraftOwner(box, registry, boxIdentityMappings));
  const unknownMetadata = buildUnknownOwnerMetadata(drafts);

  const rows = boxes.map<OwnershipReportRow>((box, index) => {
    const draft = drafts[index];
    if (draft.state === 'assigned' && draft.owner) {
      return {
        box,
        owner: {
          groupKey: draft.owner.ownerCompanyId,
          filterValue: draft.owner.ownerCompanyId,
          displayLabel: draft.owner.displayLabel,
          state: 'assigned',
          ownerCompanyId: draft.owner.ownerCompanyId,
          isActive: draft.owner.isActive
        }
      };
    }

    if (draft.state === 'unassigned') {
      return {
        box,
        owner: {
          groupKey: NO_OWNER_FILTER_VALUE,
          filterValue: NO_OWNER_FILTER_VALUE,
          displayLabel: 'No owner assigned',
          state: 'unassigned',
          ownerCompanyId: null,
          isActive: null
        }
      };
    }

    const unknown = unknownMetadata.get(draft.unresolvedIdentityKey);
    if (!unknown) {
      failResolution();
    }
    return {
      box,
      owner: {
        groupKey: unknown.filterValue,
        filterValue: unknown.filterValue,
        displayLabel: unknown.displayLabel,
        state: 'unresolved',
        ownerCompanyId: null,
        isActive: null
      }
    };
  });

  return {
    rows,
    registryOwners: registry.owners,
    unresolvedBoxCount: drafts.filter((draft) => draft.state === 'unresolved').length
  };
}

function sortSelectOptions(options: Array<{ label: string; value: string }>) {
  return options.slice().sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    return labelOrder || left.value.localeCompare(right.value);
  });
}

export function buildOwnershipOwnerOptions({
  readModel,
  selectedOwnerCompanyId
}: {
  readModel: OwnershipReportReadModel;
  selectedOwnerCompanyId: string;
}) {
  const selectedValue = String(selectedOwnerCompanyId || '').trim();
  const attachedOwnerIds = new Set(
    readModel.rows
      .map((row) => row.owner.ownerCompanyId)
      .filter((ownerCompanyId): ownerCompanyId is string => Boolean(ownerCompanyId))
  );
  const assignedOptions = readModel.registryOwners
    .filter(
      (owner) =>
        owner.isActive ||
        attachedOwnerIds.has(owner.ownerCompanyId) ||
        selectedValue === owner.ownerCompanyId
    )
    .map((owner) => ({ label: owner.displayLabel, value: owner.ownerCompanyId }));
  const unresolvedOptions = Array.from(
    new Map(
      readModel.rows
        .filter((row) => row.owner.state === 'unresolved')
        .map((row) => [
          row.owner.filterValue,
          { label: row.owner.displayLabel, value: row.owner.filterValue }
        ])
    ).values()
  );
  const hasUnassignedRows = readModel.rows.some((row) => row.owner.state === 'unassigned');
  const noOwnerOptions =
    hasUnassignedRows || selectedValue === NO_OWNER_FILTER_VALUE
      ? [{ label: 'No owner assigned', value: NO_OWNER_FILTER_VALUE }]
      : [];

  return [
    { label: 'All Owners', value: '' },
    ...sortSelectOptions([...assignedOptions, ...unresolvedOptions]),
    ...noOwnerOptions
  ];
}

export function filterOwnershipReportRows(
  rows: OwnershipReportRow[],
  filters: OwnershipReportFilters
) {
  const filteredBoxes = new Set(
    filterOfflineBoxes(
      rows.map((row) => row.box),
      {
        warehouse: filters.warehouse,
        manufacturer: filters.manufacturer,
        film: filters.filmName,
        width: filters.width,
        status: filters.status,
        q: filters.q
      }
    )
  );
  const ownerFilterValue = String(filters.ownerCompanyId || '').trim();

  return rows.filter(
    (row) =>
      filteredBoxes.has(row.box) &&
      (!ownerFilterValue || row.owner.filterValue === ownerFilterValue)
  );
}

export function summarizeOwnershipReportRows(rows: OwnershipReportRow[]) {
  const countsByOwner = new Map<string, OwnershipCountSummary>();

  for (const row of rows) {
    const current = countsByOwner.get(row.owner.groupKey);
    countsByOwner.set(row.owner.groupKey, {
      key: row.owner.groupKey,
      label: row.owner.displayLabel,
      count: (current?.count || 0) + 1
    });
  }

  return Array.from(countsByOwner.values()).sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    return labelOrder || left.key.localeCompare(right.key);
  });
}
