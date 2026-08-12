import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_HEALTHY = 'REPOSITORY_HEALTHY';
export const REPOSITORY_HEALTHY_WITH_WARNINGS = 'REPOSITORY_HEALTHY_WITH_WARNINGS';
export const REPOSITORY_UNSAFE_FOR_CODEX = 'REPOSITORY_UNSAFE_FOR_CODEX';

const STATUS = Object.freeze({
  PASS: 'PASS',
  WARNING: 'WARNING',
  FAIL: 'FAIL',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
});

const MODULE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const POLICY_FILES = Object.freeze(['AGENTS.md', 'docs/automation/codex-operating-manual.md']);
const npmTool = process.env.npm_execpath
  ? { command: process.execPath, args: [process.env.npm_execpath, '--version'] }
  : process.platform === 'win32'
    ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm --version'] }
    : { command: 'npm', args: ['--version'] };
const DEFAULT_TOOLCHAIN = Object.freeze([
  { name: 'git', command: 'git', args: ['--version'], optional: false },
  { name: 'node', version: process.version, optional: false },
  { name: 'npm', ...npmTool, optional: false },
  { name: 'deno', command: 'deno', args: ['--version'], optional: true },
  { name: 'docker', command: 'docker', args: ['--version'], optional: true },
  { name: 'supabase', command: 'supabase', args: ['--version'], optional: true }
]);

function normalizePath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function pathCategory(refName) {
  if (!refName) return 'detached';
  if (refName === 'refs/heads/main') return 'main';
  const match = /^refs\/heads\/([^/]+)/.exec(refName);
  const prefix = match?.[1] || 'other';
  return ['feature', 'fix', 'integration', 'investigation', 'tooling', 'release', 'security', 'ops', 'perf', 'docs'].includes(prefix)
    ? `${prefix}_branch`
    : 'feature_branch';
}

function safeVersion(value) {
  const firstLine = String(value || '').split(/\r?\n/, 1)[0].trim();
  return /^[A-Za-z0-9@()._,+/: =-]{1,120}$/.test(firstLine) ? firstLine : '<available>';
}

function run(command, args = [], { cwd, input, timeout = 30_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1'
    }
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    errorCode: result.error?.code || ''
  };
}

function runGit(args, options = {}) {
  return run('git', args, options);
}

function addCheck(report, id, status, summary, metrics = undefined) {
  const check = { id, status, summary };
  if (metrics && Object.keys(metrics).length) check.metrics = metrics;
  report.repositoryChecks.push(check);
  return check;
}

function addToolCheck(report, id, status, summary) {
  report.toolchain.checks.push({ id, status, summary });
}

function statDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readStrictLine(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.includes(0)) throw new Error('binary metadata');
  let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  if (!text || /[\r\n]/.test(text)) throw new Error('invalid metadata line');
  return text;
}

function findWorktreeRoot(startPath) {
  let current = path.resolve(startPath);
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    throw new Error('starting path unavailable');
  }
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Git metadata marker not found');
    current = parent;
  }
}

function resolveGitMetadata(worktreeRoot) {
  const root = path.resolve(worktreeRoot);
  const marker = path.join(root, '.git');
  let markerStat;
  try {
    markerStat = fs.statSync(marker);
  } catch {
    throw new Error('Git metadata marker unavailable');
  }

  let gitDir;
  let kind;
  if (markerStat.isDirectory()) {
    gitDir = marker;
    kind = 'canonical';
  } else if (markerStat.isFile()) {
    const pointer = readStrictLine(marker);
    const match = /^gitdir: (.+)$/.exec(pointer);
    if (!match) throw new Error('Git metadata pointer malformed');
    gitDir = path.resolve(root, match[1]);
    kind = 'linked';
  } else {
    throw new Error('Git metadata marker type unsupported');
  }

  if (!statDirectory(gitDir)) throw new Error('Git metadata directory unavailable');
  const commonFile = path.join(gitDir, 'commondir');
  const commonDir = fs.existsSync(commonFile) ? path.resolve(gitDir, readStrictLine(commonFile)) : gitDir;
  if (!statDirectory(commonDir)) throw new Error('common Git directory unavailable');
  return { root, marker, gitDir, commonDir, kind };
}

function readConfigValues(configPath, key) {
  const result = runGit(['config', '--file', configPath, '--null', '--get-all', key], { cwd: os.tmpdir() });
  if (result.status === 1 && !result.errorCode) return { ok: true, values: [] };
  if (!result.ok) return { ok: false, values: [] };
  return { ok: true, values: result.stdout.split('\0').filter((value) => value.length > 0) };
}

function gitDirArgs(gitDir, args, worktreeRoot = undefined) {
  const prefix = [`--git-dir=${gitDir}`];
  if (worktreeRoot) prefix.push(`--work-tree=${worktreeRoot}`);
  return [...prefix, ...args];
}

function parseWorktreeList(output) {
  const records = [];
  let current = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length), detached: false, prunable: false, locked: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length);
    else if (line === 'detached') current.detached = true;
    else if (line.startsWith('prunable')) current.prunable = true;
    else if (line.startsWith('locked')) current.locked = true;
  }
  if (current) records.push(current);
  return records;
}

function inspectWorktrees(report, commonDir, canonicalRoot, output) {
  const records = parseWorktreeList(output);
  const normalized = new Set();
  const liveBranches = new Set();
  let duplicatePaths = 0;
  let duplicateBranches = 0;
  let live = 0;
  let stalePrunable = 0;
  let missingBlocking = 0;
  let reciprocalFailures = 0;
  let headFailures = 0;

  for (const record of records) {
    const pathKey = normalizePath(record.path);
    if (normalized.has(pathKey)) duplicatePaths += 1;
    normalized.add(pathKey);
    const exists = statDirectory(record.path);
    if (!exists) {
      if (record.prunable) stalePrunable += 1;
      else missingBlocking += 1;
      continue;
    }
    live += 1;
    let metadata;
    try {
      metadata = resolveGitMetadata(record.path);
      if (!samePath(metadata.commonDir, commonDir)) reciprocalFailures += 1;
      if (metadata.kind === 'canonical' && !samePath(metadata.root, canonicalRoot)) reciprocalFailures += 1;
      if (metadata.kind === 'linked') {
        const backlinkPath = path.join(metadata.gitDir, 'gitdir');
        const backlink = readStrictLine(backlinkPath);
        if (!samePath(backlink, metadata.marker)) reciprocalFailures += 1;
      }
    } catch {
      reciprocalFailures += 1;
      continue;
    }

    const head = runGit(gitDirArgs(metadata.gitDir, ['rev-parse', '--verify', 'HEAD']), { cwd: os.tmpdir() });
    if (!head.ok || head.stdout.trim() !== record.head) headFailures += 1;
    const symbolic = runGit(gitDirArgs(metadata.gitDir, ['symbolic-ref', '-q', 'HEAD']), { cwd: os.tmpdir() });
    if (record.branch) {
      if (!symbolic.ok || symbolic.stdout.trim() !== record.branch) headFailures += 1;
      if (liveBranches.has(record.branch)) duplicateBranches += 1;
      liveBranches.add(record.branch);
    } else if (!record.detached || symbolic.ok) {
      headFailures += 1;
    }
  }

  if (!records.length || duplicatePaths || duplicateBranches || missingBlocking || reciprocalFailures || headFailures) {
    addCheck(report, 'worktrees.registration', STATUS.FAIL, 'registered worktree metadata is contradictory or incomplete', {
      registered: records.length,
      live,
      stalePrunable,
      duplicatePaths,
      duplicateBranches,
      missingBlocking,
      reciprocalFailures,
      headFailures
    });
  } else if (stalePrunable) {
    addCheck(report, 'worktrees.registration', STATUS.WARNING, 'live worktrees are consistent; retained prunable history is nonblocking', {
      registered: records.length,
      live,
      stalePrunable
    });
  } else {
    addCheck(report, 'worktrees.registration', STATUS.PASS, 'all registered worktrees are live and reciprocal', {
      registered: records.length,
      live
    });
  }
  return records;
}

function collectRefFiles(directory, prefix = '') {
  const files = [];
  const errors = [];
  if (!fs.existsSync(directory)) return { files, errors };
  const walk = (current, relative) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      errors.push(relative || 'refs');
      return;
    }
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(nextPath, nextRelative);
      else if (entry.isFile()) files.push({ filePath: nextPath, refName: `${prefix}${nextRelative}` });
      else errors.push(nextRelative);
    }
  };
  walk(directory, '');
  return { files, errors };
}

function decodeRefFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.includes(0)) throw new Error('binary ref');
  let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  if (!text || /[\r\n]/.test(text)) throw new Error('multiline ref');
  return text;
}

function validateRefName(refName) {
  return runGit(['check-ref-format', refName], { cwd: os.tmpdir() }).ok;
}

function inspectRefs(report, commonDir, oidLength) {
  const loose = collectRefFiles(path.join(commonDir, 'refs'), 'refs/');
  const refNames = new Set();
  const objectIds = new Set();
  const symbolicRefs = [];
  let looseMalformed = loose.errors.length;
  let lockFiles = 0;

  for (const entry of loose.files) {
    if (entry.refName.endsWith('.lock')) {
      lockFiles += 1;
      continue;
    }
    if (!validateRefName(entry.refName)) {
      looseMalformed += 1;
      continue;
    }
    let content;
    try {
      content = decodeRefFile(entry.filePath);
    } catch {
      looseMalformed += 1;
      continue;
    }
    if (content.startsWith('ref: ')) {
      const target = content.slice(5);
      if (!validateRefName(target)) looseMalformed += 1;
      else symbolicRefs.push(entry.refName);
    } else if (new RegExp(`^[0-9a-fA-F]{${oidLength}}$`).test(content)) {
      objectIds.add(content.toLowerCase());
    } else {
      looseMalformed += 1;
      continue;
    }
    refNames.add(entry.refName);
  }

  if (looseMalformed || lockFiles) {
    addCheck(report, 'refs.loose', STATUS.FAIL, 'loose refs contain malformed, unreadable, or locked metadata', {
      files: loose.files.length,
      malformed: looseMalformed,
      lockFiles
    });
  } else {
    addCheck(report, 'refs.loose', STATUS.PASS, 'loose refs are structurally valid', { files: loose.files.length });
  }

  const packedPath = path.join(commonDir, 'packed-refs');
  let packedMalformed = 0;
  let packedCount = 0;
  let previousPackedRef = '';
  if (fs.existsSync(packedPath)) {
    try {
      const bytes = fs.readFileSync(packedPath);
      if (bytes.includes(0)) throw new Error('binary packed refs');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const packedNames = new Set();
      for (const line of text.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('^')) {
          const oid = line.slice(1);
          if (!previousPackedRef || !new RegExp(`^[0-9a-fA-F]{${oidLength}}$`).test(oid)) packedMalformed += 1;
          else objectIds.add(oid.toLowerCase());
          previousPackedRef = '';
          continue;
        }
        const match = new RegExp(`^([0-9a-fA-F]{${oidLength}}) (refs/\\S+)$`).exec(line);
        if (!match || !validateRefName(match[2]) || packedNames.has(match[2])) {
          packedMalformed += 1;
          previousPackedRef = '';
          continue;
        }
        packedNames.add(match[2]);
        refNames.add(match[2]);
        objectIds.add(match[1].toLowerCase());
        previousPackedRef = match[2];
        packedCount += 1;
      }
    } catch {
      packedMalformed += 1;
    }
  }

  addCheck(
    report,
    'refs.packed',
    packedMalformed ? STATUS.FAIL : STATUS.PASS,
    packedMalformed ? 'packed refs contain malformed or unreadable metadata' : 'packed refs are structurally valid',
    { refs: packedCount, malformed: packedMalformed }
  );

  let missingObjects = 0;
  if (objectIds.size) {
    const input = `${[...objectIds].sort().join('\n')}\n`;
    const batch = runGit(gitDirArgs(commonDir, ['cat-file', '--batch-check=%(objectname) %(objecttype)']), {
      cwd: os.tmpdir(),
      input,
      timeout: 60_000
    });
    if (!batch.ok) {
      missingObjects = objectIds.size;
    } else {
      missingObjects = batch.stdout.split(/\r?\n/).filter((line) => line.endsWith(' missing')).length;
    }
  }
  for (const refName of symbolicRefs) {
    if (!runGit(gitDirArgs(commonDir, ['rev-parse', '--verify', refName]), { cwd: os.tmpdir() }).ok) missingObjects += 1;
  }
  addCheck(
    report,
    'refs.objects',
    missingObjects ? STATUS.FAIL : STATUS.PASS,
    missingObjects ? 'one or more refs do not resolve to existing objects' : 'all parsed refs resolve to existing objects',
    { refs: refNames.size, uniqueObjects: objectIds.size, missingObjects }
  );
  return { refNames, objectIds };
}

function inspectProtectedState(report, commonDir, refs, worktrees) {
  const protectedRefs = new Set(['refs/heads/main']);
  for (const record of worktrees) if (record.branch) protectedRefs.add(record.branch);
  for (const refName of refs.refNames) {
    if (refName === 'refs/stash' || refName.startsWith('refs/tags/') || refName.startsWith('refs/codex/')) protectedRefs.add(refName);
  }
  const configured = readConfigValues(path.join(commonDir, 'config'), 'repoDoctor.protectedRef');
  let invalid = configured.ok ? 0 : 1;
  for (const refName of configured.values) {
    if (validateRefName(refName)) protectedRefs.add(refName);
    else invalid += 1;
  }
  let missing = 0;
  for (const refName of protectedRefs) {
    const resolved = runGit(gitDirArgs(commonDir, ['rev-parse', '--verify', refName]), { cwd: os.tmpdir() });
    if (!resolved.ok) missing += 1;
  }
  addCheck(
    report,
    'protected_state.refs',
    invalid || missing ? STATUS.FAIL : STATUS.PASS,
    invalid || missing ? 'policy-derived protected refs are invalid or unresolved' : 'policy-derived protected refs resolve to existing objects',
    { checked: protectedRefs.size, invalid, missing }
  );
}

function inspectPolicies(report, currentRoot, canonicalRoot) {
  let missing = 0;
  let unreadable = 0;
  const digest = crypto.createHash('sha256');
  for (const relative of POLICY_FILES) {
    for (const root of new Set([currentRoot, canonicalRoot])) {
      const filePath = path.join(root, relative);
      try {
        const bytes = fs.readFileSync(filePath);
        if (!bytes.length) unreadable += 1;
        if (samePath(root, currentRoot)) digest.update(relative).update('\0').update(bytes).update('\0');
      } catch (error) {
        if (error?.code === 'ENOENT') missing += 1;
        else unreadable += 1;
      }
    }
  }
  const status = missing || unreadable ? STATUS.FAIL : STATUS.PASS;
  addCheck(
    report,
    'policy.availability',
    status,
    status === STATUS.PASS ? `required governance files are readable (sha256:${digest.digest('hex').slice(0, 12)})` : 'required governance files are missing or unreadable',
    { required: POLICY_FILES.length, missing, unreadable }
  );
}

function inspectStorage(report, commonDir) {
  if (process.platform === 'win32') {
    const command = [
      '& { param([string]$Target)',
      '$item = Get-Item -LiteralPath $Target -Force',
      "if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { 'reparse' } else { 'standard' }"
    ].join('; ') + ' }';
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command, commonDir], {
      cwd: os.tmpdir(),
      timeout: 10_000
    });
    if (!result.ok || !['reparse', 'standard'].includes(result.stdout.trim())) {
      addCheck(report, 'repository.storage', STATUS.NOT_APPLICABLE, 'storage metadata classification is unavailable');
    } else if (result.stdout.trim() === 'reparse') {
      addCheck(report, 'repository.storage', STATUS.WARNING, 'Git metadata uses healthy reparse-backed storage');
    } else {
      addCheck(report, 'repository.storage', STATUS.PASS, 'Git metadata uses standard directory storage');
    }
    return;
  }

  try {
    if (fs.lstatSync(commonDir).isSymbolicLink()) {
      addCheck(report, 'repository.storage', STATUS.WARNING, 'Git metadata uses healthy linked storage');
    } else {
      addCheck(report, 'repository.storage', STATUS.PASS, 'Git metadata uses standard directory storage');
    }
  } catch {
    addCheck(report, 'repository.storage', STATUS.NOT_APPLICABLE, 'storage metadata classification is unavailable');
  }
}

function inspectToolchain(report, definitions) {
  for (const definition of definitions) {
    if (definition.version) {
      addToolCheck(report, definition.name, STATUS.PASS, safeVersion(definition.version));
      continue;
    }
    const result = run(definition.command, definition.args || ['--version'], { cwd: os.tmpdir(), timeout: 10_000 });
    if (result.ok) {
      addToolCheck(report, definition.name, STATUS.PASS, safeVersion(result.stdout || result.stderr));
    } else {
      addToolCheck(
        report,
        definition.name,
        definition.optional ? STATUS.WARNING : STATUS.FAIL,
        definition.optional ? 'optional tool unavailable' : 'required tool unavailable'
      );
    }
  }
}

function finalize(report) {
  const failures = report.repositoryChecks.filter((check) => check.status === STATUS.FAIL).length;
  const warnings = report.repositoryChecks.filter((check) => check.status === STATUS.WARNING).length;
  report.overall = failures
    ? REPOSITORY_UNSAFE_FOR_CODEX
    : warnings
      ? REPOSITORY_HEALTHY_WITH_WARNINGS
      : REPOSITORY_HEALTHY;
  const toolFailures = report.toolchain.checks.filter((check) => check.status === STATUS.FAIL).length;
  const toolWarnings = report.toolchain.checks.filter((check) => check.status === STATUS.WARNING).length;
  report.toolchain.overall = toolFailures ? 'TOOLCHAIN_INCOMPLETE' : toolWarnings ? 'TOOLCHAIN_READY_WITH_WARNINGS' : 'TOOLCHAIN_READY';
  report.summary = {
    pass: report.repositoryChecks.filter((check) => check.status === STATUS.PASS).length,
    warnings,
    failures,
    notApplicable: report.repositoryChecks.filter((check) => check.status === STATUS.NOT_APPLICABLE).length
  };
  return report;
}

function addUnavailableChecks(report) {
  const existing = new Set(report.repositoryChecks.map((check) => check.id));
  for (const id of [
    'repository.objects',
    'repository.storage',
    'canonical.metadata',
    'canonical.core_worktree',
    'repository.head',
    'repository.head_state',
    'canonical.head_state',
    'canonical.plumbing',
    'worktrees.registration',
    'refs.loose',
    'refs.packed',
    'refs.objects',
    'protected_state.refs',
    'git.status',
    'git.log_head',
    'git.log_all',
    'git.show_ref',
    'objects.integrity',
    'policy.availability'
  ]) {
    if (!existing.has(id)) {
      addCheck(report, id, STATUS.NOT_APPLICABLE, 'check unavailable because repository identity could not be established');
    }
  }
}

export function runRepositoryDoctor({
  expectedRoot = MODULE_REPO_ROOT,
  cwd = process.cwd(),
  includeToolchain = true,
  toolchainDefinitions = DEFAULT_TOOLCHAIN
} = {}) {
  const report = {
    schemaVersion: 1,
    overall: REPOSITORY_UNSAFE_FOR_CODEX,
    repositoryChecks: [],
    toolchain: { overall: 'NOT_CHECKED', checks: [] }
  };

  let expected;
  let current;
  try {
    expected = resolveGitMetadata(findWorktreeRoot(expectedRoot));
    current = resolveGitMetadata(findWorktreeRoot(cwd));
  } catch {
    addCheck(report, 'repository.identity', STATUS.FAIL, 'repository identity could not be established from filesystem metadata');
    addUnavailableChecks(report);
    if (includeToolchain) inspectToolchain(report, toolchainDefinitions);
    return finalize(report);
  }

  if (!samePath(expected.commonDir, current.commonDir)) {
    addCheck(report, 'repository.identity', STATUS.FAIL, 'invocation path belongs to a different common repository');
    addUnavailableChecks(report);
    if (includeToolchain) inspectToolchain(report, toolchainDefinitions);
    return finalize(report);
  }
  addCheck(report, 'repository.identity', STATUS.PASS, 'invocation and tool source resolve to one common repository');

  const commonDir = expected.commonDir;
  const canonicalRoot = path.basename(commonDir).toLowerCase() === '.git' ? path.dirname(commonDir) : '';
  const objectsDir = path.join(commonDir, 'objects');
  if (!canonicalRoot || !statDirectory(commonDir) || !statDirectory(objectsDir)) {
    addCheck(report, 'repository.objects', STATUS.FAIL, 'common Git directory or object database is unavailable');
    addUnavailableChecks(report);
    if (includeToolchain) inspectToolchain(report, toolchainDefinitions);
    return finalize(report);
  }
  addCheck(report, 'repository.objects', STATUS.PASS, 'common Git directory and object database are reachable');
  inspectStorage(report, commonDir);

  let canonical;
  try {
    canonical = resolveGitMetadata(canonicalRoot);
    if (!samePath(canonical.commonDir, commonDir) || canonical.kind !== 'canonical') throw new Error('canonical metadata mismatch');
    addCheck(report, 'canonical.metadata', STATUS.PASS, 'canonical Git metadata resolves to the common repository');
  } catch {
    addCheck(report, 'canonical.metadata', STATUS.FAIL, 'canonical Git metadata is missing or contradictory');
  }

  const coreWorktree = readConfigValues(path.join(commonDir, 'config'), 'core.worktree');
  if (!coreWorktree.ok || coreWorktree.values.length > 1) {
    addCheck(report, 'canonical.core_worktree', STATUS.FAIL, 'repository-wide core.worktree configuration is unreadable or ambiguous');
  } else if (!coreWorktree.values.length) {
    addCheck(report, 'canonical.core_worktree', STATUS.PASS, 'repository-wide core.worktree override is absent');
  } else {
    const configured = path.isAbsolute(coreWorktree.values[0])
      ? path.resolve(coreWorktree.values[0])
      : path.resolve(commonDir, coreWorktree.values[0]);
    let valid = statDirectory(configured) && samePath(configured, canonicalRoot);
    if (valid) {
      try {
        valid = samePath(resolveGitMetadata(configured).commonDir, commonDir);
      } catch {
        valid = false;
      }
    }
    addCheck(
      report,
      'canonical.core_worktree',
      valid ? STATUS.PASS : STATUS.FAIL,
      valid ? 'explicit core.worktree target is valid and canonical' : 'core.worktree target is missing or inconsistent'
    );
  }

  const formatResult = runGit(gitDirArgs(commonDir, ['rev-parse', '--show-object-format']), { cwd: os.tmpdir() });
  const objectFormat = formatResult.stdout.trim();
  const oidLength = objectFormat === 'sha256' ? 64 : objectFormat === 'sha1' ? 40 : 0;
  const headResult = runGit(gitDirArgs(current.gitDir, ['rev-parse', '--verify', 'HEAD']), { cwd: os.tmpdir() });
  const headObject = headResult.ok
    ? runGit(gitDirArgs(commonDir, ['cat-file', '-e', `${headResult.stdout.trim()}^{commit}`]), { cwd: os.tmpdir() })
    : { ok: false };
  if (!oidLength || !headResult.ok || !headObject.ok) {
    addCheck(report, 'repository.head', STATUS.FAIL, 'HEAD, object format, or current commit object is invalid');
  } else {
    addCheck(report, 'repository.head', STATUS.PASS, 'HEAD resolves to an existing commit object', { objectFormat });
  }

  const currentHead = runGit(gitDirArgs(current.gitDir, ['symbolic-ref', '-q', 'HEAD']), { cwd: os.tmpdir() });
  if (!currentHead.ok) {
    addCheck(
      report,
      'repository.head_state',
      headObject.ok ? STATUS.WARNING : STATUS.FAIL,
      headObject.ok ? 'current HEAD is detached but resolves cleanly' : 'current HEAD state cannot be understood'
    );
  } else {
    addCheck(
      report,
      'repository.head_state',
      STATUS.PASS,
      `current HEAD is attached to a ${pathCategory(currentHead.stdout.trim()).replace('_', ' ')}`
    );
  }

  const canonicalHead = runGit(gitDirArgs(commonDir, ['symbolic-ref', '-q', 'HEAD']), { cwd: os.tmpdir() });
  if (!canonicalHead.ok) {
    const detachedCommit = runGit(gitDirArgs(commonDir, ['rev-parse', '--verify', 'HEAD']), { cwd: os.tmpdir() });
    addCheck(
      report,
      'canonical.head_state',
      detachedCommit.ok ? STATUS.WARNING : STATUS.FAIL,
      detachedCommit.ok ? 'canonical HEAD is detached but resolves cleanly' : 'canonical HEAD cannot be understood'
    );
  } else {
    const category = pathCategory(canonicalHead.stdout.trim());
    addCheck(
      report,
      'canonical.head_state',
      category === 'main' ? STATUS.PASS : STATUS.WARNING,
      category === 'main' ? 'canonical HEAD is attached to main' : `canonical HEAD is attached to a ${category.replace('_', ' ')}`
    );
  }

  const canonicalTop = runGit(['-C', canonicalRoot, 'rev-parse', '--show-toplevel'], { cwd: os.tmpdir() });
  const canonicalStatus = runGit(['-C', canonicalRoot, 'status', '--porcelain=v2', '--branch'], { cwd: os.tmpdir() });
  const canonicalPlumbingOk =
    canonicalTop.ok && canonicalStatus.ok && samePath(canonicalTop.stdout.trim(), canonicalRoot);
  addCheck(
    report,
    'canonical.plumbing',
    canonicalPlumbingOk ? STATUS.PASS : STATUS.FAIL,
    canonicalPlumbingOk ? 'canonical root runs normal Git plumbing' : 'canonical root cannot run normal Git plumbing',
    canonicalPlumbingOk
      ? { workingTree: canonicalStatus.stdout.split(/\r?\n/).some((line) => line && !line.startsWith('# ')) ? 'dirty' : 'clean' }
      : undefined
  );

  const worktreeList = runGit(gitDirArgs(commonDir, ['worktree', 'list', '--porcelain']), { cwd: os.tmpdir() });
  let worktrees = [];
  if (!worktreeList.ok) {
    addCheck(report, 'worktrees.registration', STATUS.FAIL, 'registered worktrees cannot be enumerated');
  } else {
    worktrees = inspectWorktrees(report, commonDir, canonicalRoot, worktreeList.stdout);
  }

  const refs = inspectRefs(report, commonDir, oidLength || 40);
  inspectProtectedState(report, commonDir, refs, worktrees);

  const statusResult = runGit(['-C', current.root, 'status', '--porcelain=v2', '--branch'], { cwd: os.tmpdir() });
  addCheck(
    report,
    'git.status',
    statusResult.ok ? STATUS.PASS : STATUS.FAIL,
    statusResult.ok ? 'git status executes successfully' : 'git status cannot execute',
    statusResult.ok
      ? { workingTree: statusResult.stdout.split(/\r?\n/).some((line) => line && !line.startsWith('# ')) ? 'dirty' : 'clean' }
      : undefined
  );

  const logHead = runGit(['-C', current.root, 'log', '-1', '--format=%H', 'HEAD'], { cwd: os.tmpdir() });
  addCheck(report, 'git.log_head', logHead.ok ? STATUS.PASS : STATUS.FAIL, logHead.ok ? 'current HEAD log is readable' : 'current HEAD log cannot execute');

  const logAll = runGit(['-C', canonicalRoot, 'log', '--all', '-1', '--format=%H'], { cwd: os.tmpdir() });
  addCheck(report, 'git.log_all', logAll.ok ? STATUS.PASS : STATUS.FAIL, logAll.ok ? 'git log --all executes successfully' : 'git log --all cannot execute');

  const showRef = runGit(['-C', canonicalRoot, 'show-ref'], { cwd: os.tmpdir() });
  addCheck(report, 'git.show_ref', showRef.ok ? STATUS.PASS : STATUS.FAIL, showRef.ok ? 'git show-ref executes successfully' : 'git show-ref cannot execute');

  const fsck = runGit(gitDirArgs(commonDir, ['fsck', '--full', '--no-progress']), { cwd: os.tmpdir(), timeout: 120_000 });
  const fsckLines = `${fsck.stdout}\n${fsck.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const informational = fsckLines.filter((line) => /^(dangling|unreachable) /.test(line)).length;
  if (!fsck.ok) {
    addCheck(report, 'objects.integrity', STATUS.FAIL, 'git fsck found object or ref corruption');
  } else if (informational) {
    addCheck(report, 'objects.integrity', STATUS.WARNING, 'object database is valid with retained dangling or unreachable objects', {
      informationalObjects: informational
    });
  } else {
    addCheck(report, 'objects.integrity', STATUS.PASS, 'git fsck found no object corruption');
  }

  inspectPolicies(report, current.root, canonicalRoot);
  if (includeToolchain) inspectToolchain(report, toolchainDefinitions);
  return finalize(report);
}

export function formatRepositoryDoctorReport(report) {
  const lines = ['[repo-doctor]', `overall: ${report.overall}`, 'repositoryHealth:'];
  for (const check of report.repositoryChecks) {
    const metrics = check.metrics
      ? ` (${Object.entries(check.metrics).map(([key, value]) => `${key}=${value}`).join(', ')})`
      : '';
    lines.push(`  ${check.status} ${check.id}: ${check.summary}${metrics}`);
  }
  lines.push('taskToolchainReadiness:');
  lines.push(`  overall: ${report.toolchain.overall}`);
  for (const check of report.toolchain.checks) lines.push(`  ${check.status} ${check.id}: ${check.summary}`);
  lines.push('repairBehavior: none; this command is read-only and never repairs metadata');
  return lines.join('\n');
}
