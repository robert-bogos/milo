// Git plumbing of the plan job. The pull request is fetched as a blob-less (partial) clone, so
// everything here reads only commits and trees, except readBlobs, which downloads the file
// contents perf-ab swaps into the pages in one batch.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BATCH = 200;

export function createGit(cwd = '.') {
  return (args, { encoding = 'utf8', input } = {}) => execFileSync('git', args, {
    cwd,
    encoding,
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

function batches(items) {
  const count = Math.ceil(items.length / BATCH);
  return Array.from({ length: count }, (_, i) => items.slice(i * BATCH, (i + 1) * BATCH));
}

/** The given repository paths (files or directories) that exist at a commit. */
export function existingPaths(git, sha, paths) {
  const found = new Set();
  batches(paths).forEach((batch) => {
    const listed = git(['ls-tree', '--name-only', '-z', sha, '--', ...batch]).split('\0');
    listed.filter(Boolean).forEach((path) => found.add(path));
  });
  return found;
}

/** Fetches the commits and trees of the production branch and returns its tip. */
export function fetchProduction(git, { url, branch, remote = 'perf-production' }) {
  let current = null;
  try {
    current = git(['remote', 'get-url', remote]).trim();
  } catch {
    git(['remote', 'add', remote, url]);
  }
  if (current && current !== url) git(['remote', 'set-url', remote, url]);
  // Commits and trees only: production file contents are never needed.
  git(['fetch', '--no-tags', '--filter=blob:none', remote, `refs/heads/${branch}`]);
  return git(['rev-parse', 'FETCH_HEAD']).trim();
}

/** Reads `<commit>:<path>` specs, downloading missing contents in one request. */
export function readBlobs(git, specs, { log = () => {} } = {}) {
  const oids = batches(specs).flatMap((batch) => git(['rev-parse', ...batch]).trim().split('\n'));
  let partial = false;
  try {
    partial = git(['config', '--get', 'remote.origin.promisor']).trim() === 'true';
  } catch {
    // Not a partial clone: every file is local.
  }
  if (partial && oids.length) {
    try {
      git([
        '-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head',
        '--recurse-submodules=no', '--filter=blob:none', '--stdin',
      ], { input: `${[...new Set(oids)].join('\n')}\n` });
    } catch (error) {
      // cat-file then downloads each missing file on its own.
      log(`Batched download failed: ${String(error.message).split('\n')[0]}`);
    }
  }
  return new Map(specs.map((spec, i) => [spec, git(['cat-file', 'blob', oids[i]], { encoding: 'buffer' })]));
}

/**
 * Writes the files of planSources (core.js) to dir as <sha256> files plus manifest.json, which
 * maps each side's URL paths to those files. revisions maps 'base' and 'head' to commits.
 */
export function materializeSources(git, { sources, revisions, dir, log }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const spec = ({ rev, path }) => `${revisions[rev]}:${path}`;
  const sides = ['before', 'after'];
  const specs = [...new Set(sides.flatMap((side) => Object.values(sources[side]).map(spec)))];
  const hashes = new Map();
  readBlobs(git, specs, { log }).forEach((body, key) => {
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 32);
    writeFileSync(join(dir, hash), body);
    hashes.set(key, hash);
  });
  const side = (name) => Object.fromEntries(Object.entries(sources[name])
    .map(([path, file]) => [path, hashes.get(spec(file))]));
  const manifest = { before: side('before'), after: side('after'), changed: sources.changed };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { files: new Set(hashes.values()).size, manifest };
}
