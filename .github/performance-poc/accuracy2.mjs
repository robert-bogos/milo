/* eslint-disable no-console, max-len, import/no-extraneous-dependencies, import/newline-after-import */
// POC only (accuracy v2): measures stage against itself (A/A) or against a small regression
// injected into the "after" variant. Every measured run is also re-audited from the same trace
// with alternative Lantern settings, so decision rules can be compared offline:
//   m  = default simulation (what the check uses today)
//   mp = per-origin RTT/server latency pinned to the median of the warm-up runs
//   mc = CPU slowdown normalised by the run's benchmarkIndex
// Usage: node accuracy2.mjs <page id> <aa|cpuN|clsN>   (N = busy-wait ms or shift px)
// Env: POC_ROUND, POC_OUT, POC_PAIRS (15), POC_WARMUPS (2), POC_SETTINGS (default|quiet)
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../performance/', import.meta.url));
const require = createRequire(`${root}package.json`);
const puppeteer = require('puppeteer-core');
const lh = `${root}node_modules/lighthouse/core/`;
const { default: lighthouse } = await import(`${lh}index.js`);
const { initializeConfig } = await import(`${lh}config/config.js`);
const { Runner } = await import(`${lh}runner.js`);
const { NetworkAnalysis } = await import(`${lh}computed/network-analysis.js`);
const { LoadSimulator } = await import(`${lh}computed/load-simulator.js`);
const { ProcessedNavigation } = await import(`${lh}computed/processed-navigation.js`);
const constants = await import(`${lh}config/constants.js`);
const { launch } = await import(`${root}node_modules/chrome-launcher/dist/index.js`);
const core = await import(`${root}core.js`);
const { sampleFromLhr } = await import(`${root}runner.js`);

const top = (body) => `if (window.top === window) { ${body} }`;
const busy = (ms) => top(`const s = performance.now(); while (performance.now() - s < ${ms}) {}`);
// Prepends an N px block to the body half a second after main has content (shifts the page by N px).
const shift = (px) => top(`const start = performance.now(); const tick = () => { const h = document.querySelector('main')?.getBoundingClientRect().height || 0; if (h > 300) setTimeout(() => { const d = document.createElement('div'); d.style.height = '${px}px'; document.body.prepend(d); }, 500); else if (performance.now() - start < 30000) setTimeout(tick, 100); }; addEventListener('DOMContentLoaded', tick);`);

function injection(scenario) {
  if (scenario === 'aa') return null;
  if (scenario === 'cls') return shift(150);
  const match = /^(cpu|cls)(\d+)$/.exec(scenario || '');
  if (!match) return undefined;
  return match[1] === 'cpu' ? busy(Number(match[2])) : shift(Number(match[2]));
}

const SETTINGS = {
  default: {},
  quiet: { pauseAfterLoadMs: 3000, networkQuietThresholdMs: 3000, cpuQuietThresholdMs: 3000 },
};
const AUDITS = ['largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time', 'first-contentful-paint', 'network-requests'];
const FLAGS = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])];
const BEFORE = 'https://stage--milo--adobecom.aem.live';

const config = core.loadConfig();
const [pageId, scenario] = process.argv.slice(2);
const page = config.pages.find((item) => item.id === pageId);
const script = injection(scenario);
const settingsName = process.env.POC_SETTINGS || 'default';
if (!page || script === undefined || !SETTINGS[settingsName]) {
  console.error(`Usage: node accuracy2.mjs <${config.pages.map((item) => item.id).join('|')}> <aa|cpuN|clsN>`);
  process.exit(2);
}
config.pairs = Number(process.env.POC_PAIRS || 15);
config.warmupRuns = Number(process.env.POC_WARMUPS || 2);
const round = Number(process.env.POC_ROUND || 1);
const out = process.env.POC_OUT || 'accuracy-results.jsonl';

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!sorted.length) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const medianMap = (maps) => Object.fromEntries([...new Set(maps.flatMap(Object.keys))]
  .map((key) => [key, median(maps.map((map) => map[key]))])
  .filter(([, value]) => Number.isFinite(value)));
const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : value);

async function reaudit(artifacts, flags) {
  const { resolvedConfig } = await initializeConfig('navigation', undefined, flags);
  const result = await Runner.audit(
    { ...artifacts, settings: resolvedConfig.settings },
    { resolvedConfig, computedCache: new Map() },
  );
  return sampleFromLhr(result.lhr).metrics;
}

// Observed (unthrottled) timings and the LCP element kind, to spot LCP element flips.
async function observed(artifacts) {
  try {
    const nav = await ProcessedNavigation.request(artifacts.Trace, { computedCache: new Map() });
    const data = nav.largestContentfulPaintEvt?.args?.data || {};
    return {
      lcp: round1(nav.timings.largestContentfulPaint),
      fcp: round1(nav.timings.firstContentfulPaint),
      load: round1(nav.timings.load),
      type: data.type,
      size: data.size,
      node: data.nodeName,
    };
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 100) };
  }
}

const warm = { lantern: [], bi: [] };
let pinned;
let biRef;
let calls = 0;

async function runOnce(url, { variant }) {
  const index = calls;
  calls += 1;
  const chrome = await launch({ chromeFlags: FLAGS, logLevel: 'silent' });
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
    const tab = await browser.newPage();
    await tab.evaluateOnNewDocument((variant === 'b' && script) || '/* control */');
    const flags = {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      maxWaitForLoad: config.maxWaitForLoadMs,
      disableFullPageScreenshot: true,
      onlyAudits: AUDITS,
      throttlingMethod: config.throttlingMethod,
      ...SETTINGS[settingsName],
    };
    const result = await lighthouse(url, flags, undefined, tab);
    const sample = { ...sampleFromLhr(result.lhr), o: await observed(result.artifacts) };
    if (!sample.ok) return sample;
    const analysis = await NetworkAnalysis.request(result.artifacts.DevtoolsLog, { computedCache: new Map() });
    const own = LoadSimulator.convertAnalysisToSaveableLanternData(analysis);
    if (index < 2 * config.warmupRuns) {
      warm.lantern.push(own);
      warm.bi.push(sample.benchmarkIndex);
      return sample;
    }
    if (!pinned) {
      pinned = {
        additionalRttByOrigin: medianMap(warm.lantern.map((data) => data.additionalRttByOrigin)),
        serverResponseTimeByOrigin: medianMap(warm.lantern.map((data) => data.serverResponseTimeByOrigin)),
      };
      biRef = median(warm.bi);
    }
    // Origins first seen in this run keep their own estimates.
    sample.mp = await reaudit(result.artifacts, {
      ...flags,
      precomputedLanternData: {
        additionalRttByOrigin: { ...own.additionalRttByOrigin, ...pinned.additionalRttByOrigin },
        serverResponseTimeByOrigin: { ...own.serverResponseTimeByOrigin, ...pinned.serverResponseTimeByOrigin },
      },
    });
    if (Number.isFinite(sample.benchmarkIndex) && biRef) {
      const cpuSlowdownMultiplier = constants.throttling.mobileSlow4G.cpuSlowdownMultiplier
        * (sample.benchmarkIndex / biRef);
      sample.mc = await reaudit(result.artifacts, {
        ...flags,
        throttling: { ...constants.throttling.mobileSlow4G, cpuSlowdownMultiplier },
      });
    }
    return sample;
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300), libs: [] };
  } finally {
    try { await browser?.disconnect(); } catch { /* already closed */ }
    chrome.kill();
  }
}

const started = Date.now();
const url = core.variantUrl(page.url, BEFORE);
const entry = {
  id: pageId, kind: 'compare', gate: true, round, a: url, b: `${url}&perfvariant=b`, aLibs: BEFORE, bLibs: BEFORE,
};
const result = await core.measureEntry(entry, config, { runOnce, log: console.log });
const verdict = core.evaluateResult(result, config);
const minutes = Number(((Date.now() - started) / 60000).toFixed(1));
const metric = (key, digits = 0) => {
  const m = verdict.metrics?.[key];
  return m ? `${key.toUpperCase()} ${m.before.toFixed(digits)}→${m.after.toFixed(digits)} (${Number.isFinite(m.relative) ? `${(m.relative * 100).toFixed(1)}%` : 'n/a'}, p=${m.p.toFixed(4)})` : '';
};
console.log(`${pageId} ${scenario} ${settingsName} r${round}: ${verdict.status.toUpperCase()} [${(verdict.regressed || []).join(',')}] pairs=${verdict.pairs ?? 0} discarded=${verdict.discarded ?? 0} ${minutes} min | ${metric('lcp')} | ${metric('cls', 3)} | ${metric('tbt')} ${verdict.reason || ''}`);
mkdirSync(dirname(out), { recursive: true });
appendFileSync(out, `${JSON.stringify({
  id: pageId,
  scenario,
  settings: settingsName,
  round,
  pairs: config.pairs,
  minutes,
  verdict: { status: verdict.status, regressed: verdict.regressed, reason: verdict.reason },
  biRef,
  pinned,
  warmups: result.warmups.map((run) => ({
    v: run.variant, ok: run.ok, bi: run.benchmarkIndex, m: run.metrics, o: run.o, e: run.error,
  })),
  runs: result.runs.map((run) => ({
    v: run.variant, p: run.pair, ok: run.ok, ms: run.ms, bi: run.benchmarkIndex, m: run.metrics, mp: run.mp, mc: run.mc, o: run.o, e: run.error,
  })),
})}\n`);
