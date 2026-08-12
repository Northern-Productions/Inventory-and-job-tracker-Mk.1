import { execFileSync } from 'node:child_process';

const DEFAULT_BASE_REF = 'origin/main';
const DEFAULT_HEAD_REF = 'HEAD';

const FRONTEND_WORKFLOW_PATTERN =
  /(allocation|allocations|job|jobs|film[-_]?order|filmorders|caulk|label|labels|scan|scanner|checkout|check[-_]?out|checkin|check[-_]?in|inventory|box|boxes)/i;
const MATERIAL_FLOW_PATTERN =
  /(allocation|allocations|planner|caulk|checkin|check[-_]?in|checkout|check[-_]?out|material|inventory|ownership|film[-_]?order|filmorders|receive|box|boxes|transfer|staged[-_]?pickup)/i;

export function normalizeChangedFile(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

export function dedupeChangedFiles(files = []) {
  return [...new Set(files.map(normalizeChangedFile).filter(Boolean))].sort();
}

function isDocsOrToolingFile(filePath) {
  if (
    filePath === 'AGENTS.md' ||
    filePath === '.gitignore' ||
    filePath.startsWith('docs/') ||
    filePath.startsWith('.github/') ||
    filePath.startsWith('scripts/')
  ) {
    return true;
  }

  if (
    filePath === 'backend/package.json' ||
    filePath === 'backend/scripts/codex-task-refresh.mjs' ||
    filePath === 'backend/scripts/codex-classify-changes.mjs' ||
    filePath === 'backend/scripts/repo-doctor.mjs' ||
    filePath === 'backend/scripts/release-doctor.mjs' ||
    filePath === 'backend/scripts/migration-registry.mjs' ||
    filePath.startsWith('backend/scripts/lib/codex-change-classifier') ||
    filePath.startsWith('backend/scripts/lib/migration-registry') ||
    filePath.startsWith('backend/scripts/lib/repo-doctor')
  ) {
    return true;
  }

  return false;
}

function isFrontendFile(filePath) {
  return filePath.startsWith('frontend/src/') || filePath.startsWith('frontend/tests/') || filePath.startsWith('frontend/playwright');
}

function isBackendRuntimeFile(filePath) {
  return filePath.startsWith('backend/src/') || filePath === 'backend/server.mjs';
}

function isEdgeOrSharedFile(filePath) {
  return (
    filePath.startsWith('supabase/functions/') ||
    filePath.startsWith('shared/domain/') ||
    filePath.startsWith('backend/shared/domain/')
  );
}

function isMigrationOrSchemaFile(filePath) {
  return (
    filePath.startsWith('backend/migrations/') ||
    filePath.startsWith('supabase/migrations/') ||
    filePath === 'backend/scripts/check-schema-latest.mjs' ||
    filePath === 'backend/scripts/check-schema-0006.mjs'
  );
}

function isFrontendVisualFile(filePath) {
  return (
    filePath === 'frontend/src/styles.css' ||
    /\.(css|scss)$/.test(filePath) ||
    /(__tests__|test)\.(tsx?|jsx?)$/.test(filePath)
  );
}

function isMaterialFlowFile(filePath) {
  if (filePath.startsWith('docs/')) {
    return false;
  }
  return MATERIAL_FLOW_PATTERN.test(filePath);
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function pushCommonChecks(checks) {
  checks.push('git diff --check');
  checks.push('git diff --cached --check if anything is staged');
}

function buildChecks(flags) {
  const checks = [];
  pushCommonChecks(checks);

  if (flags.docsToolingOnly) {
    checks.push('node --check for new or changed Node tooling scripts');
    checks.push('targeted node --test for new or changed tooling helpers');
    return unique(checks);
  }

  if (flags.frontend) {
    checks.push('targeted frontend tests for touched components or routes');
    checks.push('npm --prefix frontend run test');
    checks.push('npm --prefix frontend run build');
  }

  if (flags.frontendWorkflow) {
    checks.push('authenticated DEV browser verification when the workflow is protected or mutation-like');
  }

  if (flags.backendRuntime) {
    checks.push('targeted backend tests for touched services or routes');
    checks.push('npm --prefix backend run test:unit');
  }

  if (flags.edgeOrShared) {
    checks.push('npm --prefix backend run edge:test');
    checks.push('npm --prefix backend run contract:parity');
  }

  if (flags.migrationOrSchema) {
    checks.push('migration mirror/parity check for backend and Supabase migrations');
    checks.push('npm --prefix backend run check:schema:latest after guarded local/DEV migration readiness');
  }

  if (flags.materialFlow) {
    checks.push('read docs/material-flow-rules.md before implementation');
    checks.push('DEV fixture workflow verification after target guard');
    checks.push('browser/API/database before-after verification for mutation paths');
  }

  return unique(checks);
}

function buildReleaseActions(flags) {
  const actions = [];
  if (flags.frontend) {
    actions.push('Vercel production deployment/verification expected on release');
  }
  if (flags.edgeOrShared) {
    actions.push('Supabase Edge/API deploy decision required on release');
  }
  if (flags.migrationOrSchema) {
    actions.push('approved PROD migration plan required on release');
  }
  if (flags.backendRuntime && !flags.edgeOrShared) {
    actions.push('local backend runtime verification required; Edge deploy only if shared/API surface changed');
  }
  if (flags.docsToolingOnly) {
    actions.push('no runtime deploy expected');
  }
  return unique(actions);
}

function buildStopConditions(flags) {
  const conditions = [
    'target environment is ambiguous',
    'a command would print secrets or raw env values',
    'a command would mutate PROD data without explicit release approval'
  ];
  if (flags.migrationOrSchema) {
    conditions.push('migration history or schema state is unexpected');
  }
  if (flags.edgeOrShared) {
    conditions.push('Edge/API target project ref cannot be verified');
  }
  if (flags.materialFlow) {
    conditions.push('safe DEV fixture verification path is unavailable for mutation behavior');
    conditions.push('requested behavior conflicts with docs/material-flow-rules.md');
  }
  return unique(conditions);
}

function describeTaskType(flags) {
  if (flags.docsToolingOnly) {
    return 'docs/tooling';
  }
  const labels = [];
  if (flags.frontend) {
    labels.push(flags.frontendWorkflow ? 'frontend-workflow' : 'frontend-only');
  }
  if (flags.backendRuntime) {
    labels.push('backend-local');
  }
  if (flags.edgeOrShared) {
    labels.push('Edge/shared');
  }
  if (flags.migrationOrSchema) {
    labels.push('migration/schema');
  }
  if (flags.materialFlow) {
    labels.push('material-flow/high-risk');
  }
  if (!labels.length) {
    labels.push('mixed/tooling');
  }
  return unique(labels).join(' + ');
}

function determineTier(flags) {
  if (flags.materialFlow) {
    return 6;
  }
  if (flags.migrationOrSchema) {
    return 5;
  }
  if (flags.edgeOrShared) {
    return 4;
  }
  if (flags.backendRuntime) {
    return 3;
  }
  if (flags.frontendWorkflow) {
    return 2;
  }
  if (flags.frontend) {
    return 1;
  }
  return 0;
}

export function classifyChangedFiles(files = []) {
  const changedFiles = dedupeChangedFiles(files);
  const hasFiles = changedFiles.length > 0;
  const flags = {
    hasFiles,
    docsTooling: changedFiles.some(isDocsOrToolingFile),
    frontend: changedFiles.some(isFrontendFile),
    frontendVisual: changedFiles.some((filePath) => isFrontendFile(filePath) && isFrontendVisualFile(filePath)),
    frontendWorkflow: changedFiles.some((filePath) => isFrontendFile(filePath) && FRONTEND_WORKFLOW_PATTERN.test(filePath)),
    backendRuntime: changedFiles.some(isBackendRuntimeFile),
    edgeOrShared: changedFiles.some(isEdgeOrSharedFile),
    migrationOrSchema: changedFiles.some(isMigrationOrSchemaFile),
    materialFlow: changedFiles.some((filePath) => isMaterialFlowFile(filePath) && !isDocsOrToolingFile(filePath))
  };
  flags.docsToolingOnly = hasFiles && changedFiles.every(isDocsOrToolingFile);
  flags.mixed = hasFiles && !flags.docsToolingOnly && [
    flags.frontend,
    flags.backendRuntime,
    flags.edgeOrShared,
    flags.migrationOrSchema,
    flags.docsTooling
  ].filter(Boolean).length > 1;

  const tier = determineTier(flags);
  const taskType = hasFiles ? describeTaskType(flags) : 'no-local-changes';

  return {
    changedFiles,
    tier,
    tierLabel: `Tier ${tier}`,
    taskType,
    flags,
    requiredChecks: buildChecks(flags),
    likelyReleaseActions: buildReleaseActions(flags),
    stopConditions: buildStopConditions(flags)
  };
}

export function getChangedFiles({ base = DEFAULT_BASE_REF, head = DEFAULT_HEAD_REF, cwd = process.cwd() } = {}) {
  const args = ['diff', '--name-only', `${base}...${head}`];
  let diffFiles;
  try {
    const output = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    diffFiles = output.split(/\r?\n/);
  } catch (_error) {
    const fallbackArgs = ['diff', '--name-only', `${base}..${head}`];
    const output = execFileSync('git', fallbackArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    diffFiles = output.split(/\r?\n/);
  }
  return dedupeChangedFiles([...diffFiles, ...getWorkingTreeChangedFiles(cwd)]);
}

function getWorkingTreeChangedFiles(cwd) {
  const output = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return output
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return '';
      }
      const pathPart = trimmed.slice(2).trim();
      const renameParts = pathPart.split(' -> ');
      return renameParts[renameParts.length - 1];
    })
    .filter(Boolean);
}

export function getRepoRoot(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

export function formatClassificationReport(report, { base = DEFAULT_BASE_REF, head = DEFAULT_HEAD_REF } = {}) {
  const lines = [
    '[codex-classify]',
    `base: ${base}`,
    `head: ${head}`,
    `changedFiles: ${report.changedFiles.length}`,
    `taskType: ${report.taskType}`,
    `tier: ${report.tierLabel}`,
    `flags: ${Object.entries(report.flags)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .join(', ') || '<none>'}`
  ];

  if (report.changedFiles.length) {
    lines.push('files:');
    for (const filePath of report.changedFiles) {
      lines.push(`  - ${filePath}`);
    }
  }

  lines.push('requiredChecks:');
  for (const check of report.requiredChecks) {
    lines.push(`  - ${check}`);
  }

  lines.push('likelyReleaseActions:');
  for (const action of report.likelyReleaseActions.length ? report.likelyReleaseActions : ['none detected']) {
    lines.push(`  - ${action}`);
  }

  lines.push('stopConditions:');
  for (const condition of report.stopConditions) {
    lines.push(`  - ${condition}`);
  }

  return lines.join('\n');
}
