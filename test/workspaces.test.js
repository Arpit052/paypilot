// Hosted demo with private visitor workspaces: two visitors never see each other's data,
// settings, keys or notifications, and a new visitor lands on a working demo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-spaces-'));
process.env.PAYPAL_MODE = 'sandbox';
process.env.PAYPAL_CLIENT_ID = 'A' + 'x'.repeat(79); // the server's own keys: must never reach a visitor
process.env.PAYPAL_CLIENT_SECRET = 'E' + 'y'.repeat(79);
process.env.PAYPAL_SYNC_SECONDS = '0';
process.env.SCHEDULER_INTERVAL_MIN = '0';
process.env.LLM_PROVIDER = 'none';
process.env.HOSTED_DEMO = '1';
process.env.VISITOR_WORKSPACES = '1';
process.env.BUSINESS_NAME = 'Ortiz Design Studio';
process.env.APP_TIMEZONE = 'UTC';

const { start } = await import('../server.js');
const server = await start(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function visitor() {
  let cookie = '';
  return async (p, body, extra = {}) => {
    const res = await fetch(base + p, { redirect: 'manual', ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra } });
    const set = res.headers.get('set-cookie');
    if (set && /pp_space=/.test(set)) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers, cookie };
  };
}
const A = visitor();
const B = visitor();

test('a new visitor lands on a working demo, not a setup form', async () => {
  const r = await A('/app');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/dashboard');
  assert.match(r.headers.get('set-cookie'), /pp_space=[a-f0-9]{32}; Path=\/; HttpOnly; SameSite=Lax/);
  const inv = (await A('/api/invoices')).data.invoices;
  assert.ok(inv.length > 10);
  const cfg = (await A('/api/config')).data;
  assert.equal(cfg.privateSpace, true);
  assert.equal(cfg.businessName, 'Ortiz Design Studio');
});

test("the server's own PayPal keys never reach a visitor", async () => {
  const s = (await A('/api/settings')).data;
  assert.equal(s.paypal.mode, 'mock');
  assert.equal(s.paypal.source, 'demo');
  assert.equal(s.paypal.envKeysAvailable, false, "a visitor can't fall back to the server's keys");
  assert.ok(!JSON.stringify(s).includes('xxxxxxxx') && !JSON.stringify(s).includes('yyyyyyyy'));
  assert.ok(!JSON.stringify((await A('/api/config')).data).includes('xxxxxxxx'));
});

test('two visitors never see each other', async () => {
  await B('/api/config');
  const nB = (await B('/api/invoices')).data.invoices.length;
  // A renames the business, drafts and approves an invoice, and pays one
  await A('/api/settings/business', { businessName: 'Visitor A Co' });
  const d = await A('/api/invoices', { clientName: 'Only For A', clientEmail: 'a@example.com', items: [{ name: 'Secret work', quantity: 1, unitPrice: 777 }] });
  assert.equal((await A(`/api/actions/${d.data.action.id}/approve`, {})).status, 200);
  const open = (await A('/api/invoices')).data.invoices.find((i) => i.paypalId?.startsWith('INV2-MOCK-') && i.status === 'SENT' && i.source !== 'paypilot' && !JSON.stringify(i).includes('Only For A'));
  await A(`/api/mock/pay/${open.paypalId}`, {});
  assert.equal((await B('/api/config')).data.businessName, 'Ortiz Design Studio');
  const bInv = (await B('/api/invoices')).data.invoices;
  assert.equal(bInv.length, nB);
  assert.ok(!JSON.stringify(bInv).includes('Only For A'));
  assert.equal(bInv.find((i) => i.paypalId === open.paypalId)?.status, 'SENT', "A's payment didn't touch B");
  const bNotes = JSON.stringify((await B('/api/notifications')).data);
  assert.ok(!bNotes.includes('Only For A') && !bNotes.includes('Visitor A'));
  assert.equal((await B('/api/actions?status=pending')).data.actions.some((a) => JSON.stringify(a).includes('Only For A')), false);
});

test('a visitor can reset or connect in their own workspace; the passcode stays locked', async () => {
  assert.equal((await A('/api/demo/reset', {})).status, 200);
  assert.ok(!JSON.stringify((await A('/api/invoices')).data).includes('Only For A'));
  const bad = await A('/api/settings/paypal/connect', { clientId: 'short', clientSecret: 'short', businessName: 'x' });
  assert.equal(bad.status, 400, 'connect is open (and validates), not locked');
  assert.equal((await A('/api/settings/passcode', { passcode: 'abcd' })).status, 403);
});

test('a forged or stolen-looking cookie gets a fresh workspace, never someone else', async () => {
  const C = visitor();
  const r = await C('/api/config', null, { cookie: 'pp_space=../../etc' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', /pp_space=[a-f0-9]{32}/);
});

test("a client's unlock link finds the right workspace without the owner's cookie", async () => {
  const inv = (await B('/api/invoices')).data.invoices.find((i) => i.paypalId?.startsWith('INV2-MOCK-') && i.status === 'SENT');
  const att = await B(`/api/invoices/${inv.id}/delivery`, { url: 'https://example.com/final-files', label: 'Final files' });
  assert.equal(att.status, 200, JSON.stringify(att.data));
  const client = visitor();
  const page = await client(`/api/d/${att.data.delivery.token}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.paid, false);
  assert.equal(page.headers.get('set-cookie'), null, 'no workspace is made for the client');
});
