#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  classifyChanges, classifyPage, confirmVerdict, evaluateResult, expectedLibsOrigin, isMiloSite,
  isRuntimePath, libsPaths, loadConfig, measureEntry, parseDemoUrls, parseNameStatus, previewOrigin,
  renderReport, servedCheckPaths, validateDemoUrl, variantHostError, variantUrl, verifyServed,
} from './core.js';
import { branchHead, changedFiles, pullRequest, upsertComment } from './github.js';

const { env } = process;
const config = loadConfig();
const outDir = env.PERF_OUT_DIR || 'perf-output';
const token = env.GITHUB_TOKEN;
// Chrome and git inherit the environment; they never need the token.
delete env.GITHUB_TOKEN;
const MAX_VERIFIED_FILES = 15;
const log = (message) => console.log(message);

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

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: env.PERF_REPO_DIR || '.', encoding, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitHas(sha, path) {
  try {
    git(['cat-file', '-e', `${sha}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

function gitFile(sha, path) {
  return gitHas(sha, path) ? git(['show', `${sha}:${path}`], 'buffer') : null;
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

// Both preview hosts must serve exactly the committed files, or the comparison is meaningless.
async function servedError(result, runtime, pr) {
  const { paths, truncated } = servedCheckPaths(runtime, { max: MAX_VERIFIED_FILES });
  if (truncated) {
    result.notes.push(`Only the first ${MAX_VERIFIED_FILES} changed files were checked on aem.live.`);
  }
  const sides = [
    { name: 'after', origin: result.bLibs, sha: pr.head.sha, repo: pr.head.repo.full_name, ref: pr.head.ref },
    { name: 'before', origin: result.aLibs, sha: result.baseSha, repo: pr.base.repo.full_name, ref: pr.base.ref },
  ];
  // Consumer pages (e.g. main--da-cc--adobecom.aem.live) load Milo from the branch host.
  const consumer = config.pages.find((page) => !isMiloSite(new URL(page.url).hostname));
  const corsOrigin = consumer && new URL(consumer.url).origin;
  const checks = await Promise.all(sides.map(async (side) => ({
    side,
    ...await verifyServed(
      paths.map((path) => ({ path, expected: gitFile(side.sha, path) })),
      { origin: side.origin, corsOrigin },
    ),
  })));
  const failures = checks.filter((check) => !check.ok);
  if (!failures.length) return null;
  const { side, mismatches } = failures[0];
  if (mismatches.every((item) => item.endsWith('(HTTP 404)'))) {
    return `The ${side.name} code is not served at ${side.origin}. Install the AEM Code Sync GitHub app (https://github.com/apps/aem-code-sync) on ${side.repo} and finish its setup on tools.aem.live so ${side.ref} is published to aem.live.`;
  }
  if (failures.every((check) => check.mismatches.every((item) => item.endsWith('(no CORS header)')))) {
    const list = (key) => [...new Set(failures.map((check) => check.side[key]))].join(' and ');
    return `The code at ${list('origin')} has no access-control-allow-origin header, so browsers block adobecom pages from loading it. Add the header with the value * for /libs/** to the AEM site configuration of ${list('repo')} (https://www.aem.live/docs/custom-headers), as adobecom/milo has, then force-push ${list('ref')}: aem.live adds headers only when Code Sync copies the files.`;
  }
  return `The ${side.name} code at ${side.origin} does not match ${side.ref} (${side.sha.slice(0, 7)}): ${mismatches.slice(0, 3).join(', ')}. AEM Code Sync may be delayed; re-run the check. If it keeps failing, aem.live has an older copy of the branch: normal pushes only copy the changed files, while creating or force-pushing the branch copies all of them.`;
}

function hasNewBlock(page, newBlocks) {
  return page.hits.some((path) => newBlocks.some((name) => path.startsWith(`/libs/blocks/${name}/`)
    || path.startsWith(`/libs/c2/blocks/${name}/`)));
}

async function buildPlan(result, event) {
  const pr = event.pull_request;
  if (!pr.head.repo) throw new Error('the head repository is no longer available');
  result.mergeBase = git(['merge-base', result.baseSha, pr.head.sha]).trim();
  const changes = classifyChanges(
    parseNameStatus(git(['diff', '--name-status', '--no-renames', result.mergeBase, pr.head.sha])),
    { blockExistedAtBase: (dir) => gitHas(result.mergeBase, dir) },
  );
  result.changed = changes.paths;
  result.newBlocks = changes.newBlocks;
  if (!changes.runtime.length) {
    result.reason = 'No Milo runtime files (libs/) changed, so page performance cannot change.';
    return;
  }

  const originOf = ({ ref, repo }) => previewOrigin({
    ref,
    repo: repo.name,
    owner: repo.owner.login,
  });
  result.aLibs = originOf(pr.base);
  result.bLibs = originOf(pr.head);
  if (!result.aLibs || !result.bLibs) {
    result.status = 'error';
    result.reason = `The branch name is too long for an aem.live preview: <branch>--${pr.head.repo.name}--${pr.head.repo.owner.login} must be at most 63 characters.`;
    return;
  }
  result.drift = git(['diff', '--name-only', '--no-renames', result.mergeBase, result.baseSha])
    .split('\n').filter(isRuntimePath);
  const notServed = await servedError(result, changes.runtime, pr);
  if (notServed) {
    result.status = 'error';
    result.reason = notServed;
    return;
  }

  const allowDraft = changes.newBlocks.length > 0;
  parseDemoUrls(await currentBody(event)).forEach((value) => {
    const { url, error } = validateDemoUrl(value, { allowDraft });
    if (error) result.demo.rejected.push({ url: value, reason: error });
    else if (result.demo.urls.length >= config.maxDemoUrls) {
      result.demo.rejected.push({ url: value, reason: `only ${config.maxDemoUrls} demo pages are measured` });
    } else if (!result.demo.urls.includes(url)) result.demo.urls.push(url);
  });

  const pages = [
    ...config.pages.map((page) => ({ ...page, kind: 'mvp' })),
    ...result.demo.urls.map((url, index) => ({ id: `demo-${index + 1}`, label: `Demo ${index + 1}`, production: url, url, kind: 'demo' })),
  ];
  const options = { martechOff: config.martechOff };
  const libsOrigin = (page, variant) => expectedLibsOrigin(page.url, result[`${variant}Libs`]);
  const targets = pages.flatMap((page) => ['a', 'b'].map((variant) => ({
    key: `${page.id}:${variant}`,
    url: variantUrl(page.url, result[`${variant}Libs`], options),
  })));
  const { discover } = await import('./runner.js');
  const found = await discover(targets, { config, log });

  result.pages = pages.map((page) => {
    const discovery = {};
    ['a', 'b'].forEach((variant) => {
      const sample = found[`${page.id}:${variant}`];
      const expected = libsOrigin(page, variant);
      const other = libsOrigin(page, variant === 'a' ? 'b' : 'a');
      const hostError = sample?.ok ? variantHostError(sample.libs, expected, other) : null;
      discovery[variant] = {
        ok: Boolean(sample?.ok && !hostError),
        error: hostError || sample?.error,
        paths: libsPaths(sample?.libs, expected),
      };
    });
    const verdict = classifyPage({
      discovery,
      changedPaths: result.changed,
      driftPaths: result.drift,
    });
    const loaded = verdict.status === 'measure'
      ? [...new Set([...discovery.a.paths, ...discovery.b.paths])] : undefined;
    return {
      id: page.id,
      label: page.label,
      kind: page.kind,
      production: page.production,
      url: page.url,
      ...verdict,
      loaded,
    };
  });

  const mvp = result.pages.filter((page) => page.kind === 'mvp');
  const mvpAffected = mvp.some((page) => ['measure', 'stale'].includes(page.status));
  if (!mvpAffected && !mvp.some((page) => page.status === 'error') && !result.demo.urls.length) {
    result.policy = 'None of the MVP pages load the changed code. Add a live page that uses it to the pull request description, for example `Demo: https://main--<site>--adobecom.aem.live/<page>`. Editing the description re-runs the check.';
  }
  result.entries = result.pages.filter((page) => page.status === 'measure').map((page) => {
    const afterOnly = page.kind === 'demo' && hasNewBlock(page, result.newBlocks);
    return {
      id: page.id,
      label: page.label,
      kind: afterOnly ? 'after-only' : 'compare',
      gate: page.kind === 'mvp' || afterOnly || !mvpAffected,
      round: 1,
      production: page.production,
      url: page.url,
      a: variantUrl(page.url, result.aLibs, options),
      b: variantUrl(page.url, result.bLibs, options),
      aLibs: libsOrigin(page, 'a'),
      bLibs: libsOrigin(page, 'b'),
    };
  });
  if (result.entries.some((entry) => !entry.gate)) {
    result.notes.push('Demo pages are shown for reference because MVP pages load the changed code.');
  }
  result.status = result.entries.length ? 'measure' : 'skip';
  if (!result.entries.length && !result.policy) {
    result.reason = result.pages.some((page) => ['stale', 'error'].includes(page.status))
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
    status: 'skip',
    reason: '',
    policy: '',
    changed: [],
    newBlocks: [],
    drift: [],
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
    const { lighthouseRun } = await import('./runner.js');
    result = await measureEntry(entry, config, {
      runOnce: (url) => lighthouseRun(url, { config }),
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

// A failing page is not trusted when the base branch changed its files during the measurement.
async function checkBaseMoved(plan, verdicts) {
  if (!token || !plan.baseRef || !verdicts.some((verdict) => verdict.status === 'fail')) return;
  try {
    const head = await branchHead({ repository: plan.repository, branch: plan.baseRef, token });
    if (head === plan.baseSha) return;
    const moved = (await changedFiles({ repository: plan.repository, base: plan.baseSha, head, token })).filter(isRuntimePath).map((path) => `/${path}`.toLowerCase());
    verdicts.forEach((verdict) => {
      const loaded = plan.pages.find((page) => page.id === verdict.id)?.loaded || [];
      if (verdict.status === 'fail' && verdict.kind === 'compare' && moved.some((path) => loaded.includes(path))) {
        Object.assign(verdict, {
          status: 'inconclusive',
          reason: `${plan.baseRef} changed files this page loads during the measurement; re-run the check`,
        });
      }
    });
  } catch (error) {
    log(`Could not check whether ${plan.baseRef} moved: ${error.message}`);
  }
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
  await checkBaseMoved(plan, verdicts);
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
