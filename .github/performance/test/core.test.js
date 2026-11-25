import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_MARKER, classifyChanges, classifyPage, confirmVerdict, evaluateResult, expectedLibsOrigin,
  libsPaths, loadConfig, measureEntry, parseDemoUrls, parseNameStatus, previewOrigin, renderReport,
  validateDemoUrl, variantHostError, variantUrl, verifyServed,
} from '../core.js';

const config = loadConfig();
const STAGE = 'https://stage--milo--adobecom.aem.live';
const BRANCH = 'https://feat--milo--adobecom.aem.live';

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

describe('preview hosts and page variants', () => {
  it('builds aem.live origins the way branch previews are named', () => {
    assert.equal(previewOrigin({ ref: 'Feature/MWPW-123_Café', repo: 'milo', owner: 'adobecom' }), 'https://feature-mwpw-123-cafe--milo--adobecom.aem.live');
    assert.equal(previewOrigin({ ref: 'x'.repeat(50), repo: 'milo', owner: 'adobecom' }), null);
  });

  it('points consumer pages at the variant with milolibs', () => {
    assert.equal(
      variantUrl('https://main--da-cc--adobecom.aem.live/products/photoshop?milolibs=main', STAGE),
      'https://main--da-cc--adobecom.aem.live/products/photoshop?milolibs=stage--milo--adobecom&martech=off',
    );
    assert.equal(expectedLibsOrigin('https://main--da-cc--adobecom.aem.live/x', BRANCH), BRANCH);
  });

  it('re-hosts Milo pages on the variant branch and keeps drafts on .aem.page', () => {
    const url = 'https://main--milo--adobecom.aem.page/drafts/perf/demo';
    assert.equal(variantUrl(url, BRANCH), 'https://feat--milo--adobecom.aem.page/drafts/perf/demo?martech=off');
    assert.equal(expectedLibsOrigin(url, BRANCH), 'https://feat--milo--adobecom.aem.page');
  });
});

describe('demo pages', () => {
  it('reads labelled demo URLs from the PR description', () => {
    const body = [
      '- Before: https://main--milo--adobecom.aem.page/?martech=off',
      '- Demo: https://main--da-cc--adobecom.aem.live/products/photoshop.',
      '* **Demo URL:** [page](https://main--da-dc--adobecom.aem.live/acrobat)',
      'Performance demo: https://main--da-cc--adobecom.aem.live/products/photoshop',
      'Demo page: https://www.adobe.com/products/photoshop.html',
      'The demo is great: no URL here',
      '- Demo: https://main--<site>--adobecom.aem.live/<page>',
    ].join('\r\n');
    assert.deepEqual(parseDemoUrls(body), [
      'https://main--da-cc--adobecom.aem.live/products/photoshop',
      'https://main--da-dc--adobecom.aem.live/acrobat',
      'https://www.adobe.com/products/photoshop.html',
    ]);
    assert.deepEqual(parseDemoUrls(null), []);
  });

  it('accepts live aem pages and drafts only for new blocks', () => {
    assert.deepEqual(
      validateDemoUrl('https://main--da-cc--adobecom.aem.live/x?milolibs=foo&martech=off#top'),
      { url: 'https://main--da-cc--adobecom.aem.live/x' },
    );
    assert.match(validateDemoUrl('https://www.adobe.com/products/photoshop.html').error, /production/);
    assert.match(validateDemoUrl('http://main--da-cc--adobecom.aem.live/x').error, /https/);
    assert.match(validateDemoUrl('https://example.com/x').error, /aem\.live/);
    const draft = 'https://main--da-cc--adobecom.aem.page/drafts/x';
    assert.match(validateDemoUrl(draft).error, /new blocks/);
    assert.equal(validateDemoUrl(draft, { allowDraft: true }).url, draft);
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
  const discovery = {
    a: { ok: true, paths: ['/libs/utils/utils.js', '/libs/blocks/marquee/marquee.js'] },
    b: { ok: true, paths: ['/libs/utils/utils.js', '/libs/blocks/marquee/marquee.js'] },
  };

  it('measures pages that load a changed file', () => {
    assert.equal(classifyPage({ discovery, changedPaths: ['/libs/blocks/marquee/marquee.js'] }).status, 'measure');
    assert.equal(classifyPage({ discovery, changedPaths: ['/libs/blocks/tabs/tabs.js'] }).status, 'unaffected');
  });

  it('does not attribute newer base-branch changes to the pull request', () => {
    const page = classifyPage({ discovery, changedPaths: ['/libs/blocks/marquee/marquee.js'], driftPaths: ['libs/utils/utils.js', 'libs/blocks/tabs/tabs.js'] });
    assert.deepEqual(page, { status: 'stale', hits: ['/libs/blocks/marquee/marquee.js'], drift: ['/libs/utils/utils.js'] });
  });

  it('reports pages that could not be loaded', () => {
    const page = classifyPage({ discovery: { ...discovery, b: { ok: false, error: 'boom' } }, changedPaths: [] });
    assert.deepEqual(page, { status: 'error', reason: 'boom', hits: [], drift: [] });
  });

  it('keeps only Milo files from the expected origin and checks the variant host', () => {
    const libs = [`${STAGE}/libs/utils/utils.js`, 'https://www.adobe.com/libs/other.js', 'not a url'];
    assert.deepEqual(libsPaths(libs, STAGE), ['/libs/utils/utils.js']);
    assert.equal(variantHostError(libs, STAGE, BRANCH), null);
    assert.match(variantHostError(libs, BRANCH, STAGE), /did not load Milo from/);
    assert.match(variantHostError([...libs, `${BRANCH}/libs/x.js`], STAGE, BRANCH), /also loaded/);
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
    const result = compareResult(lcps.map((lcp) => ({ lcp })), lcps.map((lcp) => ({ lcp })));
    result.runs[5].benchmarkIndex = 500;
    const verdict = evaluateResult(result, config);
    assert.equal(verdict.discarded, 1);
    assert.equal(verdict.pairs, 6);
    assert.equal(verdict.status, 'pass');
  });

  it('is inconclusive without enough usable pairs', () => {
    const result = compareResult(lcps.map((lcp) => ({ lcp })), lcps.map((lcp) => ({ lcp })));
    result.runs.slice(0, 6).forEach((sample) => { sample.ok = false; });
    assert.equal(evaluateResult(result, config).status, 'inconclusive');
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

describe('measureEntry', () => {
  const entry = {
    id: 'page', kind: 'compare', gate: true, round: 1, a: 'https://site/a', b: 'https://site/b', aLibs: STAGE, bLibs: BRANCH,
  };
  const runner = (overrides = {}) => {
    const calls = [];
    const runOnce = async (url, { variant }) => {
      calls.push(variant);
      const override = overrides[calls.length];
      return {
        ok: true,
        benchmarkIndex: 1000,
        metrics: { lcp: 3000, cls: 0, tbt: 0, fcp: 1000 },
        libs: [`${variant === 'a' ? STAGE : BRANCH}/libs/utils/utils.js`],
        ...override,
      };
    };
    return { calls, runOnce };
  };

  it('warms up both variants, then interleaves counterbalanced pairs', async () => {
    const { calls, runOnce } = runner();
    const result = await measureEntry(entry, config, { runOnce });
    assert.deepEqual(calls, ['a', 'b', 'a', 'b', 'b', 'a', 'a', 'b', 'b', 'a', 'a', 'b', 'b', 'a', 'a', 'b']);
    assert.equal(result.warmups.length, 2);
    assert.equal(result.runs.length, 14);
    assert.equal(evaluateResult(result, config).status, 'pass');
  });

  it('replaces failed pairs with extra pairs', async () => {
    const { runOnce } = runner({ 6: { ok: false, error: 'timeout' }, 9: { libs: [`${STAGE}/libs/utils/utils.js`] } });
    const result = await measureEntry(entry, config, { runOnce });
    assert.equal(result.runs.length, 18);
    assert.equal(evaluateResult(result, config).pairs, 7);
  });

  it('stops when a warm-up loads Milo from the wrong host', async () => {
    const { calls, runOnce } = runner({ 2: { libs: [`${STAGE}/libs/utils/utils.js`] } });
    const result = await measureEntry(entry, config, { runOnce });
    assert.equal(calls.length, 2);
    assert.match(result.error, /^the after page did not load Milo from https:\/\/feat--milo/);
  });

  it('stops after three failed pairs and when the time budget runs out', async () => {
    const failing = await measureEntry(entry, config, { runOnce: async () => ({ ok: false, error: 'down' }) });
    assert.equal(failing.runs.length, 6);
    assert.match(failing.error, /every run failed \(down\)/);
    let clock = 0;
    const slow = await measureEntry(entry, config, {
      runOnce: runner().runOnce,
      now: () => {
        clock += 4 * 60000;
        return clock;
      },
    });
    assert.ok(slow.runs.length < 14);
    assert.deepEqual(slow.notes, ['stopped early: time budget reached']);
  });
});

describe('verifyServed', () => {
  it('retries until the preview serves the committed files', async () => {
    let attempt = 0;
    const fetchImpl = async (url) => {
      if (url.includes('deleted.js')) return { ok: false, status: 404 };
      attempt += 1;
      const body = attempt > 1 ? 'new' : 'old';
      const { buffer } = new TextEncoder().encode(body);
      return { ok: true, status: 200, arrayBuffer: async () => buffer };
    };
    const files = [{ path: 'libs/a.js', expected: Buffer.from('new') }, { path: 'libs/deleted.js', expected: null }];
    const result = await verifyServed(files, { origin: BRANCH, fetchImpl, sleep: async () => {} });
    assert.deepEqual(result, { ok: true, mismatches: [], attempts: 2 });
    const stale = await verifyServed(files.slice(0, 1), {
      origin: BRANCH,
      attempts: 1,
      fetchImpl: async () => ({ ok: false, status: 404 }),
      sleep: async () => {},
    });
    assert.deepEqual(stale.mismatches, ['libs/a.js (HTTP 404)']);
  });
});

describe('renderReport', () => {
  const entry = {
    id: 'photoshop', label: 'Photoshop', kind: 'compare', production: 'https://www.adobe.com/products/photoshop.html', a: 'https://a', b: 'https://b',
  };
  const plan = {
    status: 'measure', headSha: '0123456789', aLibs: STAGE, bLibs: BRANCH, entries: [entry], pages: [],
  };
  const failing = evaluateResult(compareResult(
    lcps.map((lcp) => ({ lcp })),
    lcps.map((lcp) => ({ lcp: lcp * 1.2 })),
    { id: 'photoshop' },
  ), config);

  it('reports a confirmed regression and whether it blocks', () => {
    const verdict = { ...confirmVerdict(failing, failing), id: 'photoshop', kind: 'compare' };
    const report = renderReport({ plan, verdicts: [verdict], config });
    assert.equal(report.status, 'fail');
    assert.ok(report.body.startsWith(REPORT_MARKER));
    assert.match(report.body, /### ❌ Performance regression confirmed \(report only, not blocking\)/);
    assert.match(report.body, /\| \[Photoshop\]\(https:\/\/www\.adobe\.com\/products\/photoshop\.html\) \| 3,016 ms → 3,619 ms \| \+603 ms \(\+20\.0%\) \| 0\.008 \|/);
    assert.match(report.body, /LCP regression, confirmed by re-run/);
    assert.doesNotMatch(renderReport({ plan, verdicts: [verdict], config, enforce: true }).body, /not blocking/);
  });

  it('explains unreproduced slowdowns, stale pages and missing demo pages', () => {
    const passed = { ...confirmVerdict(failing, { status: 'pass', regressed: [] }), id: 'photoshop', kind: 'compare' };
    const stalePlan = { ...plan, pages: [{ label: 'Homepage', status: 'stale', drift: ['/libs/utils/utils.js'] }] };
    const report = renderReport({ plan: stalePlan, verdicts: [passed], config });
    assert.equal(report.status, 'inconclusive');
    assert.match(report.body, /LCP slower, but not reproduced on re-run/);
    assert.match(report.body, /Homepage: the base branch changed files this page loads \(\/libs\/utils\/utils\.js\)/);
    const policy = renderReport({
      plan: { status: 'skip', policy: 'Add a demo page.', entries: [], pages: [] },
      config,
    });
    assert.equal(policy.status, 'fail');
    assert.match(policy.body, /### ❌ Demo page needed/);
  });
});
