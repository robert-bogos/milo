import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyChanges, parseNameStatus, planSources } from '../core.js';
import { createGit, existingPaths, fetchProduction, materializeSources } from '../sources.js';

const root = mkdtempSync(join(tmpdir(), 'perf-sources-test-'));
// The user's git configuration (signing, hooks, default branch) must not affect the test.
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = test\n\temail = test@example.com\n');

const originDir = join(root, 'origin');
const origin = createGit(originDir);
const shas = {};

function commit(files, message) {
  Object.entries(files).forEach(([path, body]) => {
    const file = join(originDir, path);
    if (body === null) {
      rmSync(file);
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  });
  origin(['add', '-A']);
  origin(['commit', '-q', '-m', message]);
  return origin(['rev-parse', 'HEAD']).trim();
}

before(() => {
  mkdirSync(originDir);
  origin(['init', '-q', '-b', 'main']);
  // What GitHub allows: partial clones and fetching file contents by id.
  origin(['config', 'uploadpack.allowFilter', 'true']);
  origin(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  shas.production = commit({
    'libs/utils/utils.js': 'production utils',
    'libs/blocks/marquee/marquee.js': 'marquee v1',
    'libs/blocks/marquee/marquee.css': '.marquee {}',
    'libs/img/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'libs/old.js': 'old',
  }, 'production');
  origin(['checkout', '-q', '-b', 'stage']);
  shas.base = commit({
    'libs/utils/utils.js': 'stage utils',
    'libs/features/unreleased.js': 'unreleased v1',
  }, 'stage');
  origin(['checkout', '-q', '-b', 'feature']);
  shas.head = commit({
    'libs/blocks/marquee/marquee.js': 'marquee v2',
    'libs/features/unreleased.js': 'unreleased v2',
    'libs/blocks/new-block/new-block.js': 'new block',
    'libs/img/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]),
    'libs/old.js': null,
  }, 'feature');
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('swapped sources from a blob-less clone', () => {
  it('plans and writes both sides without a full clone', () => {
    const cloneDir = join(root, 'clone');
    createGit(root)(['clone', '-q', '--no-checkout', '--filter=blob:none', pathToFileURL(originDir).href, cloneDir]);
    const git = createGit(cloneDir);
    const missing = () => git(['rev-list', '--objects', '--all', '--missing=print']).split('\n')
      .filter((line) => line.startsWith('?')).length;
    assert.ok(missing() > 0, 'the clone has no file contents');

    assert.equal(fetchProduction(git, { url: pathToFileURL(originDir).href, branch: 'main' }), shas.production);
    // Reused on the next run.
    assert.equal(fetchProduction(git, { url: pathToFileURL(originDir).href, branch: 'main' }), shas.production);

    // Whole path components only: libs/blocks/marq is not libs/blocks/marquee.
    assert.deepEqual(
      [...existingPaths(git, shas.base, ['libs/blocks/marquee', 'libs/blocks/marq', 'libs/blocks/new-block'])],
      ['libs/blocks/marquee'],
    );
    const changes = classifyChanges(
      parseNameStatus(git(['diff', '--name-status', '--no-renames', shas.base, shas.head])),
      { blockExistedAtBase: (dir) => existingPaths(git, shas.base, [dir]).size > 0 },
    );
    assert.deepEqual(changes.newBlocks, ['new-block']);
    const drift = git(['diff', '--name-only', '--no-renames', shas.production, shas.base]).trim().split('\n');
    assert.deepEqual(drift, ['libs/features/unreleased.js', 'libs/utils/utils.js']);
    const sources = planSources({
      changed: changes.files,
      drift,
      existsAtBase: existingPaths(git, shas.base, [...drift, ...changes.files]),
      existsAtHead: existingPaths(git, shas.head, changes.files),
    });
    assert.deepEqual(sources.unsupported, ['libs/img/logo.png']);
    assert.deepEqual(sources.deleted, ['libs/old.js']);

    const logs = [];
    const dir = join(root, 'sources');
    const { manifest, files } = materializeSources(git, {
      sources,
      revisions: { base: shas.base, head: shas.head },
      dir,
      log: (line) => logs.push(line),
    });
    assert.deepEqual(logs, [], 'the contents were downloaded in one batch');
    const read = (side, path) => readFileSync(join(dir, manifest[side][path]), 'utf8');
    assert.equal(read('before', '/libs/utils/utils.js'), 'stage utils');
    assert.equal(read('after', '/libs/utils/utils.js'), 'stage utils');
    assert.equal(read('before', '/libs/blocks/marquee/marquee.js'), 'marquee v1');
    assert.equal(read('after', '/libs/blocks/marquee/marquee.js'), 'marquee v2');
    assert.equal(read('before', '/libs/features/unreleased.js'), 'unreleased v1');
    assert.equal(read('after', '/libs/features/unreleased.js'), 'unreleased v2');
    assert.equal(read('after', '/libs/blocks/new-block/new-block.js'), 'new block');
    assert.equal(read('before', '/libs/old.js'), 'old');
    assert.equal(manifest.after['/libs/old.js'], undefined);
    assert.equal(manifest.before['/libs/blocks/new-block/new-block.js'], undefined);
    assert.equal(manifest.before['/libs/img/logo.png'], undefined);
    assert.equal(files, 7);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), manifest);
    assert.deepEqual(manifest.changed, [
      '/libs/blocks/marquee/marquee.js',
      '/libs/blocks/new-block/new-block.js',
      '/libs/features/unreleased.js',
      '/libs/old.js',
    ]);
  });
});
