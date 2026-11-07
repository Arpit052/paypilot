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
  const a = await est({ price: 1500, date, cashNow: 400, everyday: 600, buffer: 200 });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const r = a.data;
  assert.ok(r.chance >= 0 && r.chance <= 100);
  assert.ok(r.lowest.p10 <= r.lowest.p50 && r.lowest.p50 <= r.lowest.p90, 'percentiles are ordered');
  assert.ok(r.maxSafe.p95 <= r.maxSafe.p80, 'being surer means spending less');
  assert.ok(r.margin >= 0 && r.margin < 3, 'Monte Carlo error is small');
  assert.ok(r.drivers.some((d) => d.kind === 'invoice' && d.number), 'lists the invoices that decide it');
  assert.ok(r.timeline.length > 30);
  assert.ok(['yes', 'maybe', 'no'].includes(r.verdict.level));
  if (r.safeDates.p80) assert.ok(r.safeDates.p80 >= date, 'safe date is never before the date asked about');

  const again = await est({ price: 1500, date, cashNow: 400, everyday: 600, buffer: 200 });
  assert.equal(again.data.chance, r.chance, 'same inputs give the same answer');

  const richer = await est({ price: 1500, date, cashNow: 1400, everyday: 600, buffer: 200 });
  assert.ok(richer.data.chance >= r.chance, 'more cash never lowers the chance');
  const pricier = await est({ price: 4000, date, cashNow: 400, everyday: 600, buffer: 200 });
  assert.ok(pricier.data.chance <= r.chance, 'a higher price never raises the chance');
  assert.ok(pricier.data.shortfall.likely > 0);

  const covered = await est({ price: 100, date, cashNow: 10000 });
  assert.equal(covered.data.verdict.level, 'yes');
  assert.ok(covered.data.lowest.p10 >= 0);

  // real-world money out: tax, fees, a bill and instalments only ever lower the chance
  const base = (await est({ price: 1500, date, cashNow: 800, buffer: 200, fees: false, taxPct: 0 })).data;
  const taxed = (await est({ price: 1500, date, cashNow: 800, buffer: 200, fees: true, taxPct: 25 })).data;
  assert.ok(taxed.chance <= base.chance && taxed.owedNet < base.owedNet, 'tax and fees reduce what reaches you');
  assert.ok(Math.abs(taxed.owedNet - Math.round(base.owedTotal * 0.75 * (1 - 0.0349) * 100) / 100) < 5, 'fee 3.49% + $0.49, then 25% tax');
  const billDay = Number(addDays(date, 3).slice(8));
  const withBill = (await est({ price: 1500, date, cashNow: 800, buffer: 200, fees: false, bills: [{ name: 'Rent', amount: 1200, day: billDay }] })).data;
  assert.ok(withBill.chance <= base.chance, 'a bill right after buying lowers the chance');
  assert.ok(withBill.billsInWindow.some((b) => b.name === 'Rent'));
  const split = (await est({ price: 1500, date, cashNow: 800, buffer: 200, fees: false, instalments: 3 })).data;
  assert.equal(split.instalment, 500);
  assert.ok(split.chance >= base.chance, 'paying in parts is easier than paying at once');
  const marcus = base.drivers.find((d) => d.client === 'Marcus Vance');
  const without = (await est({ price: 1500, date, cashNow: 800, buffer: 200, fees: false, exclude: [marcus.number] })).data;
  assert.ok(without.chance <= base.chance && without.excluded[0].number === marcus.number, 'what-if: Marcus never pays');
});

test('budget: overdue invoice is never predicted to have been paid in the past', async () => {
  const r = (await est({ price: 1000, date: addDays(today, 10) })).data;
  for (const d of r.drivers.filter((x) => x.kind === 'invoice' && x.likelyDate)) assert.ok(d.earlyDate >= today, `${d.number} early date ${d.earlyDate}`);
  const ryan = r.drivers.find((d) => d.client === 'Marcus Vance');
  const priya = r.drivers.find((d) => d.client === 'Kiran Deshmukh' && d.kind === 'invoice');
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
  await call('/api/budget/estimate', { price: 500, date: addDays(today, 7), cashNow: 321, everyday: 99, buffer: 50, taxPct: 20, bills: [{ name: 'Rent', amount: 900, day: 1 }] });
  const p = (await call('/api/budget/profile')).data.profile;
  assert.deepEqual([p.cashNow, p.everyday, p.buffer, p.taxPct, p.bills[0].name], [321, 99, 50, 20, 'Rent']);
});

test('retainer offers: frequent buyer suggested, late payer and retainer clients not', async () => {
  const { offers } = (await call('/api/offers')).data;
  const names = offers.map((o) => o.client);
  assert.ok(names.includes('Rachel Adams'), names.join(','));
  assert.ok(!names.includes('Marcus Vance'), 'high-risk client is not offered a retainer');
  assert.ok(!names.includes('Kiran Deshmukh'), 'already on a retainer');
  const d = offers.find((o) => o.client === 'Rachel Adams');
  assert.ok(d.pattern.coverage >= 0.75 && d.pattern.cadenceDays <= 40);
  assert.ok(d.offer.price < d.pattern.perActiveMonth, 'cheaper than a typical month');
  assert.ok(d.offer.discount > 0);
  assert.equal(d.offer.yearPlan, Math.round(d.offer.price * 12 * 100) / 100);
  assert.ok(d.offer.payment.retainerClients !== null, 'compares with your own retainer clients');
});

test('retainer offers: draft (template without AI), send, accept', async () => {
  const { offers } = (await call('/api/offers')).data;
  const d = offers.find((o) => o.client === 'Rachel Adams');
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
  const s = schedules.find((x) => x.client === 'Rachel Adams');
  assert.ok(s && s.total === 480);
  assert.ok(!(await call('/api/offers')).data.offers.some((o) => o.clientId === d.clientId), 'gone once accepted');
  const r = (await est({ price: 500, date: addDays(today, 60) })).data;
  assert.ok(r.drivers.some((x) => x.kind === 'retainer' && x.client === 'Rachel Adams'), 'new retainer counts in the budget');
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
  assert.ok(!out.timeline && !out.balance, 'chart data not sent to the model');
  assert.ok(out.maxSafe && out.maxSafe.p80 >= 0);
  const b = await call('/api/chat', { sessionId: 'm2', message: 'Who should I offer a retainer?' });
  assert.deepEqual(b.data.tools, ['suggest_retainers']);
  assert.ok(Array.isArray(JSON.parse(b.data.reply).offers));
});

test('business types: presets and a sample business for each', async () => {
  assert.equal((await call('/api/settings/business', { businessType: 'other', businessTypeOther: 'Interior designer' })).status, 200);
  assert.equal((await call('/api/config')).data.businessTypeLabel, 'Interior designer');
  const { types } = (await call('/api/business-types')).data;
  assert.deepEqual(types.map((t) => t.key), ['web_developer', 'graphic_designer', 'content_writer', 'digital_marketer', 'video_editor', 'consultant', 'photographer', 'virtual_assistant', 'other']);
  assert.equal((await call('/api/settings/business', { businessType: 'plumber' })).status, 400);
  for (const type of ['web_developer', 'content_writer', 'digital_marketer', 'video_editor', 'consultant', 'photographer', 'virtual_assistant', 'other']) {
    const someone = 'Overcast Labs';
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
    assert.equal(offers[0].client, 'Rachel Adams');
    assert.ok(clients.find((c) => c.name === 'Marcus Vance').riskLabel === 'high', `${type}: Marcus is the late payer`);
    assert.ok(clients.find((c) => c.name === 'Kiran Deshmukh').role === 'Principal Engineer');
    const cfg = (await call('/api/config')).data;
    assert.equal(cfg.typeItems.length, t.items.length);
    assert.equal((await est({ price: 1000, date: addDays(today, 30) })).status, 200);
  }
});
