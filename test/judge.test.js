// Bugs found while testing the app the way a hackathon judge would. Each test was written to
// fail first, then the fix made it pass. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-judge-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.DEFAULT_CURRENCY = 'USD';
process.env.SCHEDULER_INTERVAL_MIN = '0';
process.env.APP_TIMEZONE = 'UTC';

const { start } = await import('../server.js');
const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const call = async (p, body, headers = {}) => {
  const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const t = await res.text();
  let data;
  try { data = JSON.parse(t); } catch { data = t; }
  return { status: res.status, data, headers: res.headers };
};
test.after(() => server.close());

test('B2: npm run seed loads tracked samples that "Remove sample data" can delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-seedscript-'));
  const r = spawnSync(process.execPath, ['scripts/seed.js'], { env: { ...process.env, DATA_DIR: dir, PAYPAL_MODE: 'mock' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const check = spawnSync(process.execPath, ['--input-type=module', '-e', "const { sampleInfo } = await import('./src/sample.js'); console.log(JSON.stringify(sampleInfo()));"], { env: { ...process.env, DATA_DIR: dir, PAYPAL_MODE: 'mock' }, encoding: 'utf8' });
  const info = JSON.parse(check.stdout.trim().split('\n').at(-1));
  assert.equal(info.tracked, true, 'seed script records what it created');
  assert.ok(info.count > 10);
});

test('B4: demo opens in one click, even without a business name', async () => {
  const r = await call('/api/settings/paypal/demo', {});
  assert.equal(r.status, 200);
  assert.ok((await call('/api/config')).data.businessName, 'a demo business name is filled in');
});

test('B8: cross-site write requests are refused (CSRF)', async () => {
  const r = await call('/api/invoices', { clientName: 'X', clientEmail: 'x@example.com', items: [{ name: 'a', quantity: 1, unitPrice: 5 }], sendNow: true }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const same = await call('/api/sample', null, { origin: 'https://evil.example' });
  assert.equal(same.status, 200, 'reads are fine');
  const own = await call('/api/actions?status=pending', null, { origin: base });
  assert.equal(own.status, 200);
});

test('B1: wrong passcodes are rate-limited (no brute force)', async () => {
  await call('/api/settings/passcode', { passcode: 'correct-horse' });
  let last;
  for (let k = 0; k < 12; k++) last = await call('/api/login', { password: `guess${k}` });
  assert.equal(last.status, 429, 'the 12th wrong guess inside a minute is refused');
  // runs last: it leaves a passcode set, which would lock the other tests out
  const ok = await call('/api/login', { password: 'correct-horse' });
  assert.ok([200, 429].includes(ok.status));
});
