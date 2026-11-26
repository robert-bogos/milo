import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../core.js';
import {
  buildSpec, conciseError, createCertificate, engineWarnings, failureReason, loadSources,
  measurePage, runsFromResults, startSourceServer,
} from '../engine.js';

const root = mkdtempSync(join(tmpdir(), 'perf-engine-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

const metrics = (lcp) => ({ LCP: lcp, CLS: 0.01, TBT: null, FCP: 1000, SI: 2000 });

describe('perf-ab specs and results', () => {
  it('serves each side its own files on the same page', () => {
    const manifest = { before: { '/libs/a.js': 'h1' }, after: { '/libs/a.js': 'h2', '/libs/b.js': 'h3' } };
    const url = 'https://www.adobe.com/?martech=off';
    const spec = buildSpec({ url, manifest, origin: 'https://127.0.0.1:9', runs: 10, device: 'mobile' });
    assert.deepEqual(spec, {
      version: 1,
      runs: 10,
      device: 'mobile',
      names: ['before', 'after'],
      variants: {
        before: { url, sources: { '/libs/a.js': 'https://127.0.0.1:9/h1' } },
        after: { url, sources: { '/libs/a.js': 'https://127.0.0.1:9/h2', '/libs/b.js': 'https://127.0.0.1:9/h3' } },
      },
    });
    const afterOnly = buildSpec({ url, manifest, origin: 'https://127.0.0.1:9', runs: 7, afterOnly: true });
    assert.deepEqual(afterOnly.names, ['after']);
    assert.equal(afterOnly.variants.before, undefined);
  });

  it('turns perf-ab pairs into before/after runs, keeping failed pairs and benchmark indexes', () => {
    const results = {
      pairs: [
        {
          index: 1,
          before: metrics(3000),
          after: metrics(3300),
          job: { benchmarkIndexes: { before: 1500, after: 1400 } },
        },
        { index: 2, before: null, after: null, error: 'pair job failed: timeout', job: null },
      ],
    };
    assert.deepEqual(runsFromResults(results), [
      {
        variant: 'a',
        pair: 0,
        ok: true,
        error: undefined,
        metrics: { lcp: 3000, cls: 0.01, tbt: null, fcp: 1000 },
        benchmarkIndex: 1500,
      },
      {
        variant: 'b',
        pair: 0,
        ok: true,
        error: undefined,
        metrics: { lcp: 3300, cls: 0.01, tbt: null, fcp: 1000 },
        benchmarkIndex: 1400,
      },
      {
        variant: 'a', pair: 1, ok: false, error: 'timeout', metrics: undefined, benchmarkIndex: null,
      },
      {
        variant: 'b', pair: 1, ok: false, error: 'timeout', metrics: undefined, benchmarkIndex: null,
      },
    ]);
    const single = runsFromResults({
      pairs: [{
        index: 1,
        before: null,
        after: metrics(2000),
        job: { benchmarkIndexes: { after: 1200 } },
      }],
    }, { afterOnly: true });
    assert.deepEqual(single.map((run) => [run.variant, run.ok, run.metrics.lcp, run.benchmarkIndex]), [['b', true, 2000, 1200]]);
  });

  it('keeps one warning of each kind, without those the check already handles', () => {
    const warnings = engineWarnings({
      warnings: [
        { kind: 'local-results-not-comparable', message: 'local' },
        { kind: 'environment-variability', message: 'benchmark spread 1.4' },
        { kind: 'production-source-drift', message: 'drift' },
      ],
      sourceWarnings: [{ kind: 'production-source-drift', message: 'again' }, { kind: 'other', pair: 2 }],
    });
    assert.deepEqual(warnings, [
      { kind: 'production-source-drift', message: 'drift' },
      { kind: 'other', message: '' },
    ]);
  });

  it('summarizes why perf-tools measured nothing', () => {
    const si = 'pair job failed: Lighthouse metric(s) missing or not finite: SI (Chrome didn\'t collect any screenshots during the page load. Please make sure there is content visible on the page, and then try re-running Lighthouse. (SPEEDINDEX_OF_ZERO))';
    assert.equal(conciseError(si), 'Lighthouse metric(s) missing or not finite: SI (SPEEDINDEX_OF_ZERO)');
    const pairs = [si, si, 'pair job failed: timeout'].map((error, i) => ({ index: i + 1, error }));
    assert.equal(
      failureReason({ status: 'failed', error: 'pair1: …', pairs }),
      '2 of 3 pairs: Lighthouse metric(s) missing or not finite: SI (SPEEDINDEX_OF_ZERO); 1 of 3 pairs: timeout',
    );
    assert.equal(failureReason({ status: 'failed', errorKind: 'egress' }), 'egress');
  });
});

describe('source server', () => {
  it('serves files over HTTPS with a self-signed certificate and no content type', async () => {
    const dir = mkdtempSync(join(root, 'cert-'));
    const { key, cert } = createCertificate(dir);
    const server = await startSourceServer({ files: new Map([['abc', Buffer.from('export default 1;')]]), key, cert });
    const fetchText = (path) => new Promise((resolve, reject) => {
      get(`${server.origin}${path}`, { ca: cert }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
      }).on('error', reject);
    });
    try {
      assert.match(server.origin, /^https:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual(await fetchText('/abc'), { status: 200, type: undefined, body: 'export default 1;' });
      assert.equal((await fetchText('/missing')).status, 404);
    } finally {
      await server.close();
    }
  });
});

// A stand-in for adobecom/perf-tools: it fetches the "after" sources like perf-ab's proxy does
// (with the global fetch, so the local certificate must be trusted) and writes perf-ab results.
const FAKE_LOCAL = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runLocal({ spec, out, measurePair }) {
  const { url, sources } = spec.variants.after;
  if (url.includes('/broken')) throw new Error('invalid spec: broken\\nstack');
  const job = await measurePair({ spec, out, pair: 1, where: 'local' });
  const served = [];
  for (const [path, source] of Object.entries(url.includes('/unused') ? {} : sources)) {
    const res = await fetch(source);
    if (res.ok && (await res.text())) served.push(path);
  }
  const write = (file, data) => {
    mkdirSync(join(out, file, '..'), { recursive: true });
    writeFileSync(join(out, file), JSON.stringify(data));
  };
  write('pair1/before/run.json', { sourcesServed: [] });
  write('pair1/after/run.json', { sourcesServed: served });
  const metrics = (lcp) => ({ LCP: lcp, CLS: 0, TBT: 10, FCP: 900, SI: 1500 });
  const results = {
    status: 'ok',
    pairs: [{ index: 1, before: metrics(3000), after: metrics(3100), job: { benchmarkIndexes: { before: 900, after: 950 } } }],
    runs: [
      { variant: 'before', run: 1, pair: 1, dir: 'pair1/before' },
      { variant: 'after', run: 1, pair: 1, dir: 'pair1/after' },
    ],
    warnings: [{ kind: 'local-results-not-comparable', message: 'local' }],
    sourceWarnings: [],
    lighthouseVersion: '13.6.0',
    chromeVersion: '140.0.0.0',
    attempts: job.attempts,
    jobs: job.calls,
    spec,
  };
  write('results.json', results);
  return results;
}
`;
const FAKE_JOB = `
const calls = [];
export async function runJob({ spec, pair, attempts }) {
  calls.push({ names: spec.names, runs: spec.runs, pair, attempts });
  return { status: 'ok', attempts, calls };
}
`;

describe('measurePage', () => {
  const toolsDir = join(root, 'perf-tools');
  mkdirSync(join(toolsDir, 'lib', 'pagespeed'), { recursive: true });
  writeFileSync(join(toolsDir, 'lib', 'pagespeed', 'local.mjs'), FAKE_LOCAL);
  writeFileSync(join(toolsDir, 'lib', 'pagespeed', 'job.mjs'), FAKE_JOB);
  const sourcesDir = join(root, 'sources');
  mkdirSync(sourcesDir);
  writeFileSync(join(sourcesDir, 'h1'), 'before a');
  writeFileSync(join(sourcesDir, 'h2'), 'after a');
  writeFileSync(join(sourcesDir, 'h3'), 'drift');
  const manifest = {
    before: { '/libs/a.js': 'h1', '/libs/drift.js': 'h3' },
    after: { '/libs/a.js': 'h2', '/libs/drift.js': 'h3' },
    changed: ['/libs/a.js'],
  };
  const config = { ...loadConfig(), pairs: 3, engineTimeoutMinutes: 2 };
  const measure = (id, url) => measurePage({
    entry: { id, round: 1, kind: 'compare', gate: true, url },
    manifest,
    files: loadSources(sourcesDir, manifest),
    config,
    toolsDir,
    workDir: join(root, 'work', id),
  });

  it('measures the page with the swapped files and reports what was served', async () => {
    const result = await measure('photoshop', 'https://www.adobe.com/products/photoshop.html');
    assert.equal(result.error, undefined);
    assert.deepEqual(result.served, ['/libs/a.js']);
    assert.deepEqual(result.runs.map((run) => [run.variant, run.metrics.lcp]), [['a', 3000], ['b', 3100]]);
    assert.deepEqual(result.engine, { status: 'ok', error: undefined, rejected: 0, lighthouseVersion: '13.6.0', chromeVersion: '140.0.0.0' });
    assert.deepEqual(result.warnings, []);
    const results = JSON.parse(readFileSync(join(root, 'work', 'photoshop', 'perf-ab', 'results.json'), 'utf8'));
    assert.equal(results.attempts, 2);
    assert.deepEqual(results.jobs, [
      { names: ['after'], runs: 1, pair: 1, attempts: 1 },
      { names: ['before', 'after'], runs: 3, pair: 1, attempts: 2 },
    ]);
    assert.equal(results.spec.runs, 3);
    assert.equal(results.spec.variants.before.url, 'https://www.adobe.com/products/photoshop.html?martech=off');
  });

  it('is inconclusive when the changed files were never requested', async () => {
    const result = await measure('unused', 'https://www.adobe.com/unused.html');
    assert.equal(result.error, 'the changed files were not requested during the measured loads');
  });

  it('reports why perf-tools failed', async () => {
    const result = await measure('broken', 'https://www.adobe.com/broken.html');
    assert.equal(result.error, 'perf-tools did not finish (invalid spec: broken)');
  });
});
