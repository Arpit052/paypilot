// a small hand-checked book. Every number here was worked out on paper first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-golden-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.DEFAULT_CURRENCY = 'USD';
process.env.APP_TIMEZONE = 'UTC';

const { upsertClient, insertInvoice, resetDb } = await import('../src/db.js');
const { addDays } = await import('../src/config.js');
const { growthReport } = await import('../src/growth.js');
const { invoiceTotals } = await import('../src/analytics.js');

const T = '2026-06-30';
let n = 0;
const add = (client, total, { issue, due, paid = null, status = paid ? 'PAID' : 'SENT' }) => {
  const c = upsertClient({ name: client, email: `${client.toLowerCase().replace(/\W/g, '')}@example.com` });
  insertInvoice({ paypalId: null, number: `G${++n}`, clientId: c.id, items: [{ name: 'Work', quantity: 1, unitPrice: total }], currency: 'USD', total, status, issueDate: issue, dueDate: due, paidDate: paid, note: '', reminders: [], source: 'manual' });
};

test('empty book: reports work and show nothing instead of crashing', () => {
  resetDb();
  const g = growthReport(T);
  assert.equal(g.dso.now, null, 'no billing → no DSO, not 0 and not NaN');
  assert.ok(g.aging.every((b) => b.count === 0 && b.amount === 0));
  assert.ok(!JSON.stringify(g).includes('NaN') && !JSON.stringify(g).includes('Infinity'));
});

test('concentration: two clients at $3,000 and $1,000 → HHI 6,250, top client 75%', () => {
  resetDb();
  add('Alder Co', 3000, { issue: '2026-05-01', due: '2026-05-15', paid: '2026-05-20' });
  add('Birch LLC', 1000, { issue: '2026-05-10', due: '2026-05-24', paid: '2026-05-24' });
  const g = growthReport(T);
  assert.equal(g.concentration.hhi, 75 ** 2 + 25 ** 2);
  assert.equal(g.concentration.label, 'concentrated');
  assert.equal(g.concentration.topClient.share, 75);
  assert.equal(g.concentration.top3Share, 100);
  assert.equal(g.dso.now, 0, 'everything paid → nothing outstanding');
});

test('aging buckets at their exact edges, and DSO by hand', () => {
  resetDb();
  // $100 each, due on receipt, 0/1/30/31/60/61/90/91 days past due
  for (const late of [0, 1, 30, 31, 60, 61, 90, 91]) add(`Client ${late}`, 100, { issue: addDays(T, -late), due: addDays(T, -late) });
  const g = growthReport(T);
  const b = Object.fromEntries(g.aging.map((x) => [x.key, [x.count, x.amount]]));
  assert.deepEqual(b, { current: [1, 100], d30: [2, 200], d60: [2, 200], d90: [2, 200], d90p: [1, 100] });
  // billed in the last 90 days (issued after Apr 1): 6 × $100 = $600; owed today: $800
  assert.equal(g.dso.now, Math.round((800 / 600) * 90));
});

test('tax on a line is rounded per line, like PayPal', () => {
  const t = invoiceTotals([{ quantity: 1, unitPrice: 19.99 }, { quantity: 1, unitPrice: 19.99 }], 7.25);
  assert.deepEqual(t, { subtotal: 39.98, tax: 2.9, total: 42.88 }); // 1.449… → 1.45 twice
});
