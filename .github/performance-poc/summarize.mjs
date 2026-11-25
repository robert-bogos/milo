// POC only: summarizes accuracy.mjs results. Usage: node summarize.mjs <directory with *.jsonl>
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../performance/', import.meta.url));
const { confirmVerdict } = await import(`${root}core.js`);
const dir = process.argv[2];
const records = readdirSync(dir, { recursive: true })
  .filter((name) => name.endsWith('.jsonl'))
  .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));

const groups = new Map();
records.forEach((record) => {
  const key = `${record.id} ${record.scenario}`;
  groups.set(key, { ...groups.get(key), [record.round]: record });
});

const lcp = (v) => {
  const m = v?.metrics?.lcp;
  return m ? `${Math.round(m.before)}→${Math.round(m.after)} (${(m.relative * 100).toFixed(1)}%, p=${m.p.toFixed(3)})` : 'n/a';
};
const cls = (v) => {
  const m = v?.metrics?.cls;
  return m ? `${m.before.toFixed(3)}→${m.after.toFixed(3)}` : 'n/a';
};
const status = (v) => (v ? `${v.status}${v.regressed?.length ? ` (${v.regressed.join(',')})` : ''}${v.reason ? `: ${v.reason}` : ''}` : 'missing');
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((x, y) => x - y);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};

const lines = [
  '| Page | Scenario | Round 1 | LCP round 1 | CLS round 1 | Round 2 | LCP round 2 | CLS round 2 | Check result | Minutes | benchmarkIndex |',
  '|:--|:--|:--|--:|--:|:--|--:|--:|:--|--:|--:|',
];
const tally = {};
[...groups.entries()].sort(([x], [y]) => x.localeCompare(y)).forEach(([key, rounds]) => {
  const [id, scenario] = key.split(' ');
  const r1 = rounds[1]?.verdict;
  const r2 = rounds[2]?.verdict;
  // The real check re-measures only pages that fail the first round.
  const outcome = r1 ? confirmVerdict(r1, r1.status === 'fail' ? r2 : undefined) : null;
  const t = tally[scenario] || {
    pages: 0, rounds: 0, roundFails: 0, confirmed: 0, inconclusive: 0,
  };
  t.pages += 1;
  [r1, r2].filter(Boolean).forEach((v) => {
    t.rounds += 1;
    if (v.status === 'fail') t.roundFails += 1;
  });
  if (outcome?.status === 'fail') t.confirmed += 1;
  if (!outcome || outcome.status === 'inconclusive') t.inconclusive += 1;
  tally[scenario] = t;
  const minutes = [rounds[1]?.minutes, rounds[2]?.minutes].filter(Number.isFinite).join(' / ');
  const bi = [rounds[1], rounds[2]].map((r) => Math.round(median((r?.runs || []).map((run) => run.bi)))).filter(Number.isFinite).join(' / ');
  lines.push(`| ${id} | ${scenario} | ${status(r1)} | ${lcp(r1)} | ${cls(r1)} | ${status(r2)} | ${lcp(r2)} | ${cls(r2)} | ${status(outcome)} | ${minutes} | ${bi} |`);
});

const summary = [
  '## Performance check accuracy',
  '',
  '| Scenario | Pages | Rounds failing | Pages failing the check (both rounds) | Inconclusive |',
  '|:--|--:|--:|--:|--:|',
  ...Object.entries(tally).map(([scenario, t]) => `| ${scenario}${scenario === 'aa' ? ' (no change: failures are false alarms)' : ' (injected regression: failures are detections)'} | ${t.pages} | ${t.roundFails}/${t.rounds} | ${t.confirmed}/${t.pages} | ${t.inconclusive} |`),
  '',
  ...lines,
  '',
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
