import { useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { Select } from '../../../components/Select';
import { useToast } from '../../../components/Toast';
import { listCaulkProducts } from '../../../api/features/caulkClient';
import type { JobLifecycleFilter } from '../../../api/features/jobsClient';
import type { CreateJobPayload } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { useAuth } from '../../auth/AuthContext';
import { JobEditorDialog, type JobEditorSubmitPayload } from '../components/JobEditorDialog';
import { useCreateJob, useFilmCatalog, useJobsList, useJobsSearch } from '../hooks/useInventoryQueries';
import {
  getJobListDisplayStatus,
  JOB_SORT_OPTIONS,
  sortJobs,
  type JobSortOption
} from '../utils/jobSorts';

function formatStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

type AllocationsPageProps = {
  initialWorkflowView?: 'active' | 'completed';
  initialJobSearchInput?: string;
  initialJobSort?: JobSortOption;
};

export default function AllocationsPage({
  initialWorkflowView = 'active',
  initialJobSearchInput = '',
  initialJobSort = 'install_date'
}: AllocationsPageProps = {}) {
  const navigate = useNavigate();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const [jobsWorkflowView, setJobsWorkflowView] = useState<'active' | 'completed'>(
    initialWorkflowView
  );
  const selectedLifecycleStatus: JobLifecycleFilter =
    jobsWorkflowView === 'completed' ? 'COMPLETED' : 'ACTIVE';
  const jobsQuery = useJobsList(25, { lifecycleStatus: selectedLifecycleStatus });
  const [jobSearchInput, setJobSearchInput] = useState(initialJobSearchInput);
  const [jobSort, setJobSort] = useState<JobSortOption>(initialJobSort);
  const deferredJobSearchInput = useDeferredValue(jobSearchInput);
  const isSearchingJobs = Boolean(deferredJobSearchInput.trim());
  const jobsSearchQuery = useJobsSearch(deferredJobSearchInput, 25, {
    enabled: isSearchingJobs,
    lifecycleStatus: selectedLifecycleStatus
  });
  const createJobMutation = useCreateJob();
  const filmCatalogQuery = useFilmCatalog();
  const caulkProductsQuery = useQuery({
    queryKey: ['caulk', 'products'],
    queryFn: () => listCaulkProducts()
  });
  const [isNewJobOpen, setIsNewJobOpen] = useState(false);
  const isCompletedWorkflow = jobsWorkflowView === 'completed';
  const jobsSource = isSearchingJobs ? jobsSearchQuery.data || [] : jobsQuery.data || [];
  const jobs = useMemo(
    () =>
      sortJobs(
        isCompletedWorkflow
          ? jobsSource.filter((entry) => entry.status === 'COMPLETED')
          : jobsSource,
        jobSort
      ),
    [isCompletedWorkflow, jobsSource, jobSort]
  );
  const jobsLoading = isSearchingJobs ? jobsSearchQuery.isLoading : jobsQuery.isLoading;
  const jobsError = isSearchingJobs ? jobsSearchQuery.error : jobsQuery.error;
  const showJobsLoading = jobsLoading && !jobs.length;
  const workflowSummaryLabel = isCompletedWorkflow ? 'completed jobs' : 'active jobs';
  const workflowTitle = isCompletedWorkflow ? 'Completed Job History' : 'Recent Jobs';
  const workflowDescription = isCompletedWorkflow
    ? 'Showing completed job history (up to 25).'
    : 'Showing active jobs only (up to 25).';
  const jobsLoadingLabel = isSearchingJobs
    ? `Searching ${workflowSummaryLabel}...`
    : `Loading ${workflowSummaryLabel}...`;
  const jobsEmptyState = isSearchingJobs
    ? `No ${workflowSummaryLabel} match ${deferredJobSearchInput}.`
    : isCompletedWorkflow
      ? 'No completed job history yet.'
      : 'No active jobs found yet.';

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
      setIsNewJobOpen(false);
      const destination = `/allocations/${encodeURIComponent(payload.jobNumber)}`;
      const savePromise = createJobMutation.mutateAsync(payload);
      navigate(destination);
      const { result } = await savePromise;
      navigate(`/allocations/${encodeURIComponent(result.summary.jobNumber)}`, { replace: true });
    } catch (error) {
      navigate('/allocations', { replace: true });
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
          <div className="inventory-view-toggle-wrap">
            <div className="inventory-view-toggle" role="group" aria-label="Jobs workflow view">
              <button
                type="button"
                className={`inventory-view-toggle-button ${!isCompletedWorkflow ? 'inventory-view-toggle-button-active' : ''}`.trim()}
                onClick={() => setJobsWorkflowView('active')}
                aria-pressed={!isCompletedWorkflow}
              >
                Active workflow
              </button>
              <button
                type="button"
                className={`inventory-view-toggle-button ${isCompletedWorkflow ? 'inventory-view-toggle-button-active' : ''}`.trim()}
                onClick={() => setJobsWorkflowView('completed')}
                aria-pressed={isCompletedWorkflow}
              >
                Completed jobs
              </button>
            </div>
          </div>
        </div>
        <div className="page-hero-title-row">
          <div className="page-hero-copy">
            <h2>Jobs</h2>
            <p className="muted-text">{workflowDescription}</p>
            <div className="jobs-toolbar-grid">
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
              <Select
                label="Sort Jobs"
                className="jobs-sort-select"
                options={JOB_SORT_OPTIONS}
                value={jobSort}
                onChange={(event) => setJobSort(event.target.value as JobSortOption)}
              />
            </div>
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
                {isSearchingJobs ? `matching ${workflowSummaryLabel}` : workflowSummaryLabel}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row allocations-recent-title-row">
          <h2>{workflowTitle}</h2>
          <span className="muted-text allocations-recent-count">{jobs.length} job(s)</span>
        </div>
        <DeferredLoadingState when={showJobsLoading} label={jobsLoadingLabel} />
        {jobsError ? (
          <p className="error-text">
            {jobsError instanceof Error ? jobsError.message : 'Jobs could not be loaded.'}
          </p>
        ) : null}
        {!showJobsLoading && !jobsError && !jobs.length ? (
          <div className="empty-state">{jobsEmptyState}</div>
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
