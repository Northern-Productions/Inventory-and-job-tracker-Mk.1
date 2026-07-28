import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MANIFEST_SCHEMA_VERSION = 1;
const EXACT_NPM_SPECIFIER =
  /^npm:(?:@[^/\s]+\/[^@/\s]+|[^@/\s]+)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:\/.*)?$/;

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isValidSha512Integrity(value) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) {
    return false;
  }
  const bytes = Buffer.from(match[1], 'base64');
  return bytes.length === 64 && bytes.toString('base64') === match[1];
}

function gitObjectId(bytes, algorithm) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash(algorithm).update(header).update(bytes).digest('hex');
}

function runGit(repoRoot, args, options = {}) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    maxBuffer: 64 * 1024 * 1024
  });
}

function parseTreeEntries(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tabIndex = record.indexOf('\t');
      if (tabIndex < 0) {
        throw new Error('Unable to parse the committed Git tree.');
      }
      const [mode, type, objectId] = record.slice(0, tabIndex).split(' ');
      const relativePath = normalizePath(record.slice(tabIndex + 1));
      if (type !== 'blob' || !relativePath) {
        throw new Error('The committed tree contains an unsupported deployment input.');
      }
      return { mode, objectId, path: relativePath };
    });
}

function walkFiles(rootPath, currentPath = rootPath) {
  const result = [];
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('The materialized source contains a symbolic link.');
    }
    if (entry.isDirectory()) {
      result.push(...walkFiles(rootPath, absolutePath));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error('The materialized source contains an unsupported file type.');
    }
    result.push(normalizePath(path.relative(rootPath, absolutePath)));
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function assertInside(rootPath, candidatePath, label) {
  const relativePath = path.relative(rootPath, candidatePath);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} escapes the materialized source.`);
  }
  return normalizePath(relativePath);
}

function updateFramed(hash, label, value) {
  const labelBytes = Buffer.from(String(label), 'utf8');
  const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const lengths = Buffer.alloc(16);
  lengths.writeBigUInt64BE(BigInt(labelBytes.length), 0);
  lengths.writeBigUInt64BE(BigInt(valueBytes.length), 8);
  hash.update(lengths).update(labelBytes).update(valueBytes);
}

function digestEntries(marker, entries) {
  const hash = crypto.createHash('sha256');
  updateFramed(hash, 'schema', marker);
  for (const entry of entries) {
    updateFramed(hash, entry.label, entry.bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function isExactNpmSpecifier(specifier) {
  return EXACT_NPM_SPECIFIER.test(String(specifier || ''));
}

export function verifyMaterializedTree({ repoRoot, sourceRoot, commit }) {
  const canonicalRepoRoot = fs.realpathSync(repoRoot);
  const canonicalSourceRoot = fs.realpathSync(sourceRoot);
  const commitSha = runGit(canonicalRepoRoot, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const objectFormat = runGit(canonicalRepoRoot, ['rev-parse', '--show-object-format']).trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    throw new Error('The Git repository uses an unsupported object format.');
  }

  const treeBuffer = runGit(
    canonicalRepoRoot,
    ['ls-tree', '-r', '-z', '--full-tree', commitSha],
    { encoding: null }
  );
  const trackedEntries = parseTreeEntries(treeBuffer).sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  const actualFiles = walkFiles(canonicalSourceRoot);
  const trackedPaths = trackedEntries.map((entry) => entry.path);
  if (
    actualFiles.length !== trackedPaths.length ||
    actualFiles.some((value, index) => value !== trackedPaths[index])
  ) {
    throw new Error('The materialized source file set does not exactly match the commit.');
  }

  const digestInputs = [];
  for (const entry of trackedEntries) {
    const bytes = fs.readFileSync(path.join(canonicalSourceRoot, ...entry.path.split('/')));
    if (gitObjectId(bytes, objectFormat) !== entry.objectId) {
      throw new Error(`Materialized bytes differ from the commit for ${entry.path}.`);
    }
    digestInputs.push({ label: `${entry.mode}:${entry.path}`, bytes });
  }

  return {
    commitSha,
    fileCount: trackedEntries.length,
    trackedEntries,
    archiveTreeDigest: digestEntries('edge-archive-tree-v1', digestInputs)
  };
}

function collectGraphDependencies(graph) {
  const external = new Map();
  for (const module of graph.modules || []) {
    for (const dependency of module.dependencies || []) {
      const specifier = String(dependency.specifier || '');
      if (!/^(?:npm|jsr|https?):/.test(specifier)) {
        continue;
      }
      if (!isExactNpmSpecifier(specifier)) {
        throw new Error(`Mutable or unsupported dependency specifier: ${specifier || '<blank>'}.`);
      }
      const resolved = String(dependency.npmPackage || '');
      if (!resolved) {
        throw new Error(`Dependency ${specifier} has no exact npm resolution.`);
      }
      external.set(`${specifier}\0${resolved}`, { specifier, resolved });
    }
  }
  return [...external.values()].sort((left, right) =>
    `${left.specifier}\0${left.resolved}`.localeCompare(`${right.specifier}\0${right.resolved}`)
  );
}

export function validateLockedGraph({ graph, denoConfig, lock }) {
  if (
    denoConfig?.lock?.path !== './deno.lock' ||
    denoConfig?.lock?.frozen !== true
  ) {
    throw new Error('The API Deno configuration must use ./deno.lock in frozen mode.');
  }
  if (String(lock?.version || '') !== '5') {
    throw new Error('The API deployment requires a version-5 Deno lockfile.');
  }

  const externalSpecifiers = collectGraphDependencies(graph);
  for (const dependency of externalSpecifiers) {
    const lockedVersion = String(lock?.specifiers?.[dependency.specifier] || '');
    if (!lockedVersion || !dependency.resolved.endsWith(`@${lockedVersion}`)) {
      throw new Error(`The lockfile does not certify ${dependency.specifier}.`);
    }
  }

  const graphPackages = Object.keys(graph?.npmPackages || {}).sort((left, right) =>
    left.localeCompare(right)
  );
  const lockPackages = Object.keys(lock?.npm || {}).sort((left, right) =>
    left.localeCompare(right)
  );
  if (
    graphPackages.length !== lockPackages.length ||
    graphPackages.some((value, index) => value !== lockPackages[index])
  ) {
    throw new Error('The Deno graph and lockfile npm package sets differ.');
  }

  const npmPackages = graphPackages.map((packageName) => {
    const locked = lock.npm[packageName];
    const integrity = String(locked?.integrity || '');
    if (!isValidSha512Integrity(integrity)) {
      throw new Error(`The lockfile lacks valid integrity metadata for ${packageName}.`);
    }
    return {
      package: packageName,
      integrity,
      dependencies: Array.isArray(locked.dependencies)
        ? [...locked.dependencies].sort((left, right) => left.localeCompare(right))
        : []
    };
  });

  return { externalSpecifiers, npmPackages };
}

export function runDenoInfo({ sourceRoot, entrypointPath, denoConfigPath }) {
  const entrypointArgument = `./${assertInside(
    sourceRoot,
    fs.realpathSync(entrypointPath),
    'The API entrypoint'
  )}`;
  const denoConfigArgument = `./${assertInside(
    sourceRoot,
    fs.realpathSync(denoConfigPath),
    'The Deno configuration'
  )}`;
  const result = spawnSync(
    'deno',
    ['info', '--json', '--config', denoConfigArgument, '--frozen', entrypointArgument],
    {
      cwd: sourceRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  );
  if (result.status !== 0) {
    throw new Error('Deno could not build the frozen API dependency graph.');
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('Deno returned an invalid dependency graph.');
  }
}

function fileEntry(sourceRoot, relativePath, category) {
  const absolutePath = path.join(sourceRoot, ...relativePath.split('/'));
  const bytes = fs.readFileSync(absolutePath);
  return {
    category,
    path: relativePath,
    bytes,
    manifest: {
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256(bytes)
    }
  };
}

export function buildEdgeDeploymentProvenance({
  repoRoot,
  sourceRoot,
  commit,
  entrypoint = 'supabase/functions/api/index.ts',
  denoConfig = 'supabase/functions/api/deno.json',
  deployConfig = 'supabase/config.toml',
  expectedLocalModules
}) {
  const tree = verifyMaterializedTree({ repoRoot, sourceRoot, commit });
  const canonicalSourceRoot = fs.realpathSync(sourceRoot);
  const entrypointPath = path.join(canonicalSourceRoot, ...normalizePath(entrypoint).split('/'));
  const denoConfigPath = path.join(canonicalSourceRoot, ...normalizePath(denoConfig).split('/'));
  const graph = runDenoInfo({ sourceRoot: canonicalSourceRoot, entrypointPath, denoConfigPath });

  const localPaths = [...new Set(
    (graph.modules || [])
      .map((module) => String(module.specifier || ''))
      .filter((specifier) => specifier.startsWith('file:'))
      .map((specifier) =>
        assertInside(canonicalSourceRoot, fs.realpathSync(fileURLToPath(specifier)), 'A local module')
      )
  )].sort((left, right) => left.localeCompare(right));

  if (
    Number.isInteger(expectedLocalModules) &&
    localPaths.length !== expectedLocalModules
  ) {
    throw new Error(
      `Expected ${expectedLocalModules} local modules, received ${localPaths.length}.`
    );
  }

  const trackedPaths = new Set(tree.trackedEntries.map((entry) => entry.path));
  for (const localPath of localPaths) {
    if (!trackedPaths.has(localPath)) {
      throw new Error(`The graph imports an untracked local module: ${localPath}.`);
    }
  }

  const denoConfigValue = JSON.parse(fs.readFileSync(denoConfigPath, 'utf8'));
  const lockRelativePath = normalizePath(
    path.join(path.dirname(normalizePath(denoConfig)), denoConfigValue?.lock?.path || '')
  );
  const lockPath = path.join(canonicalSourceRoot, ...lockRelativePath.split('/'));
  assertInside(canonicalSourceRoot, fs.realpathSync(lockPath), 'The Deno lockfile');
  const lockValue = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const lockedGraph = validateLockedGraph({
    graph,
    denoConfig: denoConfigValue,
    lock: lockValue
  });

  const localEntries = localPaths.map((relativePath) =>
    fileEntry(canonicalSourceRoot, relativePath, 'module')
  );
  const resolutionPaths = [
    normalizePath(denoConfig),
    lockRelativePath,
    normalizePath(deployConfig)
  ].sort((left, right) => left.localeCompare(right));
  const resolutionEntries = resolutionPaths.map((relativePath) => {
    if (!trackedPaths.has(relativePath)) {
      throw new Error(`A resolution input is not committed: ${relativePath}.`);
    }
    return fileEntry(canonicalSourceRoot, relativePath, 'resolution');
  });

  const graphDigestEntries = [
    { label: 'commit', bytes: Buffer.from(tree.commitSha, 'utf8') },
    { label: 'entrypoint', bytes: Buffer.from(normalizePath(entrypoint), 'utf8') },
    ...localEntries.map((entry) => ({
      label: `${entry.category}:${entry.path}`,
      bytes: entry.bytes
    })),
    ...resolutionEntries.map((entry) => ({
      label: `${entry.category}:${entry.path}`,
      bytes: entry.bytes
    })),
    {
      label: 'external-specifiers',
      bytes: Buffer.from(JSON.stringify(lockedGraph.externalSpecifiers), 'utf8')
    },
    {
      label: 'npm-packages',
      bytes: Buffer.from(JSON.stringify(lockedGraph.npmPackages), 'utf8')
    }
  ];
  const denoVersion = spawnSync('deno', ['--version'], { encoding: 'utf8' })
    .stdout
    .split(/\r?\n/, 1)[0]
    .trim();

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    commitSha: tree.commitSha,
    entrypoint: normalizePath(entrypoint),
    archive: {
      exactCommitTree: true,
      fileCount: tree.fileCount,
      digest: tree.archiveTreeDigest
    },
    deno: {
      version: denoVersion,
      configPath: normalizePath(denoConfig),
      lockPath: lockRelativePath,
      lockfileVersion: String(lockValue.version),
      frozen: true
    },
    localModules: localEntries.map((entry) => entry.manifest),
    resolutionFiles: resolutionEntries.map((entry) => entry.manifest),
    externalSpecifiers: lockedGraph.externalSpecifiers,
    npmPackages: lockedGraph.npmPackages,
    completeGraphDigest: digestEntries('edge-complete-graph-v1', graphDigestEntries)
  };
}

export function writeProvenanceManifest(manifestPath, manifest) {
  const absolutePath = path.resolve(manifestPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  });
}
