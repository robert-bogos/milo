// POC only: turns a fork pull request that says "Replay: adobecom/milo#1234" into the
// pull_request event the real check would get for that upstream pull request.
// "Replay: adobecom/milo@<branch>" does the same for an adobecom/milo branch without a pull
// request, as if it were opened against stage, so test changes stay out of the milo PR list.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const { env } = process;
const carrier = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const body = carrier.pull_request.body || '';
const pull = /Replay:\s*(?:https:\/\/github\.com\/)?adobecom\/milo(?:\/pull\/|#)(\d+)/i.exec(body);
const branch = /Replay:\s*(?:https:\/\/github\.com\/adobecom\/milo\/tree\/|adobecom\/milo@)([\w./-]*[\w-])/i.exec(body);
if (!pull && !branch) {
  throw new Error('Add "Replay: adobecom/milo#<number>" or "Replay: adobecom/milo@<branch>" to the pull request description.');
}

async function api(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

async function upstreamBranch(name) {
  const [repo, tip] = await Promise.all([
    api('repos/adobecom/milo'),
    api(`repos/adobecom/milo/branches/${encodeURIComponent(name)}`),
  ]);
  return {
    number: null,
    title: `Branch ${name}`,
    html_url: `https://github.com/adobecom/milo/tree/${name}`,
    base: { ref: 'stage', repo },
    head: { ref: name, sha: tip.commit.sha, repo },
  };
}

const upstream = pull ? await api(`repos/adobecom/milo/pulls/${pull[1]}`) : await upstreamBranch(branch[1]);
if (upstream.head.repo?.full_name !== 'adobecom/milo') {
  throw new Error('Only pull requests from adobecom/milo branches are served on aem.live.');
}
const base = await api(`repos/adobecom/milo/branches/${encodeURIComponent(upstream.base.ref)}`);
const event = {
  action: 'opened',
  repository: carrier.repository,
  pull_request: {
    number: carrier.pull_request.number,
    body,
    draft: false,
    base: { ref: upstream.base.ref, sha: base.commit.sha, repo: upstream.base.repo },
    head: { ref: upstream.head.ref, sha: upstream.head.sha, repo: upstream.head.repo },
  },
  replay: { number: upstream.number, title: upstream.title, url: upstream.html_url },
};
mkdirSync(dirname(env.REPLAY_EVENT), { recursive: true });
writeFileSync(env.REPLAY_EVENT, `${JSON.stringify(event, null, 2)}\n`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `head_sha=${upstream.head.sha}\n`);
console.log(`Replaying ${upstream.html_url} (${upstream.head.ref} @ ${upstream.head.sha.slice(0, 7)}) against ${upstream.base.ref} @ ${base.commit.sha.slice(0, 7)}`);
