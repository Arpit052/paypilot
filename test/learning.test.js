// What PayPilot learns from real data, and the fixes around it: account type, a clean start
// with removable samples, the Invoices page, reminders (pay link, no repeat right after one
// was sent), the budget when cash already covers a purchase, industry labelling, the growth
// plan following the data, and clients who pay up front. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-learning-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.DEFAULT_CURRENCY = 'USD';
process.env.SCHEDULER_INTERVAL_MIN = '0';
process.env.APP_TIMEZONE = 'UTC';

const { start } = await import('../server.js');
const { setLlmOverride } = await import('../src/llm.js');
const { guessIndustry } = await import('../src/labels.js');
const { planFor } = await import('../src/autopilot.js');
const { findInvoice } = await import('../src/db.js');
const { isoDate, addDays } = await import('../src/config.js');

const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const call = async (p, body) => {
  const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const t = await res.text();
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    data = t;
  }
  return { status: res.status, data };
};
test.after(() => server.close());
setLlmOverride(null);

const bill = async (name, email, amount, extra = {}) => {
  const r = await call('/api/invoices', { clientName: name, clientEmail: email, items: [{ name: extra.item || 'Project work', quantity: 1, unitPrice: amount }], dueInDays: 15, sendNow: true, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.action.result;
};

test('guessIndustry reads company names and run-together domains', () => {
  assert.equal(guessIndustry({ company: 'Lumen Health' }), 'Healthcare');
  assert.equal(guessIndustry({ email: 'radhe@kumarexports.in' }), 'Wholesale & trade');
  assert.equal(guessIndustry({ email: 'p@brightsmiledental.com' }), 'Healthcare');
  assert.equal(guessIndustry({ company: 'Overcast Labs', email: 'k@overcastlabs.io' }), 'Software & SaaS');
  assert.equal(guessIndustry({ email: 'someone@gmail.com' }), 'Private clients');
  assert.equal(guessIndustry({ email: 'x@zqv.in' }), null, 'unknown stays unknown for the AI');
});

test('a business account is saved, starts on Net 30 and shows the business layout', async () => {
  const r = await call('/api/settings/business', { accountType: 'business', teamSize: '11-50', applyPreset: true });
  assert.equal(r.status, 200);
  const s = (await call('/api/settings')).data.business;
  assert.equal(s.accountType, 'business');
  assert.equal(s.teamSize, '11-50');
  assert.equal(s.defaultTermsDays, 30);
  assert.equal((await call('/api/config')).data.accountType, 'business');
  assert.equal((await call('/api/settings/business', { accountType: 'agency' })).status, 400);
});

test('demo setup loads samples that can be removed without touching your own invoices', async () => {
  await call('/api/settings/paypal/demo', { businessName: 'Test Co', businessType: 'graphic_designer', accountType: 'business' });
  const before = (await call('/api/sample')).data;
  assert.ok(before.count > 10 && before.tracked);
  const mine = await bill('Asha Rao', 'asha@sunrisehealthcare.com', 900);
  const r = (await call('/api/sample/remove', {})).data;
  assert.equal(r.invoices, before.count);
  const left = (await call('/api/invoices')).data.invoices;
  assert.deepEqual(left.map((i) => i.number), [mine.number], 'only my invoice is left');
  assert.equal((await call('/api/sample')).data.count, 0);
  assert.equal((await call('/api/clients')).data.clients.length, 1, 'sample clients are gone, mine stays');
  // and they can come back
  await call('/api/demo/seed', {});
  assert.ok((await call('/api/sample')).data.count > 10);
});

test('the Invoices page is served, and Collections links still work', async () => {
  assert.equal((await call('/invoices')).status, 200);
  assert.match((await call('/invoices')).data, /Needs you/);
  assert.equal((await call('/collections')).status, 200);
});

test('reminders carry the pay link, and a reminder just sent pauses the next one', async () => {
  const { invoices } = (await call('/api/invoices')).data;
  const late = invoices.find((i) => i.client === 'William Evans' && i.displayStatus === 'OVERDUE');
  assert.ok(late, 'demo has an overdue invoice for William');
  const { action } = (await call('/api/followups/draft', { invoiceId: late.id, kind: 'reminder' })).data;
  assert.ok(action.payload.message.includes(late.payerUrl), 'the pay link is in the message');
  assert.match(action.payload.message, new RegExp(`Pay invoice #${late.number} here:`));
  const ok = await call(`/api/actions/${action.id}/approve`, {});
  assert.equal(ok.status, 200);
  const plan = planFor(findInvoice(late.id));
  assert.notEqual(plan.next?.state, 'due', 'nothing is due the day after a reminder');
  const col = (await call('/api/collections')).data.cards.find((c) => c.id === late.id);
  assert.equal(col.lastContact.at, isoDate());
  assert.ok(col.plan.next === null || col.plan.next.date > isoDate());
});

test('budget: when cash alone covers it, no invoice "decides" it', async () => {
  const r = (await call('/api/budget/estimate', { price: 500, date: addDays(isoDate(), 14), cashNow: 25000, buffer: 1000, everyday: 1000, bills: [], taxPct: 0, save: false })).data;
  assert.equal(r.coveredByCash, true);
  assert.equal(r.verdict.level, 'yes');
  assert.match(r.verdict.headline, /money you have already covers/);
  assert.ok(r.drivers.filter((d) => d.kind === 'invoice').every((d) => d.impact === 0));
  const tight = (await call('/api/budget/estimate', { price: 5000, date: addDays(isoDate(), 14), cashNow: 0, buffer: 0, bills: [], save: false })).data;
  assert.equal(tight.coveredByCash, false);
});

test('budget: money paid after "Have now" was saved is added to it', async () => {
  await call('/api/budget/estimate', { price: 100, date: isoDate(), cashNow: 1000, buffer: 0, everyday: 0, bills: [], taxPct: 0, fees: false });
  assert.equal((await call('/api/budget/profile')).data.receivedSince.total, 0);
  const inv = await bill('Big Buyer', 'ops@acmeexports.com', 20000);
  const pid = (await call('/api/invoices')).data.invoices.find((i) => i.number === inv.number).paypalId;
  await call(`/api/mock/pay/${pid}`, {});
  const p = (await call('/api/budget/profile')).data;
  assert.equal(p.receivedSince.total, 20000);
  assert.equal(p.receivedSince.items[0].number, inv.number);
  assert.ok(p.upcoming.every((u) => u.due && u.range && 'habit' in u), 'money on its way explains each date');
});

test('growth follows new data: a big new client is labelled and leads the plan', async () => {
  const g = (await call('/api/growth')).data;
  const big = g.clients.find((c) => c.name === 'Big Buyer');
  assert.equal(big.industry, 'Wholesale & trade');
  assert.equal(big.industrySource, 'rules');
  assert.equal(g.opportunities[0].kind, 'protect');
  assert.match(g.opportunities[0].title, /Big Buyer/);
  assert.ok(g.opportunities.some((o) => o.kind === 'diversify'));
  const plan = (await call('/api/growth/plan', {})).data;
  assert.match(plan.headline, /Big Buyer/);
  assert.ok(plan.basedOn.invoices > 10);
  // owner's own label wins and is not relabelled
  await call(`/api/clients/${big.id}/industry`, { industry: 'Manufacturing' });
  const g2 = (await call('/api/growth')).data;
  assert.equal(g2.clients.find((c) => c.id === big.id).industrySource, 'you');
});

test('growth: AI labels what the rules cannot, and the plan is rewritten when the book changes', async () => {
  await bill('Zed Q', 'zed@zqv.in', 300, { item: 'Quarterly kiosk refresh' });
  let calls = 0;
  setLlmOverride(async ({ messages, tools }) => {
    const text = messages.at(-1).content.map((c) => c.text || '').join('');
    if (/label small-business data|JSON only/.test(JSON.stringify(messages)) || /lineItems/.test(text)) {
      const ids = [...text.matchAll(/"id":"(cli_[a-z0-9]+)"/g)].map((m) => m[1]);
      return { content: [{ type: 'text', text: JSON.stringify({ clients: Object.fromEntries(ids.map((id) => [id, 'Retail kiosks'])), lineItems: { 'Quarterly kiosk refresh': 'Kiosk design' } }) }] };
    }
    calls++;
    return { content: [{ type: 'text', text: `HEADLINE: Plan number ${calls}.\n- One.\n- Two.` }] };
  });
  try {
    const g = (await call('/api/growth')).data;
    const zed = g.clients.find((c) => c.name === 'Zed Q');
    assert.equal(zed.industry, 'Retail kiosks');
    assert.equal(zed.industrySource, 'ai');
    assert.ok(g.areas.some((a) => a.name === 'Kiosk design'), 'unusual work gets its own area');
    const p1 = (await call('/api/growth/plan', {})).data;
    const p1b = (await call('/api/growth/plan', {})).data;
    assert.equal(p1b.headline, p1.headline, 'same book, same plan');
    assert.equal(p1b.cached, true);
    await bill('Zed Q', 'zed@zqv.in', 450, { item: 'Quarterly kiosk refresh' });
    const p2 = (await call('/api/growth/plan', {})).data;
    assert.notEqual(p2.headline, p1.headline, 'a new invoice means a new plan');
  } finally {
    setLlmOverride(null);
  }
});

test('clients who pay up front are recognised and never treated as slow', async () => {
  const g = (await call('/api/growth')).data;
  const daniel = g.clients.find((c) => c.name === 'Daniel Brooks');
  assert.equal(daniel.paysUpfront, true);
  assert.notEqual(daniel.segment, 'fix');
  assert.ok(g.customers.upfront.includes('Daniel Brooks'));
  assert.equal(g.aging.length, 5);
});

test('demo checkout: the pay page data includes the receipt once paid', async () => {
  const inv = (await call('/api/invoices')).data.invoices.find((i) => i.client === 'Big Buyer');
  const d = (await call(`/api/mock/invoice/${inv.paypalId}`)).data;
  assert.match(d.receipt, /^\/r\/[A-Za-z0-9_-]+$/);
  assert.equal((await call(d.receipt)).status, 200);
});

test('both account types use the same names for the same features', () => {
  const src = fs.readFileSync(new URL('../public/common.js', import.meta.url), 'utf8');
  const block = (k) => src.slice(src.indexOf(`  ${k}: [`), src.indexOf('],', src.indexOf(`  ${k}: [`)));
  const labels = (k) => Object.fromEntries([...block(k).matchAll(/key: '(\w+)'[^}]*label: '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const f = labels('freelancer'), b = labels('business');
  assert.deepEqual(Object.keys(f).sort(), Object.keys(b).sort(), 'same features');
  for (const k of Object.keys(f)) assert.equal(b[k], f[k], `${k} has the same name`);
});

test('self-employment tax stops Social Security at the wage base', async () => {
  const { selfEmploymentTax } = await import('../src/tax.js');
  assert.equal(selfEmploymentTax(50000, 2026), Math.round(50000 * 0.9235 * 0.153 * 100) / 100);
  const high = selfEmploymentTax(400000, 2026);
  assert.equal(high, Math.round((184500 * 0.124 + 400000 * 0.9235 * 0.029) * 100) / 100);
  assert.ok(high < 400000 * 0.9235 * 0.153, 'not taxed at 15.3% on everything');
  assert.equal(selfEmploymentTax(-100, 2026), 0);
});

test('calendar shows reminder dates, even with Autopilot off', async () => {
  await call('/api/autopilot', { enabled: false }).catch(() => {});
  const r = (await call('/api/calendar')).data;
  const kinds = new Set(r.events.map((e) => e.kind));
  assert.ok(kinds.has('planned') || kinds.has('reminded'), 'reminder dates are on the calendar');
  await call('/api/autopilot', { enabled: true }).catch(() => {});
});
