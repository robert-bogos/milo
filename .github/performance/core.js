import { readFileSync } from 'node:fs';
import { mean, median, wilcoxonGreater } from './stats.js';

export const REPORT_MARKER = '<!-- milo-performance-report -->';
export const COMMENT_MAX_BYTES = 60000;

export function loadConfig(file = new URL('./config.json', import.meta.url)) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Mirrors the aem.live branch-name normalisation used in preview hostnames.
export function sanitizeRef(name = '') {
  return String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function previewOrigin({ ref, repo, owner }) {
  const label = [ref, repo, owner].map(sanitizeRef);
  if (label.some((part) => !part)) return null;
  const host = label.join('--');
  return host.length > 63 ? null : `https://${host}.aem.live`;
}

const AEM_HOST = /^[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.(aem|hlx)\.(live|page)$/;

export function isMiloSite(hostname) {
  return /^[a-z0-9-]+--milo--[a-z0-9-]+\.(aem|hlx)\.(live|page)$/i.test(hostname);
}

// Milo pages are re-hosted on the variant's preview host; consumer pages use ?milolibs=.
export function variantUrl(pageUrl, libsOrigin, { martechOff = true } = {}) {
  const url = new URL(pageUrl);
  const libsHost = new URL(libsOrigin).hostname;
  if (isMiloSite(url.hostname)) {
    url.hostname = libsHost.replace(/\.aem\.live$/, url.hostname.endsWith('.page') ? '.aem.page' : '.aem.live');
    url.searchParams.delete('milolibs');
  } else {
    url.searchParams.set('milolibs', libsHost.replace(/\.aem\.live$/, ''));
  }
  if (martechOff) url.searchParams.set('martech', 'off');
  return url.toString();
}

export function expectedLibsOrigin(pageUrl, libsOrigin) {
  return isMiloSite(new URL(pageUrl).hostname)
    ? new URL(variantUrl(pageUrl, libsOrigin)).origin
    : libsOrigin;
}

export function parseDemoUrls(body = '') {
  const label = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:perf(?:ormance)?\s+)?demo(?:\s+(?:url|page))?\s*(?:\*\*)?\s*:/i;
  const urls = [];
  (body || '').split(/\r?\n/).forEach((line) => {
    // Lines still holding the template's <site>/<page> placeholders are ignored.
    if (!label.test(line) || /<[\w-]+>/.test(line)) return;
    const match = line.match(/https?:\/\/[^\s<>()[\]"'`]+/i);
    if (match) urls.push(match[0].replace(/[.,;:!?*]+$/, ''));
  });
  return [...new Set(urls)];
}

export function validateDemoUrl(value, { allowDraft = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: 'not a valid URL' };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password) {
    return { error: 'use an https URL without credentials' };
  }
  if (/(^|\.)adobe\.com$/.test(host)) {
    return { error: "production pages cannot load this pull request's code; use the matching https://main--<site>--adobecom.aem.live URL" };
  }
  if (!AEM_HOST.test(host)) return { error: 'use a public https://main--<site>--<owner>.aem.live page' };
  if (/\.page$/.test(host) && !allowDraft) {
    return { error: 'draft (.aem.page) pages are only accepted for new blocks; use the .aem.live URL' };
  }
  ['milolibs', 'martech'].forEach((param) => url.searchParams.delete(param));
  url.hash = '';
  return { url: url.toString() };
}

export function isRuntimePath(path = '') {
  return path.startsWith('libs/')
    && !/\.(md|txt)$/i.test(path)
    && !/(^|\/)\./.test(path)
    && !/(^|\/)(test|tests|__tests__)\//i.test(path)
    && !/\.(test|spec)\.[cm]?js$/i.test(path);
}

// Parses `git diff --name-status -M` output.
export function parseNameStatus(output = '') {
  return output.split('\n').filter(Boolean).map((line) => {
    const [status, first, second] = line.split('\t');
    return second
      ? { status: status[0], path: second, previousPath: first }
      : { status: status[0], path: first };
  });
}

export function classifyChanges(entries, { blockExistedAtBase = () => true } = {}) {
  const runtime = entries.filter((entry) => isRuntimePath(entry.path)
    || (entry.previousPath && isRuntimePath(entry.previousPath)));
  const paths = new Set();
  runtime.forEach((entry) => {
    [entry.path, entry.previousPath].filter((path) => path && isRuntimePath(path))
      .forEach((path) => paths.add(`/${path}`.toLowerCase()));
  });
  const newBlocks = runtime
    .filter((entry) => entry.status === 'A')
    .map((entry) => entry.path.match(/^libs\/(?:c2\/)?blocks\/([^/]+)\/\1\.js$/))
    .filter((match) => match && !blockExistedAtBase(match[0].replace(/\/[^/]+$/, '')))
    .map((match) => match[1]);
  return { runtime, paths: [...paths], newBlocks: [...new Set(newBlocks)] };
}

export function libsPaths(urls = [], origin = null) {
  return [...new Set(urls.map((value) => {
    try {
      const url = new URL(value);
      if (origin && url.origin !== origin) return null;
      return url.pathname.startsWith('/libs/') ? url.pathname.toLowerCase() : null;
    } catch {
      return null;
    }
  }).filter(Boolean))];
}

export function variantHostError(libs, expected, other = null) {
  const origins = new Set((libs || []).map((value) => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  }));
  if (!origins.has(expected)) return `did not load Milo from ${expected}`;
  if (other && other !== expected && origins.has(other)) return `also loaded Milo from ${other}`;
  return null;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Every Milo page loads utils.js, so it exposes a host that still serves an older copy of a branch
// (Code Sync only re-copies a whole branch when it is created or force-pushed).
export const SERVED_SENTINELS = ['libs/utils/utils.js'];

/** The files whose served copies are compared with git: changed runtime files plus sentinels. */
export function servedCheckPaths(runtime, { max = 15, sentinels = SERVED_SENTINELS } = {}) {
  const changed = runtime.slice(0, max).map(({ path }) => path);
  return { paths: [...new Set([...changed, ...sentinels])], truncated: runtime.length > max };
}

/**
 * Waits until a preview host serves exactly the expected file contents (AEM Code Sync can lag
 * behind a push). `expected === null` means the file must not exist.
 */
export async function verifyServed(files, options) {
  const {
    origin,
    attempts = 12,
    delayMs = 20000,
    fetchImpl = fetch,
    sleep = wait,
  } = options;
  let mismatches = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) {
      await sleep(delayMs);
    }
    mismatches = (await Promise.all(files.map(async ({ path, expected }) => {
      try {
        const response = await fetchImpl(`${origin}/${path}?perf-check=${Date.now()}`, { redirect: 'manual' });
        if (expected === null) return response.status === 404 ? null : `${path} (still served)`;
        if (!response.ok) return `${path} (HTTP ${response.status})`;
        const body = Buffer.from(await response.arrayBuffer());
        return body.equals(expected) ? null : `${path} (outdated content)`;
      } catch (error) {
        return `${path} (${error.message})`;
      }
    }))).filter(Boolean);
    if (!mismatches.length) return { ok: true, mismatches, attempts: attempt + 1 };
  }
  return { ok: false, mismatches, attempts };
}

/**
 * Decides whether a page needs measuring, from an unthrottled discovery load of each variant.
 * A page is affected when either variant requested a changed /libs/ file. It is stale when it
 * also loads files that changed on the base branch after the PR branched off: those differences
 * would be attributed to the PR, so the branch must be updated first.
 */
export function classifyPage({ discovery, changedPaths, driftPaths = [] }) {
  const failed = ['a', 'b'].map((variant) => discovery?.[variant]).find((item) => item && !item.ok);
  if (!discovery?.b || failed) {
    return { status: 'error', reason: failed?.error || 'page could not be loaded', hits: [], drift: [] };
  }
  const loaded = new Set([...(discovery.a?.paths || []), ...(discovery.b.paths || [])]);
  const hits = changedPaths.filter((path) => loaded.has(path));
  const drift = driftPaths.map((path) => `/${path}`.toLowerCase()).filter((path) => loaded.has(path));
  if (!hits.length) return { status: 'unaffected', hits, drift };
  if (drift.length) return { status: 'stale', hits, drift };
  return { status: 'measure', hits, drift };
}

// Counterbalanced interleaving (AB, BA, AB, ...) so drift and order effects hit both sides.
export function pairOrder(index) {
  return index % 2 ? ['b', 'a'] : ['a', 'b'];
}

function benchmarkFloor(indexes, { benchmarkIndexRatio = 0, minBenchmarkIndex = 0 }) {
  const known = indexes.filter((value) => Number.isFinite(value) && value > 0);
  const reference = known.length ? median(known) : NaN;
  const relative = Number.isFinite(reference) ? reference * benchmarkIndexRatio : 0;
  return { reference, floor: Math.max(minBenchmarkIndex || 0, relative) };
}

function isSlow(run, floor) {
  return Number.isFinite(run.benchmarkIndex) && run.benchmarkIndex < floor;
}

// Pairs before/after runs and drops pairs measured while the runner was unusually slow.
export function selectPairs(runs, config = {}) {
  const pairs = new Map();
  runs.forEach((run) => pairs.set(run.pair, { ...pairs.get(run.pair), [run.variant]: run }));
  const complete = [];
  const incomplete = [];
  [...pairs.entries()].sort(([x], [y]) => x - y).forEach(([index, pair]) => {
    if (pair.a?.ok && pair.b?.ok) complete.push({ index, a: pair.a, b: pair.b });
    else incomplete.push({ index, reason: pair.a?.error || pair.b?.error || 'missing run' });
  });
  const { reference, floor } = benchmarkFloor(
    complete.flatMap((pair) => [pair.a.benchmarkIndex, pair.b.benchmarkIndex]),
    config,
  );
  const valid = complete.filter((pair) => !isSlow(pair.a, floor) && !isSlow(pair.b, floor));
  const slow = complete.filter((pair) => !valid.includes(pair));
  return { valid, slow, incomplete, reference, floor };
}

export function selectRuns(runs, config = {}) {
  const complete = runs.filter((run) => run.ok);
  const { reference, floor } = benchmarkFloor(complete.map((run) => run.benchmarkIndex), config);
  return {
    valid: complete.filter((run) => !isSlow(run, floor)),
    slow: complete.filter((run) => isSlow(run, floor)),
    incomplete: runs.filter((run) => !run.ok),
    reference,
    floor,
  };
}

export function compareMetric(pairs, key, metric, alpha) {
  const usable = pairs.filter((pair) => Number.isFinite(pair.a.metrics?.[key])
    && Number.isFinite(pair.b.metrics?.[key]));
  const before = mean(usable.map((pair) => pair.a.metrics[key]));
  const after = mean(usable.map((pair) => pair.b.metrics[key]));
  const delta = after - before;
  const { p, n } = wilcoxonGreater(usable.map((pair) => pair.b.metrics[key] - pair.a.metrics[key]));
  const limit = Math.max((metric.relative || 0) * before, metric.absolute || 0);
  const exceeds = usable.length > 0 && delta > limit;
  const significant = p < alpha;
  return {
    pairs: usable.length,
    n,
    before,
    after,
    delta,
    relative: before > 0 ? delta / before : null,
    limit,
    p,
    exceeds,
    significant,
    regression: exceeds && significant,
    gate: Boolean(metric.gate),
  };
}

function evaluateAfterOnly(result, config) {
  const { valid, slow, incomplete, reference } = selectRuns(result.runs, config);
  const base = {
    id: result.id,
    kind: result.kind,
    gate: result.gate,
    discarded: slow.length,
    failedRuns: incomplete.length,
    benchmarkIndex: reference,
  };
  if (valid.length < config.minPairs) {
    return { ...base, status: 'inconclusive', reason: `only ${valid.length} usable runs (need ${config.minPairs})`, regressed: [] };
  }
  const metrics = {};
  Object.entries(config.greenBands).forEach(([key, band]) => {
    const values = valid.map((run) => run.metrics?.[key]).filter(Number.isFinite);
    const value = median(values);
    metrics[key] = {
      value,
      band: band.value,
      gate: Boolean(band.gate),
      exceeds: value > band.value,
      runs: values.length,
    };
  });
  const regressed = Object.keys(metrics).filter((key) => metrics[key].exceeds && metrics[key].gate);
  const informational = Object.keys(metrics)
    .filter((key) => metrics[key].exceeds && !metrics[key].gate);
  let status = 'pass';
  if (regressed.length) status = result.gate ? 'fail' : 'warn';
  return {
    ...base, status, regressed, informational, metrics, runs: valid.length,
  };
}

export function evaluateResult(result, config) {
  if (!result) return { status: 'inconclusive', reason: 'no measurement was uploaded', regressed: [] };
  const base = { id: result.id, kind: result.kind, gate: result.gate };
  if (result.error) return { ...base, status: 'inconclusive', reason: result.error, regressed: [] };
  if (result.kind === 'after-only') return evaluateAfterOnly(result, config);
  const { valid, slow, incomplete, reference } = selectPairs(result.runs, config);
  Object.assign(base, {
    discarded: slow.length,
    failedPairs: incomplete.length,
    benchmarkIndex: reference,
  });
  if (valid.length < config.minPairs) {
    return { ...base, status: 'inconclusive', reason: `only ${valid.length} usable pairs (need ${config.minPairs})`, regressed: [] };
  }
  const metrics = {};
  Object.entries(config.metrics).forEach(([key, metric]) => {
    metrics[key] = compareMetric(valid, key, metric, config.alpha);
  });
  const regressed = Object.keys(metrics)
    .filter((key) => metrics[key].regression && metrics[key].gate);
  const informational = Object.keys(metrics)
    .filter((key) => metrics[key].regression && !metrics[key].gate);
  let status = 'pass';
  if (regressed.length) status = result.gate ? 'fail' : 'warn';
  return {
    ...base, status, regressed, informational, metrics, pairs: valid.length,
  };
}

// A page fails only when the same metric regresses in the first run and in the re-run.
export function confirmVerdict(first, second) {
  if (first.status !== 'fail') return { ...first, first };
  if (!second) return { ...first, status: 'inconclusive', reason: 'the confirmation run did not finish', first };
  if (second.status === 'inconclusive') {
    return { ...first, status: 'inconclusive', reason: `confirmation run: ${second.reason}`, first, second };
  }
  const confirmed = first.regressed.filter((key) => second.regressed.includes(key));
  if (confirmed.length) return { ...second, status: 'fail', regressed: confirmed, first, second };
  return {
    ...first, status: 'pass', unconfirmed: first.regressed, regressed: [], first, second,
  };
}

export async function measureEntry(entry, config, { runOnce, now = Date.now, log = () => {} }) {
  const afterOnly = entry.kind === 'after-only';
  const deadline = now() + config.pageBudgetMinutes * 60000;
  const result = {
    id: entry.id,
    round: entry.round,
    kind: entry.kind,
    gate: entry.gate,
    warmups: [],
    runs: [],
    notes: [],
  };
  const run = async (variant, details) => {
    const started = now();
    const sample = await runOnce(entry[variant], { variant });
    const other = afterOnly ? null : entry[variant === 'a' ? 'bLibs' : 'aLibs'];
    const hostError = sample.ok ? variantHostError(sample.libs, entry[`${variant}Libs`], other) : null;
    const measured = {
      variant,
      ...details,
      ...sample,
      ok: Boolean(sample.ok && !hostError),
      error: sample.error || hostError || undefined,
      ms: now() - started,
    };
    delete measured.libs;
    const label = details.warmup ? 'warm-up' : `pair ${details.pair}`;
    log(`${entry.id} ${variant} ${label}: ${measured.ok ? `LCP ${Math.round(measured.metrics.lcp)} ms, CLS ${measured.metrics.cls?.toFixed(3)}, BI ${Math.round(measured.benchmarkIndex)}` : measured.error}`);
    return measured;
  };
  for (const variant of afterOnly ? ['b'] : ['a', 'b']) {
    for (let i = 0; i < config.warmupRuns; i += 1) {
      result.warmups.push(await run(variant, { warmup: true }));
    }
  }
  const setupError = result.warmups.find((sample) => /Milo from/.test(sample.error || ''));
  if (setupError) {
    result.error = `the ${setupError.variant === 'a' ? 'before' : 'after'} page ${setupError.error}`;
    return result;
  }
  const select = afterOnly ? selectRuns : selectPairs;
  for (let index = 0; index < config.pairs + config.extraPairs; index += 1) {
    if (index >= config.pairs && select(result.runs, config).valid.length >= config.pairs) break;
    if (index === 3 && !result.runs.some((sample) => sample.ok)) {
      result.error = `every run failed (${result.runs[0]?.error || 'unknown error'})`;
      break;
    }
    if (now() > deadline) {
      result.notes.push('stopped early: time budget reached');
      break;
    }
    for (const variant of afterOnly ? ['b'] : pairOrder(index)) {
      result.runs.push(await run(variant, { pair: index }));
    }
  }
  return result;
}

export function overallStatus(plan, verdicts) {
  if (plan.status === 'error') return 'inconclusive';
  if (plan.policy) return 'fail';
  if (verdicts.some((verdict) => verdict.status === 'fail')) return 'fail';
  if (verdicts.some((verdict) => verdict.status === 'inconclusive')
    || plan.pages?.some((page) => ['stale', 'error'].includes(page.status))) return 'inconclusive';
  if (plan.status === 'skip') return 'skipped';
  return 'pass';
}

const HEADLINES = {
  fail: '❌ Performance regression confirmed',
  pass: '✅ No performance regression detected',
  inconclusive: '⚠️ Performance check inconclusive',
  skipped: '⏭️ Performance check skipped',
};

function formatValue(key, value) {
  if (!Number.isFinite(value)) return 'n/a';
  return key === 'cls' ? value.toFixed(3) : `${Math.round(value).toLocaleString('en-US')} ms`;
}

function formatDelta(key, metric) {
  if (!metric || !Number.isFinite(metric.delta)) return 'n/a';
  const sign = metric.delta >= 0 ? '+' : '−';
  if (key === 'cls') return `${sign}${Math.abs(metric.delta).toFixed(3)}`;
  const relative = Number.isFinite(metric.relative) ? ` (${sign}${Math.abs(metric.relative * 100).toFixed(1)}%)` : '';
  return `${sign}${Math.round(Math.abs(metric.delta)).toLocaleString('en-US')} ms${relative}`;
}

function formatP(p) {
  if (!Number.isFinite(p)) return 'n/a';
  return p < 0.001 ? '<0.001' : p.toFixed(3);
}

function describeVerdict(verdict, config) {
  const labels = (keys) => keys.map((key) => config.metrics[key]?.label || key.toUpperCase()).join(', ');
  const afterOnly = verdict.kind === 'after-only';
  const problem = afterOnly ? 'above the green band' : 'slower';
  if (verdict.status === 'fail') {
    return `❌ ${labels(verdict.regressed)} ${afterOnly ? 'above the green band' : 'regression'}, confirmed by re-run`;
  }
  if (verdict.status === 'inconclusive') return `⚠️ inconclusive: ${verdict.reason}`;
  if (verdict.unconfirmed?.length) return `✅ ${labels(verdict.unconfirmed)} ${problem}, but not reproduced on re-run`;
  if (verdict.status === 'warn') return `⚠️ ${labels(verdict.regressed)} ${problem} (reference only)`;
  if (verdict.informational?.length) return `✅ (${labels(verdict.informational)} ${problem}, informational)`;
  return '✅';
}

function pageLink(page) {
  return `[${page.label}](${page.production || page.url})`;
}

function compareRows(rows, config) {
  const lines = [
    '| Page | LCP before → after | LCP Δ | p | CLS Δ | TBT Δ | Result |',
    '|:--|--:|--:|--:|--:|--:|:--|',
  ];
  rows.forEach(({ page, verdict }) => {
    const m = (verdict.first?.metrics ? verdict.first : verdict).metrics || {};
    const lcp = m.lcp ? `${formatValue('lcp', m.lcp.before)} → ${formatValue('lcp', m.lcp.after)}` : 'n/a';
    const p = m.lcp ? formatP(m.lcp.p) : 'n/a';
    lines.push(`| ${pageLink(page)} | ${lcp} | ${formatDelta('lcp', m.lcp)} | ${p} | ${formatDelta('cls', m.cls)} | ${formatDelta('tbt', m.tbt)} | ${describeVerdict(verdict, config)} |`);
  });
  return lines;
}

function afterOnlyRows(rows, config) {
  const keys = Object.keys(config.greenBands);
  const lines = [
    `| Page | ${keys.map((key) => `${config.metrics[key]?.label || key} median / band`).join(' | ')} | Result |`,
    `|:--|${keys.map(() => '--:').join('|')}|:--|`,
  ];
  rows.forEach(({ page, verdict }) => {
    const shown = verdict.first?.metrics ? verdict.first : verdict;
    const cells = keys.map((key) => {
      const metric = shown.metrics?.[key];
      return metric ? `${formatValue(key, metric.value)} / ${formatValue(key, metric.band)}` : 'n/a';
    });
    lines.push(`| ${pageLink(page)} | ${cells.join(' | ')} | ${describeVerdict(verdict, config)} |`);
  });
  return lines;
}

function methodLine(plan, config) {
  const { lcp, cls } = config.metrics;
  return `<sub>${config.formFactor}, ${config.throttlingMethod} throttling, ${config.pairs} interleaved before/after pairs per page. `
    + `A page fails when mean ${lcp.label} is more than ${Math.round(lcp.relative * 100)}% slower `
    + `(or mean CLS rises by more than ${cls.absolute}) and a one-sided Wilcoxon signed-rank test gives p < ${config.alpha}, `
    + `both in the first run and in a re-run. Before: \`${plan.aLibs || 'n/a'}\` · After: \`${plan.bLibs || 'n/a'}\` · `
    + `Commit ${String(plan.headSha || '').slice(0, 7)}</sub>`;
}

function noteLines(plan, verdicts, config) {
  const lines = [];
  const unaffected = (plan.pages || []).filter((page) => page.status === 'unaffected');
  if (unaffected.length) {
    lines.push(`Not measured, because they do not load the changed files: ${unaffected.map((page) => page.label).join(', ')}.`, '');
  }
  (plan.pages || []).filter((page) => page.status === 'stale').forEach((page) => {
    lines.push(`⚠️ ${page.label}: the base branch changed files this page loads (${page.drift.slice(0, 3).join(', ')}). Update the branch to measure it.`);
  });
  (plan.pages || []).filter((page) => page.status === 'error').forEach((page) => {
    lines.push(`⚠️ ${page.label}: could not be checked (${page.reason}).`);
  });
  (plan.demo?.rejected || []).forEach((item) => lines.push(`⚠️ Demo URL ${item.url} was ignored: ${item.reason}.`));
  (plan.notes || []).forEach((note) => lines.push(`ℹ️ ${note}`));
  const discarded = verdicts
    .reduce((sum, verdict) => sum + ((verdict.first || verdict).discarded || 0), 0);
  if (discarded) {
    lines.push(`ℹ️ ${discarded} pair(s) were discarded because the runner was unusually slow (Lighthouse benchmarkIndex below ${Math.round(config.benchmarkIndexRatio * 100)}% of the job median).`);
  }
  return lines;
}

export function renderReport({ plan, verdicts = [], config, enforce = false, runUrl = '' }) {
  const status = overallStatus(plan, verdicts);
  const entries = new Map((plan.entries || []).map((entry) => [entry.id, entry]));
  const rows = verdicts.map((verdict) => ({
    verdict,
    page: entries.get(verdict.id) || { label: verdict.id },
  }));
  const policyOnly = plan.policy && !verdicts.some((verdict) => verdict.status === 'fail');
  const headline = policyOnly ? '❌ Demo page needed' : HEADLINES[status];
  const lines = [
    REPORT_MARKER,
    `### ${headline}${status === 'fail' && !enforce ? ' (report only, not blocking)' : ''}`,
    '',
    methodLine(plan, config),
    '',
  ];
  if (plan.reason) lines.push(`${plan.status === 'error' ? '⚠️ ' : ''}${plan.reason}`, '');
  if (plan.policy) lines.push(`❌ ${plan.policy}`, '');
  const compare = rows.filter((row) => row.page.kind !== 'after-only');
  const afterOnly = rows.filter((row) => row.page.kind === 'after-only');
  if (compare.length) lines.push(...compareRows(compare, config), '');
  if (afterOnly.length) {
    lines.push('**New blocks** (after only, medians against the green Core Web Vitals bands)', '', ...afterOnlyRows(afterOnly, config), '');
  }
  lines.push(...noteLines(plan, verdicts, config));
  if (rows.length) {
    lines.push('', '<details><summary>Tested URLs</summary>', '');
    rows.forEach(({ page }) => {
      const urls = page.kind === 'after-only' ? `[after](${page.b})` : `[before](${page.a}) · [after](${page.b})`;
      lines.push(`- ${page.label}: ${urls}`);
    });
    lines.push('', '</details>');
  }
  if (runUrl) lines.push('', `[Workflow run](${runUrl})`);
  let body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > COMMENT_MAX_BYTES) {
    body = `${body.slice(0, COMMENT_MAX_BYTES / 2)}\n\n…truncated; see the workflow summary.`;
  }
  return { status, body };
}
