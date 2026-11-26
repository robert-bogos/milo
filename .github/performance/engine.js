// Measures one page with adobecom/perf-tools (perf-ab): paired cold Lighthouse loads of the real
// page, with the Milo files of each side swapped in by perf-ab's proxy. The files are served from
// a local HTTPS server because perf-ab only accepts https source URLs.
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageUrl } from './core.js';

const WORKER = fileURLToPath(new URL('./engine-worker.js', import.meta.url));
const METRIC_KEYS = { lcp: 'LCP', cls: 'CLS', tbt: 'TBT', fcp: 'FCP' };
// local-results-not-comparable: always present in local perf-ab runs (not comparable with
// perf-ab's own US runners). environment-variability: the CPU benchmark spread, which
// evaluateResult already handles by discarding pairs from unusually slow runs.
const IGNORED_WARNINGS = ['local-results-not-comparable', 'environment-variability'];
const FAILURE = /^perf-tools failed: (.*)$/m;
// Lighthouse explains its error codes at length, as in "SI (Chrome didn't collect any
// screenshots ... (SPEEDINDEX_OF_ZERO))": the code is enough.
const LIGHTHOUSE_EXPLANATION = /\s*\([^()]*\(([A-Z][A-Z0-9_]+)\)\)/g;

export function conciseError(error) {
  return String(error || 'unknown error')
    .replace(/^pair job failed:\s*/, '')
    .replace(LIGHTHOUSE_EXPLANATION, ' ($1)')
    .slice(0, 200);
}

/** Why perf-tools measured nothing: each distinct pair error once, most frequent first. */
export function failureReason(results) {
  const pairs = results?.pairs || [];
  const counts = new Map();
  pairs.filter((pair) => pair.error).forEach((pair) => {
    const message = conciseError(pair.error);
    counts.set(message, (counts.get(message) || 0) + 1);
  });
  if (!counts.size) return conciseError(results?.error || results?.errorKind);
  return [...counts]
    .sort((x, y) => y[1] - x[1])
    .map(([message, count]) => `${count} of ${pairs.length} pairs: ${message}`)
    .join('; ');
}

export function createCertificate(dir) {
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile,
  ], { stdio: 'ignore' });
  return { keyFile, certFile, key: readFileSync(keyFile), cert: readFileSync(certFile) };
}

// Serves GET /<hash> without a content-type, so perf-ab derives it from the file extension.
export function startSourceServer({ files, key, cert }) {
  const server = createServer({ key, cert }, (req, res) => {
    const body = req.method === 'GET' ? files.get(req.url.slice(1)) : undefined;
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      origin: `https://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
    }));
  });
}

export function buildSpec({
  url, manifest, origin, afterOnly = false, runs, device = 'mobile',
}) {
  const sources = (side) => Object.fromEntries(Object.entries(manifest[side] || {})
    .map(([path, hash]) => [path, `${origin}/${hash}`]));
  const variants = { after: { url, sources: sources('after') } };
  if (!afterOnly) variants.before = { url, sources: sources('before') };
  return { version: 1, runs, device, names: afterOnly ? ['after'] : ['before', 'after'], variants };
}

function metricsFrom(values) {
  return Object.fromEntries(Object.entries(METRIC_KEYS)
    .map(([key, name]) => [key, values?.[name] ?? null]));
}

// perf-ab pairs (1-based, "before"/"after") become runs of variants a/b, as evaluateResult expects.
export function runsFromResults(results, { afterOnly = false } = {}) {
  const sides = afterOnly ? [['b', 'after']] : [['a', 'before'], ['b', 'after']];
  return (results?.pairs || []).flatMap((pair) => sides.map(([variant, name]) => {
    const ok = Boolean(pair[name] && !pair.error);
    return {
      variant,
      pair: pair.index - 1,
      ok,
      error: ok ? undefined : conciseError(pair.error || `no ${name} metrics`),
      metrics: ok ? metricsFrom(pair[name]) : undefined,
      benchmarkIndex: pair.job?.benchmarkIndexes?.[name] ?? null,
    };
  }));
}

/** The swapped files that perf-ab served during accepted runs, from each run's run.json. */
export function servedSources(results, out) {
  const served = new Set();
  (results?.runs || []).forEach((run) => {
    if (!run.dir) return;
    try {
      const meta = JSON.parse(readFileSync(join(out, run.dir, 'run.json'), 'utf8'));
      (meta.sourcesServed || []).forEach((path) => served.add(path));
    } catch {
      // A run without run.json counts as serving nothing.
    }
  });
  return served;
}

export function engineWarnings(results) {
  const seen = new Set();
  return [...(results?.warnings || []), ...(results?.sourceWarnings || [])]
    .filter((warning) => warning?.kind && !IGNORED_WARNINGS.includes(warning.kind))
    .filter((warning) => !seen.has(warning.kind) && seen.add(warning.kind))
    .map((warning) => ({ kind: warning.kind, message: String(warning.message || '').slice(0, 300) }));
}

// NODE_EXTRA_CA_CERTS holds one file and is read only at startup, so a set bundle is extended.
function trustBundle(dir, certFile) {
  const existing = process.env.NODE_EXTRA_CA_CERTS;
  if (!existing || !existsSync(existing)) return certFile;
  const bundle = join(dir, 'bundle.pem');
  writeFileSync(bundle, `${readFileSync(existing, 'utf8')}\n${readFileSync(certFile, 'utf8')}`);
  return bundle;
}

export function runWorker({ specFile, out, toolsDir, caFile, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, specFile, out, toolsDir], {
      cwd: toolsDir,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile },
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, error: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, failure: stderr.match(FAILURE)?.[1] });
    });
  });
}

export function loadSources(dir, manifest) {
  const hashes = new Set([
    ...Object.values(manifest.before || {}),
    ...Object.values(manifest.after || {}),
  ]);
  return new Map([...hashes].map((hash) => [hash, readFileSync(join(dir, hash))]));
}

export async function measurePage({
  entry, manifest, files, config, toolsDir, workDir, log = () => {},
}) {
  const afterOnly = entry.kind === 'after-only';
  const result = {
    id: entry.id,
    round: entry.round,
    kind: entry.kind,
    gate: entry.gate,
    url: entry.url,
    runs: [],
    served: [],
    warnings: [],
  };
  mkdirSync(workDir, { recursive: true });
  const certDir = mkdtempSync(join(tmpdir(), 'perf-sources-'));
  let server;
  try {
    const { key, cert, certFile } = createCertificate(certDir);
    server = await startSourceServer({ files, key, cert });
    const spec = buildSpec({
      url: pageUrl(entry.url, config),
      manifest,
      origin: server.origin,
      afterOnly,
      runs: config.pairs,
      device: config.device,
    });
    const specFile = join(workDir, 'spec.json');
    writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`);
    const out = join(workDir, 'perf-ab');
    log(`${entry.id}: measuring ${spec.variants.after.url} with perf-tools (${config.pairs} ${afterOnly ? 'runs' : 'pairs'})`);
    const exit = await runWorker({
      specFile,
      out,
      toolsDir,
      caFile: trustBundle(certDir, certFile),
      timeoutMs: config.engineTimeoutMinutes * 60000,
    });
    const resultsFile = join(out, 'results.json');
    if (!existsSync(resultsFile)) {
      let reason = exit.failure || exit.error || `exit code ${exit.code}`;
      if (exit.timedOut) reason = `no result after ${config.engineTimeoutMinutes} minutes`;
      result.error = `perf-tools did not finish (${reason})`;
      return result;
    }
    const results = JSON.parse(readFileSync(resultsFile, 'utf8'));
    result.runs = runsFromResults(results, { afterOnly });
    result.engine = {
      status: results.status,
      error: results.error ? String(results.error).slice(0, 500) : undefined,
      rejected: results.rejected?.length || 0,
      lighthouseVersion: results.lighthouseVersion,
      chromeVersion: results.chromeVersion,
    };
    result.warnings = engineWarnings(results);
    const served = servedSources(results, out);
    result.served = (manifest.changed || []).filter((path) => served.has(path));
    if (results.status === 'failed') {
      result.error = `perf-tools could not measure the page: ${failureReason(results).slice(0, 300)}`;
    } else if (!result.served.length) {
      result.error = 'the changed files were not requested during the measured loads';
    }
    return result;
  } catch (error) {
    result.error = `measurement crashed: ${String(error.message).slice(0, 300)}`;
    return result;
  } finally {
    await server?.close();
    rmSync(certDir, { recursive: true, force: true });
  }
}
