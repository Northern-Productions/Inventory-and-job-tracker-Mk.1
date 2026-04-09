import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const SCAN_ROOTS = ['frontend/src', 'backend/src', 'supabase/functions'];

const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'build',
  '.next'
]);

const INCLUDED_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx']);

const REVIEW_THRESHOLD = 500;
const SPLIT_THRESHOLD = 800;
const PRIORITY_THRESHOLD = 1500;

async function* walkFiles(currentPath) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      yield* walkFiles(absolutePath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!INCLUDED_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }

    yield absolutePath;
  }
}

async function countLines(absolutePath) {
  const content = await fs.readFile(absolutePath, 'utf8');
  return content.split(/\r?\n/).length;
}

function relativeFromRepo(absolutePath) {
  return path.relative(repoRoot, absolutePath).replaceAll('\\', '/');
}

function isTestPath(relativePath) {
  return relativePath.includes('.test.') || relativePath.includes('.spec.');
}

function classify(lineCount) {
  if (lineCount >= PRIORITY_THRESHOLD) {
    return 'priority';
  }

  if (lineCount >= SPLIT_THRESHOLD) {
    return 'split';
  }

  if (lineCount >= REVIEW_THRESHOLD) {
    return 'review';
  }

  return 'normal';
}

function getImmediateSubtree(scanRoot, relativePath) {
  const segments = relativePath.split('/');
  const rootSegments = scanRoot.replaceAll('\\', '/').split('/');
  return segments.length > rootSegments.length
    ? `${scanRoot}/${segments[rootSegments.length]}`
    : scanRoot;
}

function sortDescendingByLines(left, right) {
  return right.lines - left.lines || left.path.localeCompare(right.path);
}

function formatBucket(title, entries) {
  const lines = [`## ${title}`];
  if (!entries.length) {
    lines.push('- none');
    return lines.join('\n');
  }

  for (const entry of entries) {
    lines.push(`- \`${entry.path}\` (${entry.lines} lines)`);
  }

  return lines.join('\n');
}

async function main() {
  const fileEntries = [];

  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = path.join(repoRoot, scanRoot);
    for await (const absolutePath of walkFiles(absoluteRoot)) {
      const relativePath = relativeFromRepo(absolutePath);
      fileEntries.push({
        path: relativePath,
        lines: await countLines(absolutePath),
        kind: isTestPath(relativePath) ? 'test' : 'app',
        subtree: getImmediateSubtree(scanRoot, relativePath)
      });
    }
  }

  const appEntries = fileEntries.filter((entry) => entry.kind === 'app').sort(sortDescendingByLines);
  const testEntries = fileEntries.filter((entry) => entry.kind === 'test').sort(sortDescendingByLines);

  const priorityAppEntries = appEntries.filter((entry) => classify(entry.lines) === 'priority');
  const splitAppEntries = appEntries.filter((entry) => classify(entry.lines) === 'split');
  const reviewAppEntries = appEntries.filter((entry) => classify(entry.lines) === 'review');
  const largeTestEntries = testEntries.filter((entry) => entry.lines >= REVIEW_THRESHOLD);

  const subtreeTotals = new Map();
  for (const entry of fileEntries) {
    const current = subtreeTotals.get(entry.subtree) || { lines: 0, files: 0 };
    current.lines += entry.lines;
    current.files += 1;
    subtreeTotals.set(entry.subtree, current);
  }

  const orderedSubtrees = [...subtreeTotals.entries()]
    .map(([subtree, totals]) => ({ subtree, ...totals }))
    .sort((left, right) => right.lines - left.lines || left.subtree.localeCompare(right.subtree));

  const sections = [
    '# Repo Hotspot Audit',
    '',
    `- Scan roots: ${SCAN_ROOTS.map((root) => `\`${root}\``).join(', ')}`,
    `- Thresholds: review >= ${REVIEW_THRESHOLD} lines, split >= ${SPLIT_THRESHOLD} lines, priority >= ${PRIORITY_THRESHOLD} lines`,
    '',
    formatBucket('Priority App Files', priorityAppEntries),
    '',
    formatBucket('Default Split App Files', splitAppEntries),
    '',
    formatBucket('Review App Files', reviewAppEntries),
    '',
    formatBucket('Large Test Files', largeTestEntries),
    '',
    '## Subtree Totals',
    ...orderedSubtrees.map(
      (entry) => `- \`${entry.subtree}\`: ${entry.files} files / ${entry.lines} total lines`
    ),
    '',
    '## Top 20 App Files',
    ...appEntries.slice(0, 20).map((entry) => `- \`${entry.path}\` (${entry.lines} lines)`),
    '',
    '## Top 20 Test Files',
    ...testEntries.slice(0, 20).map((entry) => `- \`${entry.path}\` (${entry.lines} lines)`)
  ];

  process.stdout.write(`${sections.join('\n')}\n`);
}

main().catch((error) => {
  console.error('[audit:repo:hotspots] failed');
  console.error(error);
  process.exitCode = 1;
});
