import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getChromePath } from 'chrome-launcher';
import { loadConfig } from '../core.js';
import { discover } from '../runner.js';

function hasChrome() {
  try {
    return Boolean(getChromePath());
  } catch {
    return false;
  }
}

test('concurrent discovery loads do not abort each other', { skip: !hasChrome() && 'Chrome is not installed', timeout: 180000 }, async () => {
  // The slow page is still navigating when the fast one finishes, which used to clear the slow
  // run's Lighthouse timing marks ("performance mark has not been set").
  const server = createServer((req, res) => {
    if (req.url.startsWith('/libs/')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('');
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Page</title><h1>Page</h1><script src="/libs/utils/utils.js"></script>');
    }, req.url.startsWith('/slow') ? 12000 : 0);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const found = await discover([
      { key: 'fast', url: `${origin}/fast` },
      { key: 'slow', url: `${origin}/slow` },
    ], { config: { ...loadConfig(), discoveryConcurrency: 2 }, attempts: 1 });
    ['fast', 'slow'].forEach((key) => {
      assert.equal(found[key].ok, true, `${key}: ${found[key].error}`);
      assert.deepEqual(found[key].libs, [`${origin}/libs/utils/utils.js`]);
    });
  } finally {
    server.close();
  }
});
