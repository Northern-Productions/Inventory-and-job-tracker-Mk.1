import { useMemo, useState } from 'react';
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
import type { CreateJobPayload } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { useAuth } from '../../auth/AuthContext';
import { JobEditorDialog, type JobEditorSubmitPayload } from '../components/JobEditorDialog';
import { useCreateJob, useFilmCatalog, useJobsList } from '../hooks/useInventoryQueries';

function formatStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

export default function AllocationsPage() {
  const navigate = useNavigate();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const jobsQuery = useJobsList(25);
  const createJobMutation = useCreateJob();
  const filmCatalogQuery = useFilmCatalog();
  const [isNewJobOpen, setIsNewJobOpen] = useState(false);
  const jobs = useMemo(() => jobsQuery.data || [], [jobsQuery.data]);

  async function handleCreateJob(submitPayload: JobEditorSubmitPayload) {
    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Google sign-in is not configured',
        description: 'Set VITE_GOOGLE_CLIENT_ID before creating jobs.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with Google before creating a job.',
        variant: 'error'
      });
      return;
    }

    const payload: CreateJobPayload = {
      jobNumber: submitPayload.jobNumber,
      warehouse: submitPayload.warehouse,
      sections: submitPayload.sections,
      dueDate: submitPayload.dueDate,
      requirements: submitPayload.requirements
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
        <div className="panel-title-row">
          <div>
            <h2>Jobs</h2>
            <p className="muted-text">
              Showing the 25 most recent jobs by due date (newest first).
            </p>
          </div>
          <Button
            type="button"
            className="button-job-new"
            onClick={() => setIsNewJobOpen(true)}
          >
            New Job +
          </Button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Recent Jobs</h2>
          <span className="muted-text">{jobs.length} job(s)</span>
        </div>
        {jobsQuery.isLoading ? <LoadingState label="Loading jobs..." /> : null}
        {jobsQuery.isError ? <p className="error-text">{jobsQuery.error.message}</p> : null}
        {!jobsQuery.isLoading && !jobsQuery.isError && !jobs.length ? (
          <div className="empty-state">No jobs found yet.</div>
        ) : null}
        {jobs.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {jobs.map((entry) => (
                <MobileRecordCard key={entry.jobNumber}>
                  <MobileRecordHeader
                    title={entry.jobNumber}
                    subtitle={`${entry.warehouse} warehouse`}
                    badge={<span className={`badge badge-${entry.status}`}>{formatStatusLabel(entry.status)}</span>}
                    onTitleClick={() => navigate(`/allocations/${encodeURIComponent(entry.jobNumber)}`)}
                  />
                  <MobileFieldList>
                    <MobileField label="Due Date" value={formatDate(entry.dueDate)} />
                    <MobileField label="Sections" value={entry.sections ?? '--'} />
                    <MobileField label="Required LF" value={entry.requiredFeet} />
                    <MobileField label="Allocated LF" value={entry.allocatedFeet} />
                    <MobileField label="Remaining LF" value={entry.remainingFeet} />
                  </MobileFieldList>
                </MobileRecordCard>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Due Date</th>
                    <th>Sections</th>
                    <th>Warehouse</th>
                    <th>Status</th>
                    <th>Required LF</th>
                    <th>Allocated LF</th>
                    <th>Remaining LF</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((entry) => (
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
                        <span className={`badge badge-${entry.status}`}>{formatStatusLabel(entry.status)}</span>
                      </td>
                      <td>{entry.requiredFeet}</td>
                      <td>{entry.allocatedFeet}</td>
                      <td>{entry.remainingFeet}</td>
                    </tr>
                  ))}
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
        onCancel={() => setIsNewJobOpen(false)}
        onSubmit={(payload) => void handleCreateJob(payload)}
      />
    </>
  );
}

