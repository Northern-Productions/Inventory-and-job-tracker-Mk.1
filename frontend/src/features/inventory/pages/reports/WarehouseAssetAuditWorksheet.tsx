import type {
  WarehouseAssetAuditResponse,
  WarehouseAssetAuditRow
} from '../../../../domain';

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

export function formatAuditCurrencyCents(cents: string | null) {
  if (cents === null) {
    return 'Missing';
  }
  try {
    const value = BigInt(cents);
    const dollars = value / 100n;
    const remainder = value % 100n;
    return `$${dollars.toLocaleString('en-US')}.${remainder.toString().padStart(2, '0')}`;
  } catch (_error) {
    return 'Invalid';
  }
}

export function formatAuditNumber(value: number) {
  return NUMBER_FORMATTER.format(value);
}

function formatGeneratedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function WarehouseAssetAuditRows({ rows }: { rows: WarehouseAssetAuditRow[] }) {
  return (
    <tbody>
      {rows.map((row) => (
        <tr key={row.boxId} data-audit-row-id={row.boxId}>
          <td className="warehouse-asset-audit-col-box-id">{row.boxId}</td>
          <td className="warehouse-asset-audit-col-owner">{row.ownerCompanyLabel}</td>
          <td className="warehouse-asset-audit-col-custody">{row.warehouse}</td>
          <td className="warehouse-asset-audit-col-status">{row.statusLabel}</td>
          <td className="warehouse-asset-audit-col-manufacturer">{row.manufacturer}</td>
          <td className="warehouse-asset-audit-col-film">{row.filmName}</td>
          <td className="warehouse-asset-audit-col-width">{formatAuditNumber(row.widthIn)}&quot;</td>
          <td className="warehouse-asset-audit-col-on-hand-lf">{formatAuditNumber(row.onHandLf)}</td>
          <td className="warehouse-asset-audit-col-asset-cost">
            {formatAuditCurrencyCents(row.onHandAssetCostCents)}
          </td>
        </tr>
      ))}
    </tbody>
  );
}

export function WarehouseAssetAuditTable({ rows }: { rows: WarehouseAssetAuditRow[] }) {
  return (
    <table className="warehouse-asset-audit-table">
      <colgroup>
        <col className="warehouse-asset-audit-col-box-id" />
        <col className="warehouse-asset-audit-col-owner" />
        <col className="warehouse-asset-audit-col-custody" />
        <col className="warehouse-asset-audit-col-status" />
        <col className="warehouse-asset-audit-col-manufacturer" />
        <col className="warehouse-asset-audit-col-film" />
        <col className="warehouse-asset-audit-col-width" />
        <col className="warehouse-asset-audit-col-on-hand-lf" />
        <col className="warehouse-asset-audit-col-asset-cost" />
      </colgroup>
      <thead>
        <tr>
          <th className="warehouse-asset-audit-col-box-id" scope="col">
            Box ID
          </th>
          <th className="warehouse-asset-audit-col-owner" scope="col">
            Owner
          </th>
          <th className="warehouse-asset-audit-col-custody" scope="col">
            Warehouse
          </th>
          <th className="warehouse-asset-audit-col-status" scope="col">
            Status
          </th>
          <th className="warehouse-asset-audit-col-manufacturer" scope="col">
            Manufacturer
          </th>
          <th className="warehouse-asset-audit-col-film" scope="col">
            Film
          </th>
          <th className="warehouse-asset-audit-col-width" scope="col">
            Width
          </th>
          <th className="warehouse-asset-audit-col-on-hand-lf" scope="col">
            On-Hand LF
          </th>
          <th className="warehouse-asset-audit-col-asset-cost" scope="col">
            On-Hand Asset Cost
          </th>
        </tr>
      </thead>
      <WarehouseAssetAuditRows rows={rows} />
    </table>
  );
}

export function WarehouseAssetAuditTotals({
  snapshot,
  className = ''
}: {
  snapshot: WarehouseAssetAuditResponse;
  className?: string;
}) {
  return (
    <div className={`warehouse-asset-audit-totals ${className}`.trim()} data-audit-totals>
      <div>
        <span>Matching Boxes</span>
        <strong>{snapshot.totals.matchingBoxes.toLocaleString()}</strong>
      </div>
      <div>
        <span>Total On-Hand LF</span>
        <strong>{formatAuditNumber(snapshot.totals.totalOnHandLf)}</strong>
      </div>
      <div>
        <span>Total Known On-Hand Asset Cost</span>
        <strong>{formatAuditCurrencyCents(snapshot.totals.totalKnownOnHandAssetCostCents)}</strong>
      </div>
      <div>
        <span>Boxes Missing Cost Basis</span>
        <strong>{snapshot.totals.boxesMissingCostBasis.toLocaleString()}</strong>
      </div>
      <p className="warehouse-asset-audit-cost-note">
        Known asset total excludes boxes with unavailable cost basis.
      </p>
    </div>
  );
}

export function WarehouseAssetAuditWorksheet({ snapshot }: { snapshot: WarehouseAssetAuditResponse }) {
  const filters = snapshot.appliedFilterLabels;
  return (
    <article
      className="warehouse-asset-audit-worksheet"
      data-audit-print-snapshot={snapshot.metadata.generatedAt}
      data-audit-expected-row-count={snapshot.rows.length}
    >
      <header className="warehouse-asset-audit-print-header">
        <div>
          <h1>Warehouse Asset Audit</h1>
          <strong>{snapshot.metadata.organizationName}</strong>
        </div>
        <dl>
          <div>
            <dt>Generated</dt>
            <dd>{formatGeneratedAt(snapshot.metadata.generatedAt)}</dd>
          </div>
          <div>
            <dt>Generated by</dt>
            <dd>{snapshot.metadata.generatedBy}</dd>
          </div>
        </dl>
      </header>
      <div className="warehouse-asset-audit-print-filters" aria-label="Applied audit filters">
        <span><strong>Warehouse:</strong> {filters.warehouse}</span>
        <span><strong>Owner:</strong> {filters.owner}</span>
        <span><strong>Manufacturer:</strong> {filters.manufacturer}</span>
        <span><strong>Film:</strong> {filters.filmName}</span>
        <span><strong>Width:</strong> {filters.width}</span>
        <span><strong>Status:</strong> {filters.statuses.join(', ')}</span>
        <span><strong>Search:</strong> {filters.search}</span>
      </div>
      <WarehouseAssetAuditTotals snapshot={snapshot} className="warehouse-asset-audit-print-summary" />
      <WarehouseAssetAuditTable rows={snapshot.rows} />
      <WarehouseAssetAuditTotals snapshot={snapshot} className="warehouse-asset-audit-print-footer" />
    </article>
  );
}
