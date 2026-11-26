#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  classifyChanges, classifyPage, confirmVerdict, evaluateResult, isRuntimePath, loadConfig, pageUrl,
  parseDemoUrls, parseNameStatus, planSources, renderReport, validateDemoUrl,
} from './core.js';
import { pullRequest, upsertComment } from './github.js';
import { createGit, existingPaths, fetchProduction, materializeSources } from './sources.js';

const { env } = process;
const config = loadConfig();
const outDir = env.PERF_OUT_DIR || 'perf-output';
const token = env.GITHUB_TOKEN;
// Chrome and git inherit the environment; they never need the token.
delete env.GITHUB_TOKEN;
const log = (message) => console.log(message);
const git = createGit(env.PERF_REPO_DIR || '.');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function setOutput(name, value) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function currentBody(event) {
  if (token) {
    try {
      const pr = await pullRequest({
        repository: event.repository.full_name,
        number: event.pull_request.number,
        token,
      });
      return pr.body || '';
    } catch (error) {
      log(`Using the PR description from the event: ${error.message}`);
    }
  }
  return event.pull_request.body || '';
}

// Hits are lowercase. Discovery also lists 404s, so production pages that already use an
// unreleased block show its files.
function hasNewBlock(page, newBlocks) {
  return page.hits.some((path) => newBlocks.map((name) => name.toLowerCase())
    .some((name) => path.startsWith(`/libs/blocks/${name}/`) || path.startsWith(`/libs/c2/blocks/${name}/`)));
}

async function buildPlan(result, event) {
  const pr = event.pull_request;
  if (!pr.head.repo) throw new Error('the head repository is no longer available');
  result.mergeBase = git(['merge-base', result.baseSha, pr.head.sha]).trim();
  const changes = classifyChanges(
    parseNameStatus(git(['diff', '--name-status', '--no-renames', result.mergeBase, pr.head.sha])),
    { blockExistedAtBase: (dir) => existingPaths(git, result.mergeBase, [dir]).size > 0 },
  );
  result.changed = changes.paths;
  result.newBlocks = changes.newBlocks;
  if (!changes.runtime.length) {
    result.reason = 'No Milo runtime files (libs/) changed, so page performance cannot change.';
    return;
  }

  const { repository, branch } = config.production;
  result.productionSha = fetchProduction(git, { url: `https://github.com/${repository}.git`, branch });
  const drift = git(['diff', '--name-only', '--no-renames', result.productionSha, result.mergeBase])
    .split('\n').filter(isRuntimePath);
  const inspected = [...new Set([...drift, ...changes.files])];
  const existsAtBase = existingPaths(git, result.mergeBase, inspected);
  const sources = planSources({
    changed: changes.files,
    drift,
    existsAtBase,
    existsAtHead: existingPaths(git, pr.head.sha, changes.files),
  });
  const swapped = new Set([...Object.keys(sources.before), ...Object.keys(sources.after)]).size;
  const { unsupported, deleted } = sources;
  result.sources = { drift: drift.length, swapped, unsupported, deleted };
  if (swapped > config.maxSourceFiles) {
    result.status = 'error';
    result.reason = `${swapped} Milo files would have to be swapped into production pages (at most ${config.maxSourceFiles}). Update the branch from ${pr.base.ref} and re-run the check.`;
    return;
  }
  const atProduction = existingPaths(git, result.productionSha, changes.files);
  result.unreleased = changes.files
    .filter((path) => existsAtBase.has(path) && !atProduction.has(path));
  const { files } = materializeSources(git, {
    sources,
    revisions: { base: result.mergeBase, head: pr.head.sha },
    dir: join(outDir, 'sources'),
    log,
  });
  log(`Swapping ${swapped} files (${files} versions): ${drift.length} differ between production and the merge base.`);

  parseDemoUrls(await currentBody(event)).forEach((value) => {
    const { url, error } = validateDemoUrl(value);
    if (error) result.demo.rejected.push({ url: value, reason: error });
    else if (result.demo.urls.length >= config.maxDemoUrls) {
      result.demo.rejected.push({ url: value, reason: `only ${config.maxDemoUrls} demo pages are measured` });
    } else if (!result.demo.urls.includes(url)) result.demo.urls.push(url);
  });

  const pages = [
    ...config.pages.map((page) => ({ ...page, kind: 'mvp' })),
    ...result.demo.urls.map((url, index) => ({ id: `demo-${index + 1}`, label: `Demo ${index + 1}`, url, kind: 'demo' })),
  ];
  const { discover } = await import('./runner.js');
  const found = await discover(
    pages.map((page) => ({ key: page.id, url: pageUrl(page.url, config) })),
    { config, log },
  );
  const unswappable = unsupported.map((path) => `/${path}`.toLowerCase());
  result.pages = pages.map((page) => {
    let verdict = classifyPage({
      discovery: found[page.id],
      origin: new URL(page.url).origin,
      changedPaths: result.changed,
      unsupported: unswappable,
    });
    // Production cannot reveal which pages load files that are not released yet.
    if (page.kind === 'demo' && verdict.status === 'unaffected' && result.unreleased.length) {
      verdict = { status: 'measure', hits: [] };
    }
    return { id: page.id, label: page.label, kind: page.kind, url: page.url, ...verdict };
  });

  const mvp = result.pages.filter((page) => page.kind === 'mvp');
  const mvpAffected = mvp.some((page) => page.status === 'measure');
  if (!mvpAffected && !mvp.some((page) => page.status === 'error') && !result.demo.urls.length) {
    result.policy = 'None of the MVP pages load the changed code. Add a page that uses it to the pull request description, for example `Demo: https://www.adobe.com/<page>.html` or a published `Demo: https://main--milo--adobecom.aem.live/drafts/<page>`. Editing the description re-runs the check.';
  }
  result.entries = result.pages.filter((page) => page.status === 'measure').map((page) => {
    const afterOnly = page.kind === 'demo' && hasNewBlock(page, result.newBlocks);
    return {
      id: page.id,
      label: page.label,
      kind: afterOnly ? 'after-only' : 'compare',
      gate: page.kind === 'mvp' || afterOnly || !mvpAffected,
      round: 1,
      url: page.url,
    };
  });
  if (result.entries.some((entry) => !entry.gate)) {
    result.notes.push('Demo pages are shown for reference because MVP pages load the changed code.');
  }
  result.status = result.entries.length ? 'measure' : 'skip';
  if (!result.entries.length && !result.policy) {
    result.reason = result.pages.some((page) => page.status === 'error')
      ? 'No page was measured. The pages marked ⚠️ below could not be checked.'
      : 'None of the tested pages load the changed files.';
  }
}

async function createPlan() {
  const event = readJson(env.GITHUB_EVENT_PATH);
  const pr = event.pull_request;
  const result = {
    repository: event.repository.full_name,
    pullRequest: pr.number,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    // The event's base.sha is from when the PR was opened; the workflow passes the current tip.
    baseSha: env.PERF_BASE_SHA || pr.base.sha,
    headSha: pr.head.sha,
    mergeBase: null,
    productionSha: null,
    status: 'skip',
    reason: '',
    policy: '',
    changed: [],
    newBlocks: [],
    unreleased: [],
    sources: null,
    demo: { urls: [], rejected: [] },
    pages: [],
    entries: [],
    notes: [],
  };
  try {
    await buildPlan(result, event);
  } catch (error) {
    Object.assign(result, { status: 'error', reason: `The check could not be prepared: ${String(error.message).slice(0, 300)}`, entries: [] });
  }
  writeJson(join(outDir, 'plan.json'), result);
  setOutput('measure', result.entries.length ? 'true' : 'false');
  setOutput('matrix', JSON.stringify({ include: result.entries }));
  log(`Plan: ${result.status}${result.reason ? ` - ${result.reason}` : ''}`);
  result.pages.forEach((page) => log(`  ${page.id}: ${page.status}${page.hits?.length ? ` (${page.hits.slice(0, 3).join(', ')})` : ''}${page.reason ? ` - ${page.reason}` : ''}`));
}

async function measure() {
  const entry = JSON.parse(env.PERF_PAGE);
  let result;
  try {
    const sourcesDir = env.PERF_SOURCES_DIR;
    const manifest = readJson(join(sourcesDir, 'manifest.json'));
    const { loadSources, measurePage } = await import('./engine.js');
    result = await measurePage({
      entry,
      manifest,
      files: loadSources(sourcesDir, manifest),
      config,
      toolsDir: env.PERF_TOOLS_DIR,
      workDir: join(outDir, 'engine', `${entry.id}-r${entry.round}`),
      log,
    });
  } catch (error) {
    result = {
      id: entry.id, round: entry.round, kind: entry.kind, gate: entry.gate, runs: [], error: `measurement crashed: ${error.message}`,
    };
  }
  writeJson(join(outDir, `result-${entry.id}-r${entry.round}.json`), result);
  const verdict = evaluateResult(result, config);
  log(`${entry.id} round ${entry.round}: ${verdict.status}${verdict.reason ? ` - ${verdict.reason}` : ''}`);
  // Lighthouse reports and traces are kept for pages that need a closer look.
  setOutput('traces', verdict.status === 'pass' ? 'false' : 'true');
}

function loadResults(dir) {
  const results = new Map();
  let files = [];
  try {
    files = readdirSync(dir, { recursive: true }).filter((name) => /(^|\/)result-[^/]+\.json$/.test(name));
  } catch {
    return results;
  }
  files.forEach((name) => {
    try {
      const result = readJson(join(dir, name));
      results.set(`${result.id}:${result.round}`, result);
    } catch (error) {
      log(`Ignoring ${name}: ${error.message}`);
    }
  });
  return results;
}

function triage() {
  const { entries = [] } = readJson(env.PERF_PLAN);
  const results = loadResults(env.PERF_RESULTS_DIR || outDir);
  const confirm = entries
    .filter((entry) => evaluateResult(results.get(`${entry.id}:1`), config).status === 'fail')
    .map((entry) => ({ ...entry, round: 2 }));
  setOutput('confirm', confirm.length ? 'true' : 'false');
  setOutput('matrix', JSON.stringify({ include: confirm }));
  log(confirm.length ? `Re-running: ${confirm.map((entry) => entry.id).join(', ')}` : 'Nothing to re-run.');
}

async function report() {
  const event = readJson(env.GITHUB_EVENT_PATH);
  let plan;
  try {
    plan = readJson(env.PERF_PLAN);
  } catch {
    plan = {
      repository: event.repository.full_name,
      pullRequest: event.pull_request.number,
      headSha: event.pull_request.head.sha,
      status: 'error',
      reason: 'The planning job did not finish; see the workflow logs.',
      changed: [],
      pages: [],
      entries: [],
    };
  }
  const results = loadResults(env.PERF_RESULTS_DIR || outDir);
  const verdicts = (plan.entries || []).map((entry) => {
    const first = evaluateResult(results.get(`${entry.id}:1`), config);
    const second = results.get(`${entry.id}:2`);
    const verdict = confirmVerdict(first, second && evaluateResult(second, config));
    return { ...verdict, id: entry.id, kind: entry.kind };
  });
  const enforce = env.PERF_ENFORCE === 'true';
  const runUrl = env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';
  const { status, body } = renderReport({ plan, verdicts, config, enforce, runUrl });
  log(body);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${body}\n`);
  writeJson(join(outDir, 'report.json'), { status, enforce, verdicts });
  if (token) {
    try {
      await upsertComment({
        repository: plan.repository,
        number: plan.pullRequest,
        body,
        token,
        create: plan.changed?.length > 0 || plan.status === 'error',
      });
    } catch (error) {
      log(`Could not comment on the pull request (${error.message}); the report is in the job summary.`);
    }
  }
  if (status === 'fail' && enforce) {
    log('Failing: confirmed performance regression or missing demo page.');
    process.exitCode = 1;
  }
}

async function chrome() {
  const { ensureChrome } = await import('./runner.js');
  const path = await ensureChrome({ cacheDir: join(env.RUNNER_TEMP || outDir, 'chrome') });
  log(`Using Chrome at ${path}`);
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `CHROME_PATH=${path}\n`);
}

const commands = { chrome, plan: createPlan, measure, triage, report };
const command = commands[process.argv[2]];
if (!command) {
  console.error(`Usage: node cli.js <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
await command();
