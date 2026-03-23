import { useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { LoadingState } from '../../../components/LoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useToast } from '../../../components/Toast';
import { listCaulkProducts } from '../../../api/features/caulkClient';
import type { CreateJobPayload } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { useAuth } from '../../auth/AuthContext';
import { JobEditorDialog, type JobEditorSubmitPayload } from '../components/JobEditorDialog';
import { useCreateJob, useFilmCatalog, useJobsList, useJobsSearch } from '../hooks/useInventoryQueries';

function formatStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

function getJobListDisplayStatus(status: string, filmOrderCount: number) {
  if (status === 'ALLOCATE' && filmOrderCount > 0) {
    return 'FILM_ORDER';
  }

  return status;
}

export default function AllocationsPage() {
  const navigate = useNavigate();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const jobsQuery = useJobsList(25);
  const [jobSearchInput, setJobSearchInput] = useState('');
  const deferredJobSearchInput = useDeferredValue(jobSearchInput);
  const isSearchingJobs = Boolean(deferredJobSearchInput.trim());
  const jobsSearchQuery = useJobsSearch(deferredJobSearchInput, 25, { enabled: isSearchingJobs });
  const createJobMutation = useCreateJob();
  const filmCatalogQuery = useFilmCatalog();
  const caulkProductsQuery = useQuery({
    queryKey: ['caulk', 'products'],
    queryFn: () => listCaulkProducts()
  });
  const [isNewJobOpen, setIsNewJobOpen] = useState(false);
  const activeJobs = useMemo(
    () => (jobsQuery.data || []).filter((entry) => entry.lifecycleStatus === 'ACTIVE'),
    [jobsQuery.data]
  );
  const jobs = useMemo(
    () =>
      isSearchingJobs
        ? (jobsSearchQuery.data || []).filter((entry) => entry.lifecycleStatus === 'ACTIVE')
        : activeJobs,
    [activeJobs, isSearchingJobs, jobsSearchQuery.data]
  );
  const jobsLoading = isSearchingJobs ? jobsSearchQuery.isLoading : jobsQuery.isLoading;
  const jobsError = isSearchingJobs ? jobsSearchQuery.error : jobsQuery.error;

  async function handleCreateJob(submitPayload: JobEditorSubmitPayload) {
    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before creating jobs.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before creating a job.',
        variant: 'error'
      });
      return;
    }

    const payload: CreateJobPayload = {
      jobNumber: submitPayload.jobNumber,
      warehouse: submitPayload.warehouse,
      sections: submitPayload.sections,
      dueDate: submitPayload.dueDate,
      crewLeader: submitPayload.crewLeader,
      requirements: submitPayload.requirements,
      caulkRequirements: submitPayload.caulkRequirements
    };

    try {
      const { result, warnings } = await createJobMutation.mutateAsync(payload);
      setIsNewJobOpen(false);
      toast.push({
        title: `Saved job ${result.summary.jobNumber}`,
        description: warnings.join(' ') || `Job ${result.summary.jobNumber} is ready for allocation.`,
        variant: 'success'
      });
      navigate(`/allocations/${encodeURIComponent(result.summary.jobNumber)}`);
    } catch (error) {
      toast.push({
        title: 'Unable to save job',
        description: error instanceof Error ? error.message : 'The job could not be saved.',
        variant: 'error'
      });
    }
  }

  return (
    <>
      <section className="panel">
        <div className="page-hero-topline">
          <span className="eyebrow">Job Planning</span>
          <span className="muted-text">
            {isSearchingJobs ? 'Search mode' : 'Active workflow'}
          </span>
        </div>
        <div className="page-hero-title-row">
          <div className="page-hero-copy">
            <h2>Jobs</h2>
            <p className="muted-text">
              Showing active jobs only (up to 25), sorted by install date.
            </p>
            <label className="field jobs-search-field">
              <span className="field-label">Search Job ID Number</span>
              <input
                className="field-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={jobSearchInput}
                onChange={(event) => setJobSearchInput(event.target.value.replace(/[^0-9]/g, ''))}
                placeholder="Enter job number"
              />
            </label>
          </div>
          <div className="page-hero-actions">
            <Button
              type="button"
              className="button-job-new"
              size="lg"
              onClick={() => setIsNewJobOpen(true)}
            >
              New Job +
            </Button>
          </div>
        </div>
        <div className="page-hero-summary inventory-hero-summary">
          <div className="hero-metric">
            <div className="hero-metric-line inventory-summary-line">
              <span className="hero-metric-label">Showing</span>
              <strong className="hero-metric-value inventory-summary-value">{jobs.length}</strong>
              <span className="hero-metric-detail hero-metric-inline-copy inventory-summary-copy">
                {isSearchingJobs ? 'matching jobs' : 'active jobs'}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row allocations-recent-title-row">
          <h2>Recent Jobs</h2>
          <span className="muted-text allocations-recent-count">{jobs.length} job(s)</span>
        </div>
        {jobsLoading ? <LoadingState label={isSearchingJobs ? 'Searching jobs...' : 'Loading jobs...'} /> : null}
        {jobsError ? (
          <p className="error-text">
            {jobsError instanceof Error ? jobsError.message : 'Jobs could not be loaded.'}
          </p>
        ) : null}
        {!jobsLoading && !jobsError && !jobs.length ? (
          <div className="empty-state">
            {isSearchingJobs
              ? `No active jobs match ${deferredJobSearchInput}.`
              : 'No jobs found yet.'}
          </div>
        ) : null}
        {jobs.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {jobs.map((entry) => {
                const displayStatus = getJobListDisplayStatus(entry.status, entry.filmOrderCount);
                return (
                  <MobileRecordCard key={entry.jobNumber}>
                    <MobileRecordHeader
                      title={entry.jobNumber}
                      subtitle={`${entry.warehouse} warehouse`}
                      badge={<span className={`badge badge-${displayStatus}`}>{formatStatusLabel(displayStatus)}</span>}
                      onTitleClick={() => navigate(`/allocations/${encodeURIComponent(entry.jobNumber)}`)}
                    />
                    <MobileFieldList>
                      <MobileField label="Install Date" value={formatDate(entry.dueDate)} />
                      <MobileField label="Sections" value={entry.sections ?? '--'} />
                      <MobileField label="Required LF" value={entry.requiredFeet} />
                      <MobileField label="Allocated LF" value={entry.allocatedFeet} />
                      <MobileField label="Remaining LF" value={entry.remainingFeet} />
                    </MobileFieldList>
                  </MobileRecordCard>
                );
              })}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Install Date</th>
                    <th>Sections</th>
                    <th>Warehouse</th>
                    <th>Status</th>
                    <th>Required LF</th>
                    <th>Allocated LF</th>
                    <th>Remaining LF</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((entry) => {
                    const displayStatus = getJobListDisplayStatus(entry.status, entry.filmOrderCount);
                    return (
                      <tr key={entry.jobNumber}>
                        <td>
                          <button
                            type="button"
                            className="row-button"
                            onClick={() => navigate(`/allocations/${encodeURIComponent(entry.jobNumber)}`)}
                          >
                            {entry.jobNumber}
                          </button>
                        </td>
                        <td>{formatDate(entry.dueDate)}</td>
                        <td>{entry.sections ?? '--'}</td>
                        <td>{entry.warehouse}</td>
                        <td>
                          <span className={`badge badge-${displayStatus}`}>{formatStatusLabel(displayStatus)}</span>
                        </td>
                        <td>{entry.requiredFeet}</td>
                        <td>{entry.allocatedFeet}</td>
                        <td>{entry.remainingFeet}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>

      <JobEditorDialog
        open={isNewJobOpen}
        mode="create"
        title="New Job"
        submitLabel="Save Job"
        submitting={createJobMutation.isPending}
        filmCatalogEntries={filmCatalogQuery.data}
        filmCatalogLoading={filmCatalogQuery.isLoading}
        filmCatalogError={filmCatalogQuery.error}
        caulkProductEntries={caulkProductsQuery.data}
        caulkProductLoading={caulkProductsQuery.isLoading}
        caulkProductError={caulkProductsQuery.error}
        onCancel={() => setIsNewJobOpen(false)}
        onSubmit={(payload) => void handleCreateJob(payload)}
      />
    </>
  );
}
