// A shared, hosted copy (HOSTED_DEMO=1 on Render): real PayPal sandbox mode, sample
// history on boot, and nobody can disconnect PayPal or wipe data for everyone else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-hosted-'));
process.env.PAYPAL_MODE = 'sandbox';
process.env.PAYPAL_CLIENT_ID = `A${'x'.repeat(79)}`;
process.env.PAYPAL_CLIENT_SECRET = `E${'y'.repeat(79)}`;
process.env.PAYPAL_SYNC_SECONDS = '0';
process.env.LLM_PROVIDER = 'none';
process.env.SCHEDULER_INTERVAL_MIN = '0';
process.env.APP_TIMEZONE = 'UTC';
process.env.HOSTED_DEMO = '1';
process.env.SEED_SAMPLE_ON_BOOT = '1';
process.env.BUSINESS_NAME = 'Ortiz Design Studio';

const { start } = await import('../server.js');
const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const call = async (p, body) => {
  const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const t = await res.text();
  let data;
  try { data = JSON.parse(t); } catch { data = t; }
  return { status: res.status, data };
};
test.after(() => server.close());

test('B3: the simulated-payment endpoints do not exist outside demo mode', async () => {
  assert.equal((await call('/api/mock/pay/INV2-ABCD', {})).status, 400);
  assert.equal((await call('/api/mock/invoice/INV2-ABCD')).status, 400);
});

test('B5: hosted demo boots with sample history and skips the setup screen', async () => {
  assert.equal((await call('/app')).data.includes?.('welcome') ? 'welcome' : 'ok', 'ok');
  const { invoices } = (await call('/api/invoices')).data;
  assert.ok(invoices.length > 10, 'visitors see a full book straight away');
  assert.ok(invoices.every((i) => !String(i.paypalId || '').startsWith('INV2-MOCK-')), 'no simulated open invoices on a real account');
});

test('B5: hosted demo blocks changes that would affect every visitor', async () => {
  for (const [p, body] of [
    ['/api/settings/paypal/disconnect', {}],
    ['/api/settings/paypal/demo', {}],
    ['/api/settings/paypal/connect', { clientId: 'x', clientSecret: 'y' }],
    ['/api/demo/reset', {}],
    ['/api/sample/remove', {}],
    ['/api/settings/passcode', { passcode: 'abcd' }],
  ]) {
    const r = await call(p, body);
    assert.equal(r.status, 403, p);
    assert.match(r.data.error, /shared demo/);
  }
  assert.equal((await call('/api/config')).data.hostedDemo, true);
});

test('a forged PayPal webhook is refused on a real account', async () => {
  const r = await call('/api/webhooks/paypal', { event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: 'INV2-ANY', status: 'PAID' } } });
  assert.ok(r.status >= 400, `status ${r.status}`);
  assert.equal(r.data.ok, undefined);
});
