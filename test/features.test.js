// Payment dates, forecast working, reminder voice, budget story, tax summary,
// pay to unlock and early-pay discounts. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-features-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.DEFAULT_CURRENCY = 'USD';
process.env.SCHEDULER_INTERVAL_MIN = '0';
process.env.APP_TIMEZONE = 'UTC';

const { start } = await import('../server.js');
const { setLlmOverride } = await import('../src/llm.js');
const { isoDate, addDays } = await import('../src/config.js');
const { settleEarlyPay } = await import('../src/earlypay.js');

const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const call = async (p, body, method) => {
  const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
};
test.after(() => server.close());
setLlmOverride(null);
const today = isoDate();

test('setup demo', async () => {
  assert.equal((await call('/api/settings/paypal/demo', { businessName: 'Test Studio' })).status, 200);
});

test('invoices show when money came in, or when it is likely to', async () => {
  const { invoices } = (await call('/api/invoices')).data;
  const paid = invoices.find((i) => i.status === 'PAID');
  assert.equal(typeof paid.paidLateDays, 'number');
  const open = invoices.filter((i) => ['SENT', 'PARTIALLY_PAID'].includes(i.status));
  assert.ok(open.length >= 3);
  for (const i of open) {
    assert.ok(i.expected.date >= today, `#${i.number} expected ${i.expected.date}`);
    assert.ok(i.expected.early <= i.expected.date && i.expected.date <= i.expected.late);
    assert.ok(i.expected.chance > 0 && i.expected.chance <= 100);
    assert.equal(i.expected.within, undefined, 'internal function not sent');
  }
  const marcus = open.find((i) => i.client === 'Marcus Vance');
  const kiran = open.find((i) => i.client === 'Kiran Deshmukh');
  assert.ok(marcus.expected.chance <= kiran.expected.chance, 'late payer is less certain');
});

test('"Expected in 30 days" is the sum of amount × chance, with the working', async () => {
  const { forecast } = (await call('/api/dashboard')).data;
  const sum = Math.round(forecast.invoices.reduce((t, r) => t + r.expectedValue, 0) * 100) / 100;
  assert.equal(forecast.expected.USD, sum);
  for (const r of forecast.invoices) {
    assert.ok(r.probability > 0 && r.probability <= 1);
    assert.ok(Math.abs(r.expectedValue - Math.round(r.amount * r.probability * 100) / 100) < 0.011);
  }
  assert.ok(forecast.method);
});

test('reminder voice follows the client: formal for a late payer, warm for a good client', async () => {
  const { invoices } = (await call('/api/invoices')).data;
  const late = invoices.find((i) => i.client === 'Marcus Vance' && i.status === 'SENT');
  const a = (await call('/api/followups/draft', { invoiceId: late.id })).data.action;
  assert.equal(a.payload.voice, 'late');
  assert.match(a.payload.message, /days overdue/);
  assert.match(a.payload.message, /Net 15/);
  assert.match(a.payload.message, /late fee/i, 'mentions the late fee');
  assert.doesNotMatch(a.payload.message, /Hope all is well/);
  const good = invoices.find((i) => i.client === 'Kiran Deshmukh' && i.status === 'SENT');
  const b = (await call('/api/followups/draft', { invoiceId: good.id })).data.action;
  assert.equal(b.payload.voice, 'trusted');
  assert.match(b.payload.message, /Hope all is well/);
  assert.doesNotMatch(b.payload.message, /late fee/i);
  for (const x of [a, b]) await call(`/api/actions/${x.id}/reject`, {});
});

test('budget verdict: safe/risky pills and a day-by-day typical path', async () => {
  const r = (await call('/api/budget/estimate', { price: 1800, date: addDays(today, 14), cashNow: 1500, buffer: 400, everyday: 500, bills: [{ name: 'Rent', amount: 1100, day: Number(addDays(today, 24).slice(8)) }], taxPct: 25, save: false })).data;
  assert.ok(Array.isArray(r.verdict.pill) && r.verdict.pill.length >= 1);
  assert.ok(r.verdict.pill.every((p) => ['safe', 'risky'].includes(p.tone)));
  assert.ok(r.path.rows.length >= 3);
  const dates = r.path.rows.map((x) => x.date);
  assert.deepEqual(dates, [...dates].sort(), 'events in date order');
  assert.ok(r.path.rows.some((x) => x.kind === 'buy') && r.path.rows.some((x) => x.kind === 'bill' && x.label === 'Rent'));
  const low = r.path.lowest;
  assert.ok(low && low.date >= r.date);
  if (low.balance < 400) {
    assert.ok(r.verdict.pill.some((p) => p.tone === 'risky'));
    assert.match(r.verdict.story, /projected balance/);
  }
  const up = (await call('/api/budget/profile')).data.upcoming;
  assert.ok(up.length >= 1 && up.every((u) => u.probability > 0));
});

test('tax summary: totals, PayPal fees, quarters, CSV and 1099 hints', async () => {
  const r = (await call(`/api/tax?year=${today.slice(0, 4)}`)).data;
  const sum = (f) => Math.round(r.rows.reduce((t, x) => t + f(x), 0) * 100) / 100;
  assert.equal(r.totals.gross, sum((x) => x.gross));
  assert.equal(r.totals.fees, sum((x) => x.fee));
  const x = r.rows.find((y) => y.via === 'PayPal');
  assert.equal(x.fee, Math.round((x.gross * 0.0349 + 0.49) * 100) / 100, '3.49% + $0.49');
  assert.equal(Math.round(r.periods.reduce((t, p) => t + p.income, 0) * 100) / 100, r.totals.income);
  assert.equal(r.forms.necThreshold, Number(today.slice(0, 4)) >= 2026 ? 2000 : 600);
  assert.ok(r.estimates.selfEmploymentTax > 0);
  const csv = await call(`/api/tax.csv?year=${today.slice(0, 4)}`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.equal(csv.data.trim().split('\n').length, r.rows.length + 2);
  // paid by bank transfer: outside PayPal, no fee, can trigger a 1099-NEC
  const big = await call('/api/invoices', { clientName: 'Nora Big', clientEmail: 'nora@bigco.example.com', items: [{ name: 'Rebrand', quantity: 1, unitPrice: 2500 }], sendNow: true });
  await call(`/api/invoices/${big.data.action.result.invoiceId}/mark-paid`, { method: 'bank' });
  const r2 = (await call(`/api/tax?year=${today.slice(0, 4)}`)).data;
  const nora = r2.rows.find((y) => y.client === 'Nora Big');
  assert.equal(nora.outside, true);
  assert.equal(nora.fee, 0);
  assert.equal(nora.via, 'bank');
  if (r2.forms.necThreshold <= 2500) assert.ok(r2.forms.necClients.includes('Nora Big'));
});

test('pay to unlock: files stay hidden until PayPal says paid', async () => {
  const bad = await call('/api/invoices', { clientName: 'Leo', clientEmail: 'leo@x.example.com', items: [{ name: 'Logo', quantity: 1, unitPrice: 400 }], deliveryUrl: 'javascript:alert(1)', sendNow: true });
  assert.equal(bad.status, 400);
  const res = await call('/api/invoices', { clientName: 'Leo Park', clientEmail: 'leo@park.example.com', items: [{ name: 'Logo', quantity: 1, unitPrice: 400 }], deliveryUrl: 'https://www.figma.com/file/abc123/Final-logo', sendNow: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const r = res.data.action.result;
  assert.match(r.unlockLink, /\/d\/[A-Za-z0-9_-]{20,}$/);
  const token = r.unlockLink.split('/').pop();
  const { invoices } = (await call('/api/invoices')).data;
  const inv = invoices.find((i) => i.id === r.invoiceId);
  assert.match(inv.note, /unlock automatically/);
  assert.equal(inv.delivery.url, 'https://www.figma.com/file/abc123/Final-logo');
  const locked = (await call(`/api/d/${token}`)).data;
  assert.equal(locked.paid, false);
  assert.equal(locked.url, null, 'link hidden before payment');
  assert.ok(locked.payUrl);
  assert.equal((await call('/api/d/not-a-real-token-xyz123')).status, 404);
  const page = await call(`/d/${token}`);
  assert.equal(page.status, 200);
  assert.match(String(page.data), /Your files/);
  await call(`/api/mock/pay/${inv.paypalId}`, {});
  await call('/api/sync', {});
  const open = (await call(`/api/d/${token}`)).data;
  assert.equal(open.paid, true);
  assert.equal(open.url, 'https://www.figma.com/file/abc123/Final-logo');
  const after = (await call('/api/invoices')).data.invoices.find((i) => i.id === r.invoiceId);
  assert.ok(after.delivery.unlockedAt);
  // attach to an existing open invoice, then remove it
  const other = (await call('/api/invoices')).data.invoices.find((i) => i.status === 'SENT' && !i.delivery);
  const att = await call(`/api/invoices/${other.id}/delivery`, { url: 'https://drive.google.com/drive/folders/xyz' });
  assert.equal(att.status, 200);
  assert.equal((await call(`/api/invoices/${other.id}/delivery`, null, 'DELETE')).status, 200);
  assert.equal((await call(`/api/d/${att.data.delivery.token}`)).status, 404, 'removed links stop working');
});

test('early-pay discount: suggested by history, applied, then removed after 48 hours', async () => {
  const sgLate = (await call('/api/earlypay/suggest?email=marcus@apexgrowthlab.io&total=1000')).data;
  const sgGood = (await call('/api/earlypay/suggest?email=kiran@overcastlabs.io&total=1000')).data;
  assert.equal(sgLate.percent, 3);
  assert.equal(sgGood.percent, 0, 'no discount for clients who already pay on time');
  const both = await call('/api/invoices', { clientName: 'Ivy', clientEmail: 'ivy@x.example.com', items: [{ name: 'Site', quantity: 1, unitPrice: 1000 }], depositAmount: 200, earlyPayPercent: 2, sendNow: true });
  assert.equal(both.status, 400, 'deposit and early-pay discount are not mixed');
  const res = await call('/api/invoices', { clientName: 'Ivy Chen', clientEmail: 'ivy@chen.example.com', items: [{ name: 'Site', quantity: 1, unitPrice: 1000 }], earlyPayPercent: 2, sendNow: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const id = res.data.action.result.invoiceId;
  let inv = (await call('/api/invoices')).data.invoices.find((i) => i.id === id);
  assert.equal(inv.total, 980);
  assert.equal(inv.earlyPay.status, 'active');
  assert.equal(inv.earlyPay.fullTotal, 1000);
  assert.match(inv.note, /Early-pay offer/);
  // window not over yet: nothing changes
  await settleEarlyPay(new Date());
  assert.equal((await call('/api/invoices')).data.invoices.find((i) => i.id === id).total, 980);
  // 49 hours later and still unpaid: discount removed
  await settleEarlyPay(new Date(Date.now() + 49 * 3600e3));
  inv = (await call('/api/invoices')).data.invoices.find((i) => i.id === id);
  assert.equal(inv.total, 1000);
  assert.equal(inv.earlyPay.status, 'expired');
  // paid in time: marked as used
  const res2 = await call('/api/invoices', { clientName: 'Ivy Chen', clientEmail: 'ivy@chen.example.com', items: [{ name: 'Logo', quantity: 1, unitPrice: 500 }], earlyPayPercent: 3, sendNow: true });
  const inv2 = (await call('/api/invoices')).data.invoices.find((i) => i.id === res2.data.action.result.invoiceId);
  await call(`/api/mock/pay/${inv2.paypalId}`, {});
  await call('/api/sync', {});
  await settleEarlyPay(new Date());
  assert.equal((await call('/api/invoices')).data.invoices.find((i) => i.id === inv2.id).earlyPay.status, 'used');
});

test('no emojis left in the interface text', async () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
  for (const f of fs.readdirSync(dir).filter((x) => /\.(js|html)$/.test(x))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]/u, f);
  }
});
