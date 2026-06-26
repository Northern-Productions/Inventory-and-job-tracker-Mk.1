import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBox } from '../../../api/features/inventoryClient';
import { getJobs } from '../../../api/features/jobsClient';
import type { Box, JobListEntry } from '../../../domain';
import { QrScanner } from '../components/QrScanner';
import { buildAllocationJobRoute } from '../utils/jobRoutes';

function normalizeText(value: unknown) {
  return String(value || '').trim();
}

function normalizeJobNumberKey(value: unknown) {
  return normalizeText(value).toUpperCase();
}

function getCanonicalScanRoute(rawValue: string) {
  const normalized = normalizeText(rawValue);
  if (!normalized) {
    return '';
  }

  let routeCandidate = '';
  if (normalized.startsWith('#/')) {
    routeCandidate = normalized.slice(1);
  } else if (normalized.startsWith('/')) {
    routeCandidate = normalized;
  } else {
    try {
      const url = new URL(normalized);
      if (url.hash.startsWith('#/')) {
        routeCandidate = url.hash.slice(1);
      } else if (url.pathname.startsWith('/allocations/')) {
        routeCandidate = `${url.pathname}${url.search}`;
      }
    } catch (_error) {
      return '';
    }
  }

  if (!routeCandidate.startsWith('/allocations/')) {
    return '';
  }

  const [pathPart, queryPart = ''] = routeCandidate.split('?', 2);
  const params = new URLSearchParams(queryPart);
  if (params.get('scanAction') !== 'checkin' || !normalizeText(params.get('boxId'))) {
    return '';
  }

  if (pathPart.startsWith('/allocations/jobs/') || pathPart.startsWith('/allocations/')) {
    return routeCandidate;
  }

  return '';
}

function buildCheckinRouteForBox(box: Pick<Box, 'boxId' | 'lastCheckoutJobId' | 'lastCheckoutJob'>) {
  const checkoutJobId = normalizeText(box.lastCheckoutJobId);
  if (!checkoutJobId) {
    return '';
  }

  const params = new URLSearchParams({
    scanAction: 'checkin',
    boxId: box.boxId
  });
  return `${buildAllocationJobRoute({
    jobId: checkoutJobId,
    jobNumber: box.lastCheckoutJob
  })}?${params.toString()}`;
}

function findExactCheckoutJobCandidates(jobNumber: string, jobs: JobListEntry[]) {
  const checkoutJobKey = normalizeJobNumberKey(jobNumber);
  if (!checkoutJobKey) {
    return [];
  }

  return (jobs || []).filter((entry) => normalizeJobNumberKey(entry.jobNumber) === checkoutJobKey);
}

async function resolveCheckinRouteFromJobNumber(box: Pick<Box, 'boxId' | 'lastCheckoutJob'>) {
  const checkoutJobNumber = normalizeText(box.lastCheckoutJob);
  if (!checkoutJobNumber) {
    return {
      route: '',
      notice: 'checkout-job-unknown'
    };
  }

  let jobs: JobListEntry[] = [];
  try {
    jobs = await getJobs(0, { jobNumbers: [checkoutJobNumber] });
  } catch (_error) {
    return {
      route: '',
      notice: 'checkout-job-unresolved'
    };
  }

  const exactCandidates = findExactCheckoutJobCandidates(checkoutJobNumber, jobs);
  if (exactCandidates.length !== 1) {
    return {
      route: '',
      notice: exactCandidates.length > 1 ? 'checkout-job-ambiguous' : 'checkout-job-unresolved'
    };
  }

  const candidate = exactCandidates[0];
  const params = new URLSearchParams({
    scanAction: 'checkin',
    boxId: box.boxId
  });
  return {
    route: `${buildAllocationJobRoute({
      jobId: candidate.jobId,
      jobNumber: candidate.jobNumber
    })}?${params.toString()}`,
    notice: ''
  };
}

async function resolveCheckedOutBoxScan(box: Box) {
  const canonicalRoute = buildCheckinRouteForBox(box);
  if (canonicalRoute) {
    return {
      route: canonicalRoute,
      notice: ''
    };
  }

  return resolveCheckinRouteFromJobNumber(box);
}

function buildBoxDetailsScanNoticeRoute(boxId: string, notice: string) {
  const params = new URLSearchParams({
    scanNotice: notice || 'checkout-job-unknown'
  });
  return `/inventory/${encodeURIComponent(boxId)}?${params.toString()}`;
}

export default function QrScanPage() {
  const navigate = useNavigate();
  const [lookupError, setLookupError] = useState('');

  const goToBox = useCallback(
    async (scanValue: string) => {
      const canonicalRoute = getCanonicalScanRoute(scanValue);
      if (canonicalRoute) {
        navigate(canonicalRoute);
        return true;
      }

      const normalizedBoxId = scanValue.trim();
      if (!normalizedBoxId) {
        return false;
      }

      setLookupError('');

      try {
        const box = await getBox(normalizedBoxId);
        let target = `/inventory/${encodeURIComponent(box.boxId)}`;
        if (box.status === 'CHECKED_OUT') {
          const resolved = await resolveCheckedOutBoxScan(box);
          target = resolved.route || buildBoxDetailsScanNoticeRoute(box.boxId, resolved.notice);
        }
        navigate(target);
        return true;
      } catch (_error) {
        setLookupError(`Box ${normalizedBoxId} was not found.`);
        return false;
      }
    },
    [navigate]
  );

  return (
    <>
      <section className="panel scan-page-header">
        <span className="eyebrow">Scan Workflow</span>
        <h2 className="scan-page-heading">Scan And Open Boxes</h2>
      </section>
      <div className="scan-workspace">
        <QrScanner onResolved={goToBox} />
        {lookupError ? <p className="error-text scan-lookup-error">{lookupError}</p> : null}
      </div>
    </>
  );
}
