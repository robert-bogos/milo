import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import { getChromePath, launch } from 'chrome-launcher';

const DISCOVER_WORKER = fileURLToPath(new URL('./discover-worker.js', import.meta.url));
const DISCOVERY_TIMEOUT_MS = 180000;

// Discovery lists the /libs/ files a page requests; perf-tools does the measuring (see engine.js).
// It waits past Milo's delayed phase (about 3 s after load) so late files are seen too.
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

export function sampleFromLhr(lhr) {
  const items = lhr.audits?.['network-requests']?.details?.items || [];
  const libs = items.map((item) => item.url).filter((url) => typeof url === 'string' && url.includes('/libs/'));
  if (lhr.runtimeError) {
    return { ok: false, error: `${lhr.runtimeError.code}: ${lhr.runtimeError.message}`.slice(0, 300), libs };
  }
  return { ok: true, libs };
}

// Every load gets a fresh Chrome profile, so it starts with a cold cache.
export async function discoveryRun(url, { config }) {
  let chrome;
  try {
    chrome = await launch({ chromeFlags: chromeFlags(), logLevel: 'silent' });
    const result = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      maxWaitForLoad: config.maxWaitForLoadMs,
      disableFullPageScreenshot: true,
      ...DISCOVERY_SETTINGS,
    });
    if (!result?.lhr) return { ok: false, error: 'Lighthouse returned no result', libs: [] };
    return sampleFromLhr(result.lhr);
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

// Lighthouse keeps its timing marks in process-wide state, so a run that finishes clears the marks
// of every other run in the same process ("performance mark has not been set"). Concurrent
// discovery loads therefore each get their own process.
export function isolatedDiscoveryRun(url, config) {
  return new Promise((resolve) => {
    execFile(process.execPath, [DISCOVER_WORKER, url, JSON.stringify(config)], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: DISCOVERY_TIMEOUT_MS,
      // chrome-launcher closes its Chrome on SIGINT.
      killSignal: 'SIGINT',
    }, (error, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop()));
      } catch {
        const detail = stderr.trim().split('\n').pop() || error?.message || 'no output';
        resolve({ ok: false, error: `Discovery process failed: ${detail}`.slice(0, 300), libs: [] });
      }
    });
  });
}

export async function discover(targets, { config, attempts = 2, log = () => {} }) {
  const results = {};
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const target = queue.shift();
      let sample;
      for (let attempt = 0; attempt < attempts && !sample?.ok; attempt += 1) {
        sample = await isolatedDiscoveryRun(target.url, config);
      }
      log(`discovered ${target.key}: ${sample.ok ? `${sample.libs.length} /libs/ requests` : sample.error}`);
      results[target.key] = sample;
    }
  };
  const workers = Math.max(1, Math.min(config.discoveryConcurrency || 1, targets.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
