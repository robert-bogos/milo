// POC only: turns a fork pull request that says "Replay: adobecom/milo#1234" into the
// pull_request event the real check would get for that upstream pull request.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const { env } = process;
const carrier = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const body = carrier.pull_request.body || '';
const match = /Replay:\s*(?:https:\/\/github\.com\/)?adobecom\/milo(?:\/pull\/|#)(\d+)/i.exec(body);
if (!match) throw new Error('Add "Replay: adobecom/milo#<number>" to the pull request description.');

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

const upstream = await api(`repos/adobecom/milo/pulls/${match[1]}`);
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
