// POC only: measures stage against itself (A/A) or against a regression injected into the
// "after" variant, through the real measureEntry/evaluateResult logic.
// Usage: node accuracy.mjs <page id> <aa|cpu100|cpu250|cpu1000|cls>
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../performance/', import.meta.url));
const require = createRequire(`${root}package.json`);
const puppeteer = require('puppeteer-core');
const { default: lighthouse } = await import(`${root}node_modules/lighthouse/core/index.js`);
const { launch } = await import(`${root}node_modules/chrome-launcher/dist/index.js`);
const core = await import(`${root}core.js`);
const { sampleFromLhr } = await import(`${root}runner.js`);

const top = (body) => `if (window.top === window) { ${body} }`;
const busy = (ms) => top(`const s = performance.now(); while (performance.now() - s < ${ms}) {}`);
// Shifts the page by 150 px half a second after main has content.
const shift = top("const start = performance.now(); const tick = () => { const h = document.querySelector('main')?.getBoundingClientRect().height || 0; if (h > 300) setTimeout(() => { const d = document.createElement('div'); d.style.height = '150px'; document.body.prepend(d); }, 500); else if (performance.now() - start < 30000) setTimeout(tick, 100); }; addEventListener('DOMContentLoaded', tick);");
const SCENARIOS = {
  aa: null, cpu100: busy(100), cpu250: busy(250), cpu1000: busy(1000), cls: shift,
};
const AUDITS = ['largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time', 'first-contentful-paint', 'network-requests'];
const FLAGS = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])];
const BEFORE = 'https://stage--milo--adobecom.aem.live';

const config = core.loadConfig();
const [pageId, scenario] = process.argv.slice(2);
const page = config.pages.find((item) => item.id === pageId);
if (!page || !(scenario in SCENARIOS)) {
  console.error(`Usage: node accuracy.mjs <${config.pages.map((item) => item.id).join('|')}> <${Object.keys(SCENARIOS).join('|')}>`);
  process.exit(2);
}
const round = Number(process.env.POC_ROUND || 1);
const out = process.env.POC_OUT || 'accuracy-results.jsonl';

async function runOnce(url, { variant }) {
  const chrome = await launch({ chromeFlags: FLAGS, logLevel: 'silent' });
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
    const tab = await browser.newPage();
    await tab.evaluateOnNewDocument((variant === 'b' && SCENARIOS[scenario]) || '/* control */');
    const flags = {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      maxWaitForLoad: config.maxWaitForLoadMs,
      disableFullPageScreenshot: true,
      onlyAudits: AUDITS,
      throttlingMethod: config.throttlingMethod,
      ...(config.throttling && { throttling: config.throttling }),
    };
    const result = await lighthouse(url, flags, undefined, tab);
    return sampleFromLhr(result.lhr);
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
console.log(`${pageId} ${scenario} r${round}: ${verdict.status.toUpperCase()} [${(verdict.regressed || []).join(',')}] pairs=${verdict.pairs ?? 0} discarded=${verdict.discarded ?? 0} ${minutes} min | ${metric('lcp')} | ${metric('cls', 3)} | ${metric('tbt')} ${verdict.reason || ''}`);
mkdirSync(dirname(out), { recursive: true });
appendFileSync(out, `${JSON.stringify({
  id: pageId,
  scenario,
  round,
  minutes,
  verdict,
  warmups: result.warmups.length,
  runs: result.runs.map((run) => ({
    v: run.variant, p: run.pair, ok: run.ok, ms: run.ms, bi: run.benchmarkIndex, m: run.metrics, e: run.error,
  })),
})}\n`);
