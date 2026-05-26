import { Button } from '../../../../components/Button';
import { Select } from '../../../../components/Select';
import type { Warehouse } from '../../../../domain';
import { WarehouseSelectField } from '../../components/WarehouseSelectField';
import type { JobSortOption } from '../../utils/jobSorts';
import { JOB_SORT_OPTIONS } from '../../utils/jobSorts';

interface JobsHeroSectionProps {
  jobsViewMode: 'list' | 'calendar';
  warehouseFilter: Warehouse | '';
  isCompletedWorkflow: boolean;
  workflowDescription: string;
  jobSearchInput: string;
  isCalendarView: boolean;
  jobSort: JobSortOption;
  calendarVisibleCount: number;
  listJobsLength: number;
  calendarSummaryCopy: string;
  isSearchingListJobs: boolean;
  workflowSummaryLabel: string;
  onSetJobsViewMode: (view: 'list' | 'calendar') => void;
  onWarehouseFilterChange: (warehouse: Warehouse | '') => void;
  onSetWorkflowView: (view: 'active' | 'completed') => void;
  onJobSearchInputChange: (value: string) => void;
  onSetJobSort: (sort: JobSortOption) => void;
  onOpenNewJob: () => void;
}

export function JobsHeroSection({
  jobsViewMode,
  warehouseFilter,
  isCompletedWorkflow,
  workflowDescription,
  jobSearchInput,
  isCalendarView,
  jobSort,
  calendarVisibleCount,
  listJobsLength,
  calendarSummaryCopy,
  isSearchingListJobs,
  workflowSummaryLabel,
  onSetJobsViewMode,
  onWarehouseFilterChange,
  onSetWorkflowView,
  onJobSearchInputChange,
  onSetJobSort,
  onOpenNewJob
}: JobsHeroSectionProps) {
  return (
    <section className="panel">
      <div className="page-hero-topline">
        <span className="eyebrow">Job Planning</span>
        <div className="jobs-hero-toggle-stack">
          <div className="inventory-view-toggle" role="group" aria-label="Jobs view mode">
            <button
              type="button"
              className={`inventory-view-toggle-button ${jobsViewMode === 'list' ? 'inventory-view-toggle-button-active' : ''}`.trim()}
              onClick={() => onSetJobsViewMode('list')}
              aria-pressed={jobsViewMode === 'list'}
            >
              List
            </button>
            <button
              type="button"
              className={`inventory-view-toggle-button ${jobsViewMode === 'calendar' ? 'inventory-view-toggle-button-active' : ''}`.trim()}
              onClick={() => onSetJobsViewMode('calendar')}
              aria-pressed={jobsViewMode === 'calendar'}
            >
              Calendar
            </button>
          </div>
          <div className="inventory-view-toggle-wrap">
            <div className="inventory-view-toggle" role="group" aria-label="Jobs workflow view">
              <button
                type="button"
                className={`inventory-view-toggle-button ${!isCompletedWorkflow ? 'inventory-view-toggle-button-active' : ''}`.trim()}
                onClick={() => onSetWorkflowView('active')}
                aria-pressed={!isCompletedWorkflow}
              >
                Active workflow
              </button>
              <button
                type="button"
                className={`inventory-view-toggle-button ${isCompletedWorkflow ? 'inventory-view-toggle-button-active' : ''}`.trim()}
                onClick={() => onSetWorkflowView('completed')}
                aria-pressed={isCompletedWorkflow}
              >
                Completed jobs
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="page-hero-title-row">
        <div className="page-hero-copy">
          <h2>Jobs</h2>
          <p className="muted-text">{workflowDescription}</p>
          <div className="jobs-toolbar-grid">
            <WarehouseSelectField
              value={warehouseFilter}
              onChange={onWarehouseFilterChange}
              allowAll
            />
            {!isCalendarView ? (
              <>
              <label className="field jobs-search-field">
                <span className="field-label">Search Job ID Number</span>
                <input
                  className="field-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={jobSearchInput}
                  onChange={(event) => onJobSearchInputChange(event.target.value)}
                  placeholder="Enter job number"
                />
              </label>
              <Select
                label="Sort Jobs"
                className="jobs-sort-select"
                options={JOB_SORT_OPTIONS}
                value={jobSort}
                onChange={(event) => onSetJobSort(event.target.value as JobSortOption)}
              />
              </>
            ) : null}
          </div>
        </div>
        <div className="page-hero-actions">
          <Button type="button" className="button-job-new" size="lg" onClick={onOpenNewJob}>
            New Job +
          </Button>
        </div>
      </div>
      <div className="page-hero-summary inventory-hero-summary">
        <div className="hero-metric">
          <div className="hero-metric-line inventory-summary-line">
            <span className="hero-metric-label">Showing</span>
            <strong className="hero-metric-value inventory-summary-value">
              {isCalendarView ? calendarVisibleCount : listJobsLength}
            </strong>
            <span className="hero-metric-detail hero-metric-inline-copy inventory-summary-copy">
              {isCalendarView
                ? calendarSummaryCopy
                : isSearchingListJobs
                  ? `matching ${workflowSummaryLabel}`
                  : workflowSummaryLabel}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
