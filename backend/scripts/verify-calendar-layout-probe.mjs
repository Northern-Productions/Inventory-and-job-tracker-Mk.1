import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright-core';

const { chromium } = playwright;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const stylesPath = path.join(repoRoot, 'frontend', 'src', 'styles.css');

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));

if (!executablePath) {
  throw new Error('No local Chromium-based browser executable found for the calendar layout probe.');
}

const dateCards = [
  ['2026-05-17', '17', ''],
  ['2026-05-18', '18', '1 job'],
  ['2026-05-19', '19', ''],
  ['2026-05-20', '20', '2 jobs'],
  ['2026-05-21', '21', '1 job'],
  ['2026-05-22', '22', '2 jobs'],
  ['2026-05-23', '23', '']
];

function renderDayCard([dateKey, dayNumber, count], index) {
  const todayClass = dateKey === '2026-05-21' ? ' job-calendar-day-today' : '';
  return `
    <div
      class="job-calendar-day${todayClass}"
      data-day="${dateKey}"
      role="gridcell"
      style="grid-column: ${index + 1} / span 1"
    >
      <div class="job-calendar-day-header">
        <span class="job-calendar-day-number">${dayNumber}</span>
        ${count ? `<span class="job-calendar-day-count">${count}</span>` : ''}
      </div>
    </div>
  `;
}

function renderEvent({ id, column, span, label, staged = false, completed = false, multi = false }) {
  const statusClass = completed ? 'job-calendar-job-link-status-completed' : 'job-calendar-job-link-status-ready';
  const dayClass = multi ? 'job-calendar-event-bar-multi-day' : 'job-calendar-event-bar-single-day';
  return `
    <a
      href="#/allocations/jobs/${id}"
      data-event="${id}"
      class="job-calendar-event-bar ${dayClass} job-calendar-event-bar-range-start job-calendar-event-bar-range-end ${statusClass}"
      style="grid-column: ${column} / span ${span}"
    >
      <span class="job-calendar-event-label">${label}</span>
      ${staged ? '<span class="job-calendar-stage-mark" aria-label="Staged for pickup" title="Staged for pickup">&#10003;</span>' : ''}
    </a>
  `;
}

function buildProbeHtml(css) {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>${css}</style>
        <style>
          body {
            margin: 0;
            background: #eef4f6;
          }

          .calendar-layout-probe {
            width: 1420px;
            margin: 48px auto;
          }
        </style>
      </head>
      <body>
        <main class="calendar-layout-probe">
          <section class="job-calendar">
            <div class="job-calendar-shell">
              <div class="job-calendar-grid job-calendar-grid-week" role="grid" aria-label="May 17 - May 23, 2026">
                <div class="job-calendar-week-row" role="row">
                  <div class="job-calendar-week-days" data-probe-week-days>
                    ${dateCards.map(renderDayCard).join('')}
                    <div class="job-calendar-week-segment-layer">
                      ${renderEvent({
                        id: 'monday-single',
                        column: 2,
                        span: 1,
                        label: 'IL1-19066 / 1',
                        staged: true
                      })}
                      ${renderEvent({
                        id: 'thursday-single',
                        column: 5,
                        span: 1,
                        label: 'IL1-4024 / Section 1 with a very long clipped label'
                      })}
                      ${renderEvent({
                        id: 'wednesday-friday-range',
                        column: 4,
                        span: 3,
                        label: 'IL1-5143 / Phase 2 - Sections 1, 2, 3',
                        multi: true
                      })}
                      ${renderEvent({
                        id: 'friday-completed',
                        column: 6,
                        span: 1,
                        label: 'IL1-4316 / 1',
                        completed: true
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </main>
      </body>
    </html>`;
}

function assertWithin(message, actual, expected, tolerance = 2) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${actual.toFixed(2)} to be within ${tolerance}px of ${expected.toFixed(2)}`);
  }
}

function assertInside(message, inner, outer, tolerance = 2) {
  if (inner.left < outer.left - tolerance || inner.right > outer.right + tolerance) {
    throw new Error(
      `${message}: event [${inner.left.toFixed(2)}, ${inner.right.toFixed(2)}] outside card [${outer.left.toFixed(2)}, ${outer.right.toFixed(2)}]`
    );
  }
}

const css = await readFile(stylesPath, 'utf8');
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.setContent(buildProbeHtml(css), { waitUntil: 'load' });

  const geometry = await page.evaluate(() => {
    const rectOf = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing element for selector ${selector}`);
      }
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      };
    };

    const label = document.querySelector('[data-event="thursday-single"] .job-calendar-event-label');
    const labelStyle = label ? window.getComputedStyle(label) : null;

    return {
      days: {
        sunday: rectOf('[data-day="2026-05-17"]'),
        monday: rectOf('[data-day="2026-05-18"]'),
        wednesday: rectOf('[data-day="2026-05-20"]'),
        thursday: rectOf('[data-day="2026-05-21"]'),
        friday: rectOf('[data-day="2026-05-22"]')
      },
      events: {
        monday: rectOf('[data-event="monday-single"]'),
        thursday: rectOf('[data-event="thursday-single"]'),
        wednesdayFriday: rectOf('[data-event="wednesday-friday-range"]'),
        fridayCompleted: rectOf('[data-event="friday-completed"]')
      },
      stagedMarkCount: document.querySelectorAll('.job-calendar-week-segment-layer .job-calendar-stage-mark').length,
      unstagedHasMark: Boolean(document.querySelector('[data-event="thursday-single"] .job-calendar-stage-mark')),
      completedCount: document.querySelectorAll('.job-calendar-week-segment-layer .job-calendar-job-link-status-completed').length,
      readyCount: document.querySelectorAll('.job-calendar-week-segment-layer .job-calendar-job-link-status-ready').length,
      labelStyle: labelStyle
        ? {
            overflow: labelStyle.overflow,
            textOverflow: labelStyle.textOverflow,
            whiteSpace: labelStyle.whiteSpace
          }
        : null
    };
  });

  assertInside('Monday single-day event is inside Monday card', geometry.events.monday, geometry.days.monday);
  assertInside('Thursday single-day event is inside Thursday card', geometry.events.thursday, geometry.days.thursday);
  assertInside('Friday completed single-day event is inside Friday card', geometry.events.fridayCompleted, geometry.days.friday);
  assertWithin('Multi-day range starts on Wednesday card left edge', geometry.events.wednesdayFriday.left, geometry.days.wednesday.left);
  assertWithin('Multi-day range ends on Friday card right edge', geometry.events.wednesdayFriday.right, geometry.days.friday.right);

  if (geometry.events.monday.left < geometry.days.sunday.left - 2) {
    throw new Error('An event bar rendered left of the first visible day card.');
  }

  if (geometry.stagedMarkCount !== 1) {
    throw new Error(`Expected exactly one staged checkmark, found ${geometry.stagedMarkCount}.`);
  }

  if (geometry.unstagedHasMark) {
    throw new Error('Unstaged event rendered a staged checkmark placeholder.');
  }

  if (geometry.completedCount !== 1 || geometry.readyCount < 1) {
    throw new Error(`Expected completed/open status classes, found completed=${geometry.completedCount}, ready=${geometry.readyCount}.`);
  }

  if (
    geometry.labelStyle?.overflow !== 'hidden' ||
    geometry.labelStyle?.textOverflow !== 'ellipsis' ||
    geometry.labelStyle?.whiteSpace !== 'nowrap'
  ) {
    throw new Error(`Expected ellipsis label styling, found ${JSON.stringify(geometry.labelStyle)}.`);
  }

  console.log('[calendar-layout-probe] ok');
  console.log(
    JSON.stringify(
      {
        mondayEventInsideMondayCard: true,
        thursdayEventInsideThursdayCard: true,
        multiDayWednesdayToFridayAligned: true,
        stagedCheckmarkCount: geometry.stagedMarkCount,
        labelEllipsis: geometry.labelStyle
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
