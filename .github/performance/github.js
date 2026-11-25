import { REPORT_MARKER } from './core.js';

const API = 'https://api.github.com';
const BOT_LOGIN = 'github-actions[bot]';

async function request(path, { token, method = 'GET', body, fetchImpl = fetch }) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'milo-performance-check',
      'x-github-api-version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = new Error(`GitHub API ${method} ${path.split('?')[0]} failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

// Updates this check's own comment, or creates one when `create` is true.
export async function upsertComment({
  repository, number, body, token, create = true, fetchImpl,
}) {
  for (let page = 1; page <= 30; page += 1) {
    const comments = await request(`/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`, { token, fetchImpl });
    const own = comments.find((comment) => comment.user?.login === BOT_LOGIN
      && comment.body?.includes(REPORT_MARKER));
    if (own) {
      return request(`/repos/${repository}/issues/comments/${own.id}`, { token, method: 'PATCH', body: { body }, fetchImpl });
    }
    if (comments.length < 100) break;
  }
  if (!create) return null;
  return request(`/repos/${repository}/issues/${number}/comments`, { token, method: 'POST', body: { body }, fetchImpl });
}

export async function pullRequest({ repository, number, token, fetchImpl }) {
  return request(`/repos/${repository}/pulls/${number}`, { token, fetchImpl });
}

export async function branchHead({ repository, branch, token, fetchImpl }) {
  const result = await request(`/repos/${repository}/branches/${encodeURIComponent(branch)}`, { token, fetchImpl });
  return result.commit.sha;
}

export async function changedFiles({ repository, base, head, token, fetchImpl }) {
  const result = await request(`/repos/${repository}/compare/${base}...${head}?per_page=100`, { token, fetchImpl });
  return (result.files || [])
    .flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
}
