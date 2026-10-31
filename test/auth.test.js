// Passcode login (runs in its own process so APP_PASSWORD applies at startup).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-auth-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.APP_PASSWORD = 'open-sesame';
process.env.SCHEDULER_INTERVAL_MIN = '0';

const { start } = await import('../server.js');
const server = await start(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

test('API and pages require a session; webhooks/health stay public', async () => {
  assert.equal((await fetch(base + '/api/invoices')).status, 401);
  const page = await fetch(base + '/dashboard', { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');
  assert.equal((await fetch(base + '/login.html')).status, 200);
  for (const asset of ['/app.css', '/common.js', '/favicon.svg', '/fonts/manrope-latin-400-normal.woff2']) {
    assert.equal((await fetch(base + asset)).status, 200, asset + ' must load on the login page');
  }
  assert.equal((await fetch(base + '/api/health')).status, 200);
  const wh = await fetch(base + '/api/webhooks/paypal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.notEqual(wh.status, 401);
});

test('wrong passcode rejected, right one sets a session cookie', async () => {
  const post = (pw) => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) });
  assert.equal((await post('nope')).status, 401);
  const ok = await post('open-sesame');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await fetch(base + '/api/invoices', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/api/invoices', { headers: { cookie: 'pp_session=forged' } })).status, 401);
});
