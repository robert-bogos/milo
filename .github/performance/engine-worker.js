// Runs one perf-ab measurement (see measurePage in engine.js). It is a separate process because
// Node reads NODE_EXTRA_CA_CERTS, which makes perf-ab trust the local source server, only at
// startup.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [specFile, out, toolsDir] = process.argv.slice(2);
const lib = (name) => import(pathToFileURL(join(toolsDir, 'lib', 'pagespeed', name)).href);
try {
  const [{ runLocal }, { runJob }] = await Promise.all([lib('local.mjs'), lib('job.mjs')]);
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  // A rejected load (for example a warm first document) is retried once with a fresh browser.
  const results = await runLocal({
    spec,
    out,
    root: toolsDir,
    measurePair: (options) => runJob({ ...options, attempts: 2 }),
  });
  console.log(`perf-tools: ${results.status}${results.error ? ` (${results.error})` : ''}`);
} catch (error) {
  console.error(error);
  // measurePage reports this line as the reason.
  console.error(`perf-tools failed: ${String(error?.message || error).split('\n')[0].slice(0, 300)}`);
  process.exitCode = 1;
}
