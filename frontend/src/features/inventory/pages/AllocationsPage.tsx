import { JobEditorDialog } from '../components/JobEditorDialog';
import { LaborOnlyJobConfirmDialog } from '../components/LaborOnlyJobConfirmDialog';
import { DuplicateJobCreationDialog } from '../components/DuplicateJobCreationDialog';
import { JobsHeroSection } from './allocations-page/JobsHeroSection';
import { JobsResultsSection } from './allocations-page/JobsResultsSection';
import { useAllocationsPageModel } from './allocations-page/useAllocationsPageModel';

type AllocationsPageProps = {
  initialWorkflowView?: 'active' | 'completed';
  initialJobsViewMode?: 'list' | 'calendar';
  initialCalendarGranularity?: 'week' | 'month';
  initialJobSearchInput?: string;
  initialJobSort?: import('../utils/jobSorts').JobSortOption;
  initialCalendarAnchorDate?: string;
  initialCalendarMonth?: string;
};

export default function AllocationsPage(props: AllocationsPageProps = {}) {
  const {
    filmCatalogQuery,
    caulkProductsQuery,
    jobCreationWorkflow,
    calendarWorkflow,
    jobsViewMode,
    setJobsViewMode,
    isCompletedWorkflow,
    isCalendarView,
    jobSearchInput,
    jobSort,
    setJobSort,
    listJobs,
    listJobsLoading,
    listJobsError,
    workflowSummaryLabel,
    workflowTitle,
    workflowDescription,
    calendarPeriodLabel,
    calendarPeriodPreposition,
    jobsLoadingLabel,
    jobsEmptyState,
    calendarSummaryCopy,
    calendarEmptyState,
    isSearchingListJobs,
    isPhoneLayout,
    calendarGranularity,
    calendarAnchorDate,
    setJobsWorkflowView,
    handleJobSearchInputChange,
    handleCalendarSearchSubmit,
    handlePrefetchJob,
    handleOpenJob
  } = useAllocationsPageModel(props);

  return (
    <>
      <JobsHeroSection
        jobsViewMode={jobsViewMode}
        isCompletedWorkflow={isCompletedWorkflow}
        workflowDescription={workflowDescription}
        jobSearchInput={jobSearchInput}
        isCalendarView={isCalendarView}
        jobSort={jobSort}
        isCalendarSearchPending={calendarWorkflow.isCalendarSearchPending}
        calendarVisibleCount={calendarWorkflow.calendarVisibleCount}
        listJobsLength={listJobs.length}
        calendarSummaryCopy={calendarSummaryCopy}
        isSearchingListJobs={isSearchingListJobs}
        workflowSummaryLabel={workflowSummaryLabel}
        onSetJobsViewMode={setJobsViewMode}
        onSetWorkflowView={setJobsWorkflowView}
        onJobSearchInputChange={handleJobSearchInputChange}
        onSubmitCalendarSearch={handleCalendarSearchSubmit}
        onSetJobSort={setJobSort}
        onOpenNewJob={() => jobCreationWorkflow.setIsNewJobOpen(true)}
      />

      <JobsResultsSection
        isCalendarView={isCalendarView}
        workflowTitle={workflowTitle}
        calendarVisibleCount={calendarWorkflow.calendarVisibleCount}
        listJobsLength={listJobs.length}
        calendarPeriodPreposition={calendarPeriodPreposition}
        calendarPeriodLabel={calendarPeriodLabel}
        listJobsLoading={listJobsLoading}
        jobsLoadingLabel={jobsLoadingLabel}
        calendarLoading={calendarWorkflow.calendarLoading}
        workflowSummaryLabel={workflowSummaryLabel}
        displayedCalendarGranularity={calendarWorkflow.displayedCalendarGranularity}
        listJobsError={listJobsError}
        calendarError={calendarWorkflow.calendarError}
        jobsEmptyState={jobsEmptyState}
        listJobs={listJobs}
        isPhoneLayout={isPhoneLayout}
        calendarJobs={calendarWorkflow.calendarJobs}
        calendarEmptyState={calendarEmptyState}
        displayedCalendarAnchorDate={calendarWorkflow.displayedCalendarAnchorDate}
        visibleCalendarTargetJobNumber={calendarWorkflow.visibleCalendarTargetJobNumber}
        visibleCalendarTargetDate={calendarWorkflow.visibleCalendarTargetDate}
        calendarTargetNavigationToken={calendarWorkflow.calendarTargetNavigationToken}
        calendarGranularity={calendarGranularity}
        calendarAnchorDate={calendarAnchorDate}
        calendarNavigationStatus={calendarWorkflow.calendarNavigationStatus}
        calendarTransitionToken={calendarWorkflow.calendarTransitionToken}
        onOpenJob={handleOpenJob}
        onPrefetchJob={handlePrefetchJob}
        onViewChange={calendarWorkflow.requestCalendarGranularity}
        onAnchorDateChange={calendarWorkflow.requestCalendarAnchorDate}
      />

      <JobEditorDialog
        open={jobCreationWorkflow.isNewJobOpen}
        mode="create"
        title="New Job"
        submitLabel="Save Job"
        submitting={jobCreationWorkflow.isCreateSubmitting}
        filmCatalogEntries={filmCatalogQuery.data}
        filmCatalogLoading={filmCatalogQuery.isLoading}
        filmCatalogError={filmCatalogQuery.error}
        caulkProductEntries={caulkProductsQuery.data}
        caulkProductLoading={caulkProductsQuery.isLoading}
        caulkProductError={caulkProductsQuery.error}
        onCancel={() => jobCreationWorkflow.setIsNewJobOpen(false)}
        onSubmit={(payload) => void jobCreationWorkflow.handleCreateJob(payload)}
      />

      <LaborOnlyJobConfirmDialog
        open={Boolean(jobCreationWorkflow.pendingLaborOnlyCreate)}
        jobNumber={jobCreationWorkflow.pendingLaborOnlyCreate?.jobNumber || ''}
        pending={jobCreationWorkflow.isCreateSubmitting}
        onCancel={() => jobCreationWorkflow.setPendingLaborOnlyCreate(null)}
        onConfirmLaborOnly={jobCreationWorkflow.confirmLaborOnlyCreate}
      />

      <DuplicateJobCreationDialog
        open={Boolean(jobCreationWorkflow.duplicateJobPrompt)}
        duplicate={jobCreationWorkflow.duplicateJobPrompt?.duplicate || null}
        job={jobCreationWorkflow.duplicateJobPrompt?.job || null}
        onEditNewJob={jobCreationWorkflow.dismissDuplicateJobPrompt}
        onGoToJob={jobCreationWorkflow.goToDuplicateJob}
      />
    </>
  );
}
