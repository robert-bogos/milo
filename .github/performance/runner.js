import lighthouse from 'lighthouse';
import { getChromePath, launch } from 'chrome-launcher';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';

const MEASURE_AUDITS = [
  'largest-contentful-paint',
  'cumulative-layout-shift',
  'total-blocking-time',
  'first-contentful-paint',
  'network-requests',
];

// Discovery waits past Milo's delayed phase (about 3 s after load) so late files are seen too.
const DISCOVERY_SETTINGS = {
  onlyAudits: ['network-requests'],
  throttlingMethod: 'provided',
  pauseAfterLoadMs: 5000,
  networkQuietThresholdMs: 2000,
  cpuQuietThresholdMs: 1000,
};

function chromeFlags() {
  const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio'];
  if (process.platform === 'linux') flags.push('--no-sandbox', '--disable-dev-shm-usage');
  return flags;
}

export async function ensureChrome({ cacheDir }) {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    return getChromePath();
  } catch {
    const { Browser, detectBrowserPlatform, install, resolveBuildId } = await import('@puppeteer/browsers');
    const platform = detectBrowserPlatform();
    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
    const installed = await install({ browser: Browser.CHROME, buildId, cacheDir, platform });
    return installed.executablePath;
  }
}

export function sampleFromLhr(lhr, { requireMetrics = true } = {}) {
  const audits = lhr.audits || {};
  const items = audits['network-requests']?.details?.items || [];
  const libs = items.map((item) => item.url).filter((url) => typeof url === 'string' && url.includes('/libs/'));
  const benchmarkIndex = lhr.environment?.benchmarkIndex;
  if (lhr.runtimeError) {
    return { ok: false, error: `${lhr.runtimeError.code}: ${lhr.runtimeError.message}`.slice(0, 300), benchmarkIndex, libs };
  }
  const value = (id) => audits[id]?.numericValue;
  const metrics = {
    lcp: value('largest-contentful-paint'),
    cls: value('cumulative-layout-shift'),
    tbt: value('total-blocking-time'),
    fcp: value('first-contentful-paint'),
  };
  const ok = !requireMetrics || (Number.isFinite(metrics.lcp) && Number.isFinite(metrics.cls));
  return {
    ok,
    error: ok ? undefined : 'Lighthouse did not report LCP and CLS',
    metrics,
    benchmarkIndex,
    libs,
    warnings: (lhr.runWarnings || []).slice(0, 3).map((warning) => String(warning).slice(0, 200)),
  };
}

// Every run gets a fresh Chrome profile, so each one starts with a cold cache.
export async function lighthouseRun(url, { config, discovery = false }) {
  let chrome;
  try {
    chrome = await launch({ chromeFlags: chromeFlags(), logLevel: 'silent' });
    const flags = {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      maxWaitForLoad: config.maxWaitForLoadMs,
      disableFullPageScreenshot: true,
      ...(discovery
        ? DISCOVERY_SETTINGS
        : {
          onlyAudits: MEASURE_AUDITS,
          throttlingMethod: config.throttlingMethod,
          ...(config.throttling && { throttling: config.throttling }),
        }),
    };
    const result = await lighthouse(url, flags, config.formFactor === 'desktop' ? desktopConfig : undefined);
    if (!result?.lhr) return { ok: false, error: 'Lighthouse returned no result', libs: [] };
    return sampleFromLhr(result.lhr, { requireMetrics: !discovery });
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300), libs: [] };
  } finally {
    try {
      chrome?.kill();
    } catch {
      // Chrome already exited.
    }
  }
}

export async function discover(targets, { config, attempts = 2, log = () => {} }) {
  const results = {};
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const target = queue.shift();
      let sample;
      for (let attempt = 0; attempt < attempts && !sample?.ok; attempt += 1) {
        sample = await lighthouseRun(target.url, { config, discovery: true });
      }
      log(`discovered ${target.key}: ${sample.ok ? `${sample.libs.length} /libs/ requests` : sample.error}`);
      results[target.key] = sample;
    }
  };
  const workers = Math.max(1, Math.min(config.discoveryConcurrency || 1, targets.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
