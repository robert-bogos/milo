import { readFileSync } from 'node:fs';
import { hodgesLehmann, median, wilcoxonGreater } from './stats.js';

export const REPORT_MARKER = '<!-- milo-performance-report -->';
export const COMMENT_MAX_BYTES = 60000;

export function loadConfig(file = new URL('./config.json', import.meta.url)) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const MILO_HOST = 'main--milo--adobecom.aem.live';

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

// perf-tools measures production pages and main--milo--adobecom.aem.live, whose /libs/ it can
// swap. Drafts and other aem.live sites load Milo from another host (or cannot be measured), and
// stage hosts run other code.
export function validateDemoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: 'not a valid URL' };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return { error: 'use an https URL without credentials or a port' };
  }
  if (/\.(aem|hlx)\.page$/.test(host)) {
    return { error: 'drafts (.aem.page) cannot be measured; publish the page (Milo /drafts is fine) and use its https://main--milo--adobecom.aem.live URL, or use a production URL' };
  }
  if (host !== MILO_HOST && (/\.(aem|hlx)\.live$/.test(host) || /(^|\.)stage\.adobe\.com$/.test(host))) {
    return { error: 'this host loads Milo from another host, so the change cannot be swapped in; use the production URL of the page' };
  }
  if (host !== MILO_HOST && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.adobe\.com$/.test(host)) {
    return { error: `use a production *.adobe.com page or a https://${MILO_HOST} page` };
  }
  ['milolibs', 'martech'].forEach((param) => url.searchParams.delete(param));
  url.hash = '';
  return { url: url.toString() };
}

export function pageUrl(url, { martechOff = true } = {}) {
  const page = new URL(url);
  if (martechOff) page.searchParams.set('martech', 'off');
  return page.toString();
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
  const files = new Set();
  runtime.forEach((entry) => {
    [entry.path, entry.previousPath].filter((path) => path && isRuntimePath(path))
      .forEach((path) => files.add(path));
  });
  const paths = new Set([...files].map((path) => `/${path}`.toLowerCase()));
  const newBlocks = runtime
    .filter((entry) => entry.status === 'A')
    .map((entry) => entry.path.match(/^libs\/(?:c2\/)?blocks\/([^/]+)\/\1\.js$/))
    .filter((match) => match && !blockExistedAtBase(match[0].replace(/\/[^/]+$/, '')))
    .map((match) => match[1]);
  return { runtime, files: [...files], paths: [...paths], newBlocks: [...new Set(newBlocks)] };
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

// perf-ab swaps only text files (see TEXT_SOURCE in perf-tools lib/pagespeed/job.mjs).
export const TEXT_SOURCE = /\.(?:m?js|css|json|html|svg|txt)$/i;

/**
 * Decides which file versions perf-ab serves on each side. Production runs adobecom/milo main, so
 * files that differ between main and the merge base ("drift") are served at their merge-base
 * version on both sides; the files the pull request changes are served at the merge base (before)
 * and at the head (after). Paths are repository paths.
 */
export function planSources({ changed, drift = [], existsAtBase, existsAtHead }) {
  const before = {};
  const after = {};
  const unsupported = [];
  const deleted = [];
  const key = (path) => `/${path}`;
  drift.filter((path) => existsAtBase.has(path) && TEXT_SOURCE.test(path)).forEach((path) => {
    before[key(path)] = { rev: 'base', path };
    after[key(path)] = { rev: 'base', path };
  });
  const swapped = changed.filter((path) => {
    if (TEXT_SOURCE.test(path)) return true;
    unsupported.push(path);
    return false;
  });
  swapped.forEach((path) => {
    if (existsAtBase.has(path)) before[key(path)] = { rev: 'base', path };
    else delete before[key(path)];
    if (existsAtHead.has(path)) {
      after[key(path)] = { rev: 'head', path };
    } else {
      delete after[key(path)];
      deleted.push(path);
    }
  });
  return { before, after, changed: swapped.map(key), unsupported, deleted };
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Decides whether a page needs measuring, from an unthrottled discovery load of the production
 * page. perf-ab can swap files only on the page's own host, so Milo must load from there.
 */
export function classifyPage({ discovery, origin, changedPaths, unsupported = [] }) {
  if (!discovery?.ok) return { status: 'error', reason: discovery?.error || 'the page could not be loaded', hits: [] };
  const libs = discovery.libs || [];
  const own = libsPaths(libs, origin);
  if (!own.length) {
    const other = libs.map(originOf).find((value) => value && value !== origin);
    return { status: 'error', reason: other ? `loads Milo from ${other}, not from ${origin}` : 'did not load Milo', hits: [] };
  }
  const anywhere = libsPaths(libs);
  const elsewhere = changedPaths.filter((path) => !own.includes(path) && anywhere.includes(path));
  if (elsewhere.length) return { status: 'error', reason: `loads ${elsewhere[0]} from another host`, hits: [] };
  const hits = changedPaths.filter((path) => own.includes(path));
  if (!hits.length) return { status: 'unaffected', hits };
  if (hits.every((path) => unsupported.includes(path))) {
    return { status: 'error', reason: `only loads changed files that cannot be swapped in (${hits.slice(0, 3).join(', ')})`, hits };
  }
  return { status: 'measure', hits };
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

// The most frequent reason among failed pairs or runs, appended to an inconclusive reason.
function failedReason(reasons) {
  if (!reasons.length) return '';
  const counts = new Map();
  reasons.forEach((reason) => counts.set(reason, (counts.get(reason) || 0) + 1));
  const [reason, count] = [...counts].sort((x, y) => y[1] - x[1])[0];
  return `; ${count} failed: ${reason}`;
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
  const differences = usable.map((pair) => pair.b.metrics[key] - pair.a.metrics[key]);
  // Medians and the Hodges–Lehmann shift, so that one outlier load cannot hide or fake a change.
  const before = median(usable.map((pair) => pair.a.metrics[key]));
  const after = median(usable.map((pair) => pair.b.metrics[key]));
  const delta = hodgesLehmann(differences);
  const { p, n } = wilcoxonGreater(differences);
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
    warnings: result.warnings || [],
    discarded: slow.length,
    failedRuns: incomplete.length,
    benchmarkIndex: reference,
  };
  if (valid.length < config.minPairs) {
    const reason = `only ${valid.length} usable runs (need ${config.minPairs})${failedReason(incomplete.map((run) => run.error || 'missing run'))}`;
    return { ...base, status: 'inconclusive', reason, regressed: [] };
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
  const { id, kind, gate } = result;
  const base = { id, kind, gate, warnings: result.warnings || [] };
  if (result.error) return { ...base, status: 'inconclusive', reason: result.error, regressed: [] };
  if (result.kind === 'after-only') return evaluateAfterOnly(result, config);
  const { valid, slow, incomplete, reference } = selectPairs(result.runs, config);
  Object.assign(base, {
    discarded: slow.length,
    failedPairs: incomplete.length,
    benchmarkIndex: reference,
  });
  if (valid.length < config.minPairs) {
    const reason = `only ${valid.length} usable pairs (need ${config.minPairs})${failedReason(incomplete.map((pair) => pair.reason))}`;
    return { ...base, status: 'inconclusive', reason, regressed: [] };
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

export function overallStatus(plan, verdicts) {
  if (plan.status === 'error') return 'inconclusive';
  if (plan.policy) return 'fail';
  if (verdicts.some((verdict) => verdict.status === 'fail')) return 'fail';
  if (verdicts.some((verdict) => verdict.status === 'inconclusive')
    || plan.pages?.some((page) => page.status === 'error')) return 'inconclusive';
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
  return `[${page.label}](${page.url})`;
}

function compareRows(rows, config) {
  const lines = [
    '| Page | LCP before → after | LCP Δ | LCP p | CLS Δ | TBT Δ | Result |',
    '|:--|--:|--:|--:|--:|--:|:--|',
  ];
  let tbtMissing = false;
  rows.forEach(({ page, verdict }) => {
    const m = (verdict.first?.metrics ? verdict.first : verdict).metrics || {};
    const lcp = m.lcp ? `${formatValue('lcp', m.lcp.before)} → ${formatValue('lcp', m.lcp.after)}` : 'n/a';
    const p = m.lcp ? formatP(m.lcp.p) : 'n/a';
    const tbt = formatDelta('tbt', m.tbt);
    tbtMissing ||= Boolean(m.lcp) && tbt === 'n/a';
    lines.push(`| ${pageLink(page)} | ${lcp} | ${formatDelta('lcp', m.lcp)} | ${p} | ${formatDelta('cls', m.cls)} | ${tbt} | ${describeVerdict(verdict, config)} |`);
  });
  if (tbtMissing) {
    lines.push('', 'ℹ️ TBT n/a: Lighthouse measures TBT up to Time to Interactive, which it could not find because the page was still busy when the load ended.');
  }
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
  const sha = (value) => String(value || '').slice(0, 7) || 'n/a';
  return `<sub>[perf-tools](https://github.com/adobecom/perf-tools) on the live pages, ${config.device}, `
    + `${config.pairs} interleaved before/after pairs per page. Before: merge base \`${sha(plan.mergeBase)}\` · `
    + `After: \`${sha(plan.headSha)}\` (Milo files that differ from production are swapped in on both sides). `
    + `A page fails when ${lcp.label} is more than ${Math.round(lcp.relative * 100)}% slower `
    + `(or CLS rises by more than ${cls.absolute}) and a one-sided Wilcoxon signed-rank test gives p < ${config.alpha}, `
    + 'both in the first run and in a re-run. Values are medians; Δ is the Hodges–Lehmann estimate '
    + 'of the paired differences, which a single outlier load cannot skew.</sub>';
}

const fileList = (paths, max = 5) => `${paths.slice(0, max).map((path) => `\`${path}\``).join(', ')}${paths.length > max ? ` and ${paths.length - max} more` : ''}`;

function noteLines(plan, verdicts, config) {
  const lines = [];
  const unaffected = (plan.pages || []).filter((page) => page.status === 'unaffected');
  if (unaffected.length) {
    lines.push(`Not measured, because they do not load the changed files: ${unaffected.map((page) => page.label).join(', ')}.`, '');
  }
  (plan.pages || []).filter((page) => page.status === 'error').forEach((page) => {
    lines.push(`⚠️ ${page.label}: could not be checked (${page.reason}).`);
  });
  (plan.demo?.rejected || []).forEach((item) => lines.push(`⚠️ Demo URL ${item.url} was ignored: ${item.reason}.`));
  const { unsupported = [], deleted = [] } = plan.sources || {};
  if (unsupported.length) lines.push(`ℹ️ Only text files can be swapped in, so these changes were not measured: ${fileList(unsupported)}.`);
  if (deleted.length) lines.push(`ℹ️ Deleting files cannot be emulated (production still serves them): ${fileList(deleted)}.`);
  if (plan.unreleased?.length) {
    lines.push(`ℹ️ ${fileList(plan.unreleased)} ${plan.unreleased.length > 1 ? 'are' : 'is'} not on production yet, so pages that load ${plan.unreleased.length > 1 ? 'them' : 'it'} cannot be detected; demo pages were measured regardless.`);
  }
  (plan.notes || []).forEach((note) => lines.push(`ℹ️ ${note}`));
  const labels = new Map((plan.entries || []).map((entry) => [entry.id, entry.label]));
  verdicts.forEach((verdict) => {
    const seen = new Set();
    [verdict.first, verdict.second, verdict].filter(Boolean).flatMap((item) => item.warnings || [])
      .filter((warning) => !seen.has(warning.kind) && seen.add(warning.kind))
      .forEach((warning) => lines.push(`ℹ️ ${labels.get(verdict.id) || verdict.id}: perf-tools warned \`${warning.kind}\`${warning.message ? `: ${warning.message}` : ''}`));
  });
  const discarded = verdicts
    .reduce((sum, verdict) => sum + ((verdict.first || verdict).discarded || 0), 0);
  if (discarded) {
    lines.push(`ℹ️ ${discarded} pair(s) were discarded because the runner was unusually slow (Lighthouse benchmarkIndex below ${Math.round(config.benchmarkIndexRatio * 100)}% of the job median).`);
  }
  if (verdicts.some((verdict) => verdict.status !== 'pass')) {
    lines.push('ℹ️ Lighthouse reports and traces of pages that did not pass are attached to the workflow run (`perf-traces-*` artifacts).');
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
    rows.forEach(({ page }) => lines.push(`- ${page.label}: ${page.url}${page.kind === 'after-only' ? ' (after only)' : ''}`));
    lines.push('', '</details>');
  }
  if (runUrl) lines.push('', `[Workflow run](${runUrl})`);
  let body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > COMMENT_MAX_BYTES) {
    body = `${body.slice(0, COMMENT_MAX_BYTES / 2)}\n\n…truncated; see the workflow summary.`;
  }
  return { status, body };
}
