// Runs one perf-ab measurement (see measurePage in engine.js). It is a separate process because
// Node reads NODE_EXTRA_CA_CERTS, which makes perf-ab trust the local source server, only at
// startup.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [specFile, out, toolsDir] = process.argv.slice(2);
const lib = (name) => import(pathToFileURL(join(toolsDir, 'lib', 'pagespeed', name)).href);

// The first load on a fresh runner is slower (cold disk and DNS caches), which would penalize
// the variant that the first pair loads first. One discarded load of the page absorbs that.
async function warmUp(runJob, options) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-warmup-'));
  try {
    const { after } = options.spec.variants;
    const spec = { ...options.spec, runs: 1, names: ['after'], variants: { after } };
    console.log('perf-tools: warm-up load (not measured)');
    await runJob({ ...options, spec, pair: 1, out: dir, attempts: 1 });
  } catch (error) {
    console.warn(`perf-tools: warm-up load failed: ${error?.message || error}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const [{ runLocal }, { runJob }] = await Promise.all([lib('local.mjs'), lib('job.mjs')]);
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  let warm = false;
  const results = await runLocal({
    spec,
    out,
    root: toolsDir,
    measurePair: async (options) => {
      if (!warm) {
        warm = true;
        await warmUp(runJob, options);
      }
      // A rejected load (for example a warm first document) is retried once with a fresh browser.
      return runJob({ ...options, attempts: 2 });
    },
  });
  console.log(`perf-tools: ${results.status}${results.error ? ` (${results.error})` : ''}`);
} catch (error) {
  console.error(error);
  // measurePage reports this line as the reason.
  console.error(`perf-tools failed: ${String(error?.message || error).split('\n')[0].slice(0, 300)}`);
  process.exitCode = 1;
}
