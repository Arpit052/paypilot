// Budget Estimator, retainer offers and business types. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-money-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.DEFAULT_CURRENCY = 'USD';
process.env.SCHEDULER_INTERVAL_MIN = '0';
process.env.APP_TIMEZONE = 'UTC';

const { start } = await import('../server.js');
const { setLlmOverride } = await import('../src/llm.js');
const { isoDate, addDays } = await import('../src/config.js');

const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const call = async (p, body) => {
  const res = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: res.status, data: await res.json() };
};
test.after(() => server.close());

// Fake model: "afford" -> check_budget, "retainer" -> suggest_retainers, then echo the tool output.
setLlmOverride(async ({ messages }) => {
  const last = messages.at(-1);
  const text = last.role === 'user' ? last.content.find((c) => c.type === 'text')?.text || '' : '';
  if (/afford/i.test(text)) return { content: [{ type: 'tool_call', id: 'b1', name: 'check_budget', input: { price: 2000, date: addDays(isoDate(), 30), item: 'laptop' } }] };
  if (/retainer/i.test(text)) return { content: [{ type: 'tool_call', id: 'r1', name: 'suggest_retainers', input: {} }] };
  if (last.role === 'tool') return { content: [{ type: 'text', text: last.content[0].output }] };
  return { content: [{ type: 'text', text: 'ok' }] };
});

const today = isoDate();
const est = (b) => call('/api/budget/estimate', { save: false, ...b });

test('setup demo', async () => {
  assert.equal((await call('/api/settings/paypal/demo', { businessName: 'Test Studio' })).status, 200);
  assert.equal((await call('/api/clients')).data.clients.length, 5);
});

test('budget: probabilities are sane, repeatable and move the right way', async () => {
  const date = addDays(today, 21);
  const a = await est({ price: 1500, date, cashNow: 400, monthlyCosts: 600, buffer: 200 });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const r = a.data;
  assert.ok(r.chance >= 0 && r.chance <= 100);
  assert.ok(r.inflow.p10 <= r.inflow.p50 && r.inflow.p50 <= r.inflow.p90, 'percentiles are ordered');
  assert.ok(r.margin >= 0 && r.margin < 3, 'Monte Carlo error is small');
  assert.ok(r.drivers.some((d) => d.kind === 'invoice' && d.number), 'lists the invoices that decide it');
  assert.ok(r.timeline.length > 30);
  assert.ok(['yes', 'maybe', 'no'].includes(r.verdict.level));
  if (r.safeDates.p80) assert.ok(r.safeDates.p80 >= date, 'safe date is never before the date asked about');

  const again = await est({ price: 1500, date, cashNow: 400, monthlyCosts: 600, buffer: 200 });
  assert.equal(again.data.chance, r.chance, 'same inputs give the same answer');

  const richer = await est({ price: 1500, date, cashNow: 1400, monthlyCosts: 600, buffer: 200 });
  assert.ok(richer.data.chance >= r.chance, 'more cash never lowers the chance');
  const pricier = await est({ price: 4000, date, cashNow: 400, monthlyCosts: 600, buffer: 200 });
  assert.ok(pricier.data.chance <= r.chance, 'a higher price never raises the chance');
  assert.ok(pricier.data.shortfall.likely > 0);

  const covered = await est({ price: 100, date, cashNow: 10000 });
  assert.equal(covered.data.verdict.level, 'yes');
  assert.ok(covered.data.needed <= 0);
});

test('budget: overdue invoice is never predicted to have been paid in the past', async () => {
  const r = (await est({ price: 1000, date: addDays(today, 10) })).data;
  for (const d of r.drivers.filter((x) => x.kind === 'invoice' && x.likelyDate)) assert.ok(d.earlyDate >= today, `${d.number} early date ${d.earlyDate}`);
  const ryan = r.drivers.find((d) => d.client === 'Ryan Castillo');
  const priya = r.drivers.find((d) => d.client === 'Priya Raman' && d.kind === 'invoice');
  assert.equal(ryan.risk, 'high');
  assert.ok(ryan.chancePaidEver <= priya.chancePaidEver);
});

test('budget: bad input is refused clearly', async () => {
  assert.equal((await est({ price: 0, date: addDays(today, 5) })).status, 400);
  assert.equal((await est({ price: 100, date: addDays(today, -1) })).status, 400);
  assert.equal((await est({ price: 100, date: addDays(today, 500) })).status, 400);
  assert.equal((await est({ price: 100, date: 'next week' })).status, 400);
});

test('budget: money inputs are remembered', async () => {
  await call('/api/budget/estimate', { price: 500, date: addDays(today, 7), cashNow: 321, monthlyCosts: 99, buffer: 50 });
  const p = (await call('/api/budget/profile')).data.profile;
  assert.deepEqual([p.cashNow, p.monthlyCosts, p.buffer], [321, 99, 50]);
});

test('retainer offers: frequent buyer suggested, late payer and retainer clients not', async () => {
  const { offers } = (await call('/api/offers')).data;
  const names = offers.map((o) => o.client);
  assert.ok(names.includes('Danielle Okafor'), names.join(','));
  assert.ok(!names.includes('Ryan Castillo'), 'high-risk client is not offered a retainer');
  assert.ok(!names.includes('Priya Raman'), 'already on a retainer');
  const d = offers.find((o) => o.client === 'Danielle Okafor');
  assert.ok(d.pattern.coverage >= 0.75 && d.pattern.cadenceDays <= 40);
  assert.ok(d.offer.price < d.pattern.perActiveMonth, 'cheaper than a typical month');
  assert.ok(d.offer.discount > 0);
  assert.equal(d.offer.yearPlan, Math.round(d.offer.price * 12 * 100) / 100);
  assert.ok(d.offer.payment.retainerClients !== null, 'compares with your own retainer clients');
});

test('retainer offers: draft (template without AI), send, accept', async () => {
  const { offers } = (await call('/api/offers')).data;
  const d = offers.find((o) => o.client === 'Danielle Okafor');
  setLlmOverride(null);
  const dr = await call(`/api/offers/${d.clientId}/draft`, {});
  assert.equal(dr.status, 200, JSON.stringify(dr.data));
  assert.ok(dr.data.draft.message.includes(String(d.offer.price)));
  assert.ok(!dr.data.draft.message.includes('\\n'));
  assert.equal((await call(`/api/offers/${d.clientId}/offered`, {})).status, 200);
  assert.equal((await call('/api/offers')).data.offers.find((o) => o.clientId === d.clientId).status, 'offered');
  const acc = await call(`/api/offers/${d.clientId}/accept`, { price: 480, startDate: addDays(today, 10) });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  const { schedules } = (await call('/api/schedules')).data;
  const s = schedules.find((x) => x.client === 'Danielle Okafor');
  assert.ok(s && s.total === 480);
  assert.ok(!(await call('/api/offers')).data.offers.some((o) => o.clientId === d.clientId), 'gone once accepted');
  const r = (await est({ price: 500, date: addDays(today, 60) })).data;
  assert.ok(r.drivers.some((x) => x.kind === 'retainer' && x.client === 'Danielle Okafor'), 'new retainer counts in the budget');
});

test('assistant answers "can I afford it?" and "who should get a retainer?"', async () => {
  setLlmOverride(async ({ messages }) => {
    const last = messages.at(-1);
    const text = last.role === 'user' ? last.content.find((c) => c.type === 'text')?.text || '' : '';
    if (/afford/i.test(text)) return { content: [{ type: 'tool_call', id: 'b1', name: 'check_budget', input: { price: 2000, date: addDays(isoDate(), 30), item: 'laptop' } }] };
    if (/retainer/i.test(text)) return { content: [{ type: 'tool_call', id: 'r1', name: 'suggest_retainers', input: {} }] };
    if (last.role === 'tool') return { content: [{ type: 'text', text: last.content[0].output }] };
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const a = await call('/api/chat', { sessionId: 'm1', message: 'Can I afford a $2,000 laptop next month?' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual(a.data.tools, ['check_budget']);
  const out = JSON.parse(a.data.reply);
  assert.ok(typeof out.chance === 'number' && out.verdict.headline);
  assert.ok(!out.timeline, 'chart data not sent to the model');
  const b = await call('/api/chat', { sessionId: 'm2', message: 'Who should I offer a retainer?' });
  assert.deepEqual(b.data.tools, ['suggest_retainers']);
  assert.ok(Array.isArray(JSON.parse(b.data.reply).offers));
});

test('business types: presets and a sample business for each', async () => {
  const { types } = (await call('/api/business-types')).data;
  assert.deepEqual(types.map((t) => t.key), ['freelancer', 'agency', 'clinic', 'tutor', 'trades', 'consulting']);
  assert.equal((await call('/api/settings/business', { businessType: 'plumber' })).status, 400);
  for (const [type, someone] of [['clinic', 'Westfield Rugby Club'], ['tutor', 'Greenfield Academy'], ['trades', 'Cedar Point Property Management'], ['consulting', 'Ledgerly Inc.']]) {
    assert.equal((await call('/api/settings/business', { businessType: type, applyPreset: true })).status, 200);
    await call('/api/demo/reset', {});
    await call('/api/demo/seed', {});
    const s = (await call('/api/settings')).data.business;
    const t = types.find((x) => x.key === type);
    assert.equal(s.defaultTermsDays, t.terms);
    assert.equal(s.reminderStyle, t.style);
    const { clients } = (await call('/api/clients')).data;
    assert.ok(clients.some((c) => c.company === someone), `${type}: ${clients.map((c) => c.company).join(',')}`);
    const { invoices } = (await call('/api/invoices')).data;
    assert.ok(invoices.some((i) => i.status === 'SENT' && i.dueDate < today), `${type} has an overdue invoice`);
    assert.ok(invoices.filter((i) => i.status === 'PAID').length >= 15, `${type} has enough history`);
    const nums = invoices.map((i) => Number(i.number));
    assert.equal(new Set(nums).size, nums.length, 'invoice numbers are unique');
    const { offers } = (await call('/api/offers')).data;
    assert.ok(offers.length >= 1 && offers[0].offer.yearChange > 0, `${type} has a retainer suggestion that pays off`);
    const cfg = (await call('/api/config')).data;
    assert.equal(cfg.typeItems.length, t.items.length);
    assert.equal((await est({ price: 1000, date: addDays(today, 30) })).status, 200);
  }
});
