import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_MARKER } from '../core.js';
import { upsertComment } from '../github.js';

function fakeGitHub(pages) {
  const calls = [];
  const fetchImpl = async (url, { method = 'GET', body } = {}) => {
    calls.push({ url, method, body: body && JSON.parse(body) });
    if (method === 'GET') {
      const page = Number(new URL(url).searchParams.get('page'));
      return { ok: true, status: 200, json: async () => pages[page - 1] || [] };
    }
    return { ok: true, status: method === 'POST' ? 201 : 200, json: async () => ({ id: 99 }) };
  };
  return { calls, fetchImpl };
}

const bot = { login: 'github-actions[bot]' };
const args = { repository: 'adobecom/milo', number: 5, token: 't' };

describe('upsertComment', () => {
  it("updates the check's own comment, even on a later page", async () => {
    const filler = Array.from({ length: 100 }, (_, id) => ({ id, user: bot, body: 'other' }));
    const { calls, fetchImpl } = fakeGitHub([filler, [{ id: 7, user: bot, body: `${REPORT_MARKER}\nold` }]]);
    await upsertComment({ ...args, body: 'new', fetchImpl });
    assert.deepEqual(calls.at(-1), { url: 'https://api.github.com/repos/adobecom/milo/issues/comments/7', method: 'PATCH', body: { body: 'new' } });
  });

  it('ignores marker comments written by other users', async () => {
    const { calls, fetchImpl } = fakeGitHub([[{ id: 1, user: { login: 'someone' }, body: REPORT_MARKER }]]);
    await upsertComment({ ...args, body: 'new', fetchImpl });
    assert.equal(calls.at(-1).method, 'POST');
    assert.equal(calls.at(-1).url, 'https://api.github.com/repos/adobecom/milo/issues/5/comments');
  });

  it('does not create a comment when asked only to update', async () => {
    const { calls, fetchImpl } = fakeGitHub([[]]);
    assert.equal(await upsertComment({ ...args, body: 'new', create: false, fetchImpl }), null);
    assert.deepEqual(calls.map((call) => call.method), ['GET']);
  });

  it('reports the HTTP status of failed requests', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403 });
    await assert.rejects(upsertComment({ ...args, body: 'x', fetchImpl }), { status: 403 });
  });
});
