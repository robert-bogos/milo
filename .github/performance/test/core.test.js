import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_MARKER, classifyChanges, classifyPage, confirmVerdict, evaluateResult, libsPaths,
  loadConfig, parseDemoUrls, parseNameStatus, renderReport, validateDemoUrl,
} from '../core.js';

const config = loadConfig();
const WWW = 'https://www.adobe.com';
const MILO = 'https://main--milo--adobecom.aem.live';

function run(variant, pair, metrics = {}, benchmarkIndex = 1000) {
  return {
    variant,
    pair,
    ok: true,
    benchmarkIndex,
    metrics: { lcp: 3000, cls: 0.01, tbt: 300, fcp: 1500, ...metrics },
  };
}

function compareResult(before, after, extra = {}) {
  return {
    id: 'page',
    kind: 'compare',
    gate: true,
    runs: before.flatMap((metrics, i) => [run('a', i, metrics), run('b', i, after[i])]),
    ...extra,
  };
}

const lcps = [3000, 3100, 2950, 3050, 3020, 2980, 3010];

describe('demo pages', () => {
  it('reads labelled demo URLs from the PR description', () => {
    const body = [
      '- Before: https://main--milo--adobecom.aem.page/?martech=off',
      '- Demo: https://www.adobe.com/products/photoshop.html.',
      '* **Demo URL:** [page](https://main--milo--adobecom.aem.live/drafts/perf/demo)',
      'Performance demo: https://www.adobe.com/products/photoshop.html',
      'Demo page: https://business.adobe.com/',
      'The demo is great: no URL here',
      '- Demo: https://www.adobe.com/<page>.html',
    ].join('\r\n');
    assert.deepEqual(parseDemoUrls(body), [
      'https://www.adobe.com/products/photoshop.html',
      'https://main--milo--adobecom.aem.live/drafts/perf/demo',
      'https://business.adobe.com/',
    ]);
    assert.deepEqual(parseDemoUrls(null), []);
  });

  it('accepts production pages and published Milo pages, whose /libs/ can be swapped', () => {
    assert.deepEqual(
      validateDemoUrl(`${WWW}/products/photoshop.html?milolibs=foo&martech=off#top`),
      { url: `${WWW}/products/photoshop.html` },
    );
    assert.deepEqual(validateDemoUrl(`${MILO}/drafts/perf/demo`), { url: `${MILO}/drafts/perf/demo` });
    assert.match(validateDemoUrl('https://main--milo--adobecom.aem.page/drafts/x').error, /publish the page/);
    assert.match(validateDemoUrl('https://main--da-cc--adobecom.aem.live/x').error, /another host/);
    assert.match(validateDemoUrl('https://www.stage.adobe.com/x').error, /another host/);
    assert.match(validateDemoUrl('http://www.adobe.com/x').error, /https/);
    assert.match(validateDemoUrl('https://www.adobe.com:8443/x').error, /port/);
    assert.match(validateDemoUrl('https://www.adobe.com.example.com/x').error, /production \*\.adobe\.com/);
    assert.match(validateDemoUrl('https://adobe.com/x').error, /production \*\.adobe\.com/);
    assert.match(validateDemoUrl('www.adobe.com').error, /not a valid URL/);
  });
});

describe('changed files', () => {
  it('parses name-status output, including renames', () => {
    assert.deepEqual(parseNameStatus('M\tlibs/a.js\nR100\tlibs/old.js\tlibs/new.js\n'), [
      { status: 'M', path: 'libs/a.js' },
      { status: 'R', path: 'libs/new.js', previousPath: 'libs/old.js' },
    ]);
  });

  it('keeps runtime libs files and detects blocks that did not exist at the merge base', () => {
    const changes = classifyChanges([
      { status: 'M', path: 'libs/utils/utils.js' },
      { status: 'A', path: 'libs/blocks/New-Block/New-Block.js' },
      { status: 'A', path: 'libs/c2/blocks/fresh/fresh.js' },
      { status: 'A', path: 'libs/blocks/marquee/marquee.js' },
      { status: 'R', path: 'libs/features/b.js', previousPath: 'libs/features/a.js' },
      { status: 'M', path: 'libs/blocks/marquee/README.md' },
      { status: 'M', path: 'libs/.eslintrc.js' },
      { status: 'M', path: 'libs/blocks/marquee/test/marquee.test.js' },
      { status: 'M', path: 'test/blocks/marquee/marquee.test.js' },
      { status: 'M', path: 'nala/blocks/marquee.test.js' },
    ], { blockExistedAtBase: (dir) => dir === 'libs/blocks/marquee' });
    // Repository paths keep their case (to read the files); URL paths are lowercase.
    assert.deepEqual(changes.files, [
      'libs/utils/utils.js',
      'libs/blocks/New-Block/New-Block.js',
      'libs/c2/blocks/fresh/fresh.js',
      'libs/blocks/marquee/marquee.js',
      'libs/features/b.js',
      'libs/features/a.js',
    ]);
    assert.deepEqual(changes.paths, [
      '/libs/utils/utils.js',
      '/libs/blocks/new-block/new-block.js',
      '/libs/c2/blocks/fresh/fresh.js',
      '/libs/blocks/marquee/marquee.js',
      '/libs/features/b.js',
      '/libs/features/a.js',
    ]);
    assert.deepEqual(changes.newBlocks, ['New-Block', 'fresh']);
  });
});

describe('page discovery', () => {
  const libs = (origin, ...paths) => paths.map((path) => `${origin}${path}`);
  const page = (discovery, changedPaths, extra = {}) => classifyPage({
    discovery,
    origin: WWW,
    changedPaths,
    ...extra,
  });
  const marquee = '/libs/blocks/marquee/marquee.js';

  it('measures pages that load a changed file from their own host', () => {
    const discovery = { ok: true, libs: libs(WWW, '/libs/utils/utils.js', marquee) };
    assert.deepEqual(page(discovery, [marquee, '/libs/blocks/tabs/tabs.js']), { status: 'measure', hits: [marquee] });
    assert.deepEqual(page(discovery, ['/libs/blocks/tabs/tabs.js']), { status: 'unaffected', hits: [] });
  });

  it('reports pages whose changed files cannot be swapped in', () => {
    assert.deepEqual(page({ ok: false, error: 'boom' }, []), { status: 'error', reason: 'boom', hits: [] });
    assert.equal(page({ ok: true, libs: [] }, []).reason, 'did not load Milo');
    const otherHost = { ok: true, libs: libs(MILO, '/libs/utils/utils.js') };
    assert.equal(page(otherHost, ['/libs/utils/utils.js']).reason, `loads Milo from ${MILO}, not from ${WWW}`);
    const mixed = {
      ok: true,
      libs: [...libs(WWW, '/libs/utils/utils.js'), ...libs('https://milo.adobe.com', marquee)],
    };
    assert.equal(page(mixed, [marquee]).reason, `loads ${marquee} from another host`);
    const image = { ok: true, libs: libs(WWW, '/libs/utils/utils.js', '/libs/img/logo.png') };
    const unsupported = ['/libs/img/logo.png'];
    assert.match(page(image, unsupported, { unsupported }).reason, /cannot be swapped in/);
    assert.equal(page(image, [...unsupported, '/libs/utils/utils.js'], { unsupported }).status, 'measure');
  });

  it('keeps only /libs/ files from the page host', () => {
    const urls = [`${WWW}/libs/Utils/utils.js`, 'https://milo.adobe.com/libs/x.js', `${WWW}/blocks/x.js`, 'not a url'];
    assert.deepEqual(libsPaths(urls, WWW), ['/libs/utils/utils.js']);
  });
});

describe('evaluateResult', () => {
  it('fails a consistent LCP slowdown above the threshold', () => {
    const verdict = evaluateResult(compareResult(
      lcps.map((lcp) => ({ lcp })),
      lcps.map((lcp) => ({ lcp: lcp * 1.2 })),
    ), config);
    assert.equal(verdict.status, 'fail');
    assert.deepEqual(verdict.regressed, ['lcp']);
    assert.equal(verdict.metrics.lcp.p, 1 / 128);
  });

  it('passes when a single noisy pair causes the slowdown', () => {
    const verdict = evaluateResult(compareResult(
      lcps.map((lcp) => ({ lcp })),
      lcps.map((lcp, i) => ({ lcp: i === 3 ? lcp + 5000 : lcp - 20 })),
    ), config);
    assert.equal(verdict.metrics.lcp.exceeds, true);
    assert.equal(verdict.metrics.lcp.significant, false);
    assert.equal(verdict.status, 'pass');
  });

  it('passes a consistent slowdown below the threshold', () => {
    const verdict = evaluateResult(compareResult(
      lcps.map((lcp) => ({ lcp })),
      lcps.map((lcp) => ({ lcp: lcp * 1.05 })),
    ), config);
    assert.equal(verdict.metrics.lcp.significant, true);
    assert.equal(verdict.status, 'pass');
  });

  it('uses an absolute CLS threshold and keeps TBT informational', () => {
    const verdict = evaluateResult(compareResult(
      lcps.map((lcp) => ({ lcp })),
      lcps.map((lcp, i) => ({ lcp, cls: 0.05 + i / 1000, tbt: 900 + i })),
    ), config);
    assert.equal(verdict.status, 'fail');
    assert.deepEqual(verdict.regressed, ['cls']);
    assert.deepEqual(verdict.informational, ['tbt']);
  });

  it('only warns for reference pages', () => {
    const verdict = evaluateResult(compareResult(
      lcps.map((lcp) => ({ lcp })),
      lcps.map((lcp) => ({ lcp: lcp * 1.2 })),
      { gate: false },
    ), config);
    assert.equal(verdict.status, 'warn');
  });

  it('discards pairs measured on an unusually slow runner', () => {
    const tenPairs = [...lcps, 3040, 2990, 3060].map((lcp) => ({ lcp }));
    const result = compareResult(tenPairs, tenPairs);
    result.runs[5].benchmarkIndex = 500;
    const verdict = evaluateResult(result, config);
    assert.equal(verdict.discarded, 1);
    assert.equal(verdict.pairs, 9);
    assert.equal(verdict.status, 'pass');
  });

  it('is inconclusive without enough usable pairs', () => {
    const result = compareResult(lcps.map((lcp) => ({ lcp })), lcps.map((lcp) => ({ lcp })));
    result.runs.slice(0, 6).forEach((sample) => {
      sample.ok = false;
      sample.error = 'SI (SPEEDINDEX_OF_ZERO)';
    });
    const verdict = evaluateResult(result, config);
    assert.equal(verdict.status, 'inconclusive');
    assert.equal(verdict.reason, 'only 4 usable pairs (need 7); 3 failed: SI (SPEEDINDEX_OF_ZERO)');
    assert.equal(evaluateResult(undefined, config).status, 'inconclusive');
    assert.equal(evaluateResult({ ...result, error: 'setup' }, config).reason, 'setup');
  });

  it('checks new blocks against the green bands, gating only CLS by default', () => {
    const runs = lcps.map((lcp, i) => run('b', i, { lcp: 4000, cls: 0.02, tbt: 900 }));
    const passing = evaluateResult({ id: 'demo-1', kind: 'after-only', gate: true, runs }, config);
    assert.equal(passing.status, 'pass');
    assert.deepEqual(passing.informational, ['lcp', 'tbt']);
    runs.forEach((sample) => { sample.metrics.cls = 0.2; });
    const failing = evaluateResult({ id: 'demo-1', kind: 'after-only', gate: true, runs }, config);
    assert.equal(failing.status, 'fail');
    assert.deepEqual(failing.regressed, ['cls']);
  });
});

describe('confirmVerdict', () => {
  const fail = (regressed) => ({ status: 'fail', regressed });

  it('fails only when the re-run reproduces the same regression', () => {
    assert.equal(confirmVerdict(fail(['lcp']), fail(['lcp', 'cls'])).status, 'fail');
    assert.deepEqual(confirmVerdict(fail(['lcp']), fail(['lcp', 'cls'])).regressed, ['lcp']);
    const unconfirmed = confirmVerdict(fail(['lcp']), fail(['cls']));
    assert.equal(unconfirmed.status, 'pass');
    assert.deepEqual(unconfirmed.unconfirmed, ['lcp']);
    assert.equal(confirmVerdict(fail(['lcp']), { status: 'pass', regressed: [] }).status, 'pass');
  });

  it('is inconclusive when the re-run is missing or inconclusive', () => {
    assert.equal(confirmVerdict(fail(['lcp'])).status, 'inconclusive');
    assert.equal(confirmVerdict(fail(['lcp']), { status: 'inconclusive', reason: 'x' }).status, 'inconclusive');
    assert.equal(confirmVerdict({ status: 'pass', regressed: [] }).status, 'pass');
  });
});

describe('renderReport', () => {
  const entry = { id: 'photoshop', label: 'Photoshop', kind: 'compare', gate: true, url: `${WWW}/products/photoshop.html` };
  const plan = { status: 'measure', mergeBase: 'abcdef0123', headSha: '0123456789', entries: [entry], pages: [] };
  const failing = evaluateResult(compareResult(
    lcps.map((lcp) => ({ lcp })),
    lcps.map((lcp) => ({ lcp: lcp * 1.2 })),
    { id: 'photoshop' },
  ), config);

  it('reports a confirmed regression, the compared commits and whether it blocks', () => {
    const verdict = { ...confirmVerdict(failing, failing), id: 'photoshop', kind: 'compare' };
    const report = renderReport({ plan, verdicts: [verdict], config });
    assert.equal(report.status, 'fail');
    assert.ok(report.body.startsWith(REPORT_MARKER));
    assert.match(report.body, /### ❌ Performance regression confirmed \(report only, not blocking\)/);
    assert.match(report.body, /Before: merge base `abcdef0` · After: `0123456`/);
    assert.match(report.body, /\| \[Photoshop\]\(https:\/\/www\.adobe\.com\/products\/photoshop\.html\) \| 3,016 ms → 3,619 ms \| \+603 ms \(\+20\.0%\) \| 0\.008 \|/);
    assert.match(report.body, /LCP regression, confirmed by re-run/);
    assert.match(report.body, /`perf-traces-\*` artifacts/);
    assert.match(report.body, /\n- Photoshop: https:\/\/www\.adobe\.com\/products\/photoshop\.html\n/);
    assert.doesNotMatch(renderReport({ plan, verdicts: [verdict], config, enforce: true }).body, /not blocking/);
  });

  it('explains unreproduced slowdowns, files that were not swapped and perf-tools warnings', () => {
    const warned = { ...failing, warnings: [{ kind: 'environment-variability', message: 'spread' }] };
    const passed = { ...confirmVerdict(warned, { status: 'pass', regressed: [] }), id: 'photoshop', kind: 'compare' };
    const report = renderReport({
      plan: {
        ...plan,
        sources: { unsupported: ['libs/img/logo.png'], deleted: ['libs/old.js'] },
        unreleased: ['libs/features/new.js'],
      },
      verdicts: [passed],
      config,
    });
    assert.equal(report.status, 'pass');
    assert.match(report.body, /LCP slower, but not reproduced on re-run/);
    assert.match(report.body, /so these changes were not measured: `libs\/img\/logo\.png`/);
    assert.match(report.body, /Deleting files cannot be emulated \(production still serves them\): `libs\/old\.js`/);
    assert.match(report.body, /`libs\/features\/new\.js` is not on production yet/);
    assert.match(report.body, /Photoshop: perf-tools warned `environment-variability`: spread/);
    assert.doesNotMatch(report.body, /perf-traces/);
  });

  it('asks for a demo page, and is inconclusive when pages could not be checked', () => {
    const policy = renderReport({
      plan: { status: 'skip', policy: 'Add a demo page.', entries: [], pages: [] },
      config,
    });
    assert.equal(policy.status, 'fail');
    assert.match(policy.body, /### ❌ Demo page needed/);
    const skipped = { status: 'skip', entries: [], pages: [{ label: 'Homepage', status: 'unaffected' }] };
    assert.equal(renderReport({ plan: skipped, config }).status, 'skipped');
    const errored = {
      ...skipped,
      pages: [...skipped.pages, { label: 'Business', status: 'error', reason: 'did not load Milo' }],
    };
    const report = renderReport({ plan: errored, config });
    assert.equal(report.status, 'inconclusive');
    assert.match(report.body, /### ⚠️ Performance check inconclusive/);
    assert.match(report.body, /Business: could not be checked \(did not load Milo\)/);
  });
});
