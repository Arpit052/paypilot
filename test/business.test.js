// Landing page and routing, receipts, the client's view of an invoice, growth insights,
// client industries and request ids. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-business-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.DEFAULT_CURRENCY = 'USD';
process.env.SCHEDULER_INTERVAL_MIN = '0';
process.env.APP_TIMEZONE = 'UTC';

const { start } = await import('../server.js');
const { setLlmOverride } = await import('../src/llm.js');
const { areaOf, growthReport } = await import('../src/growth.js');

const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const call = async (p, body, method) => {
  const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
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

test('landing page is public and /app sends you to the right place', async () => {
  const home = await call('/');
  assert.equal(home.status, 200);
  assert.match(home.data, /Do the work\./);
  assert.match(home.data, /href="\/app"/);
  assert.equal((await call('/landing.css')).status, 200);
  // PAYPAL_MODE in the environment counts as set up, so /app goes to the dashboard
  const app = await call('/app');
  assert.equal(app.status, 302);
  assert.equal(app.headers.get('location'), '/dashboard');
  assert.equal((await call('/dashboard')).status, 200);
});

test('every response carries a request id', async () => {
  const r = await call('/api/health');
  assert.match(r.headers.get('x-request-id') || '', /^[0-9a-f]{12}$/);
  const echoed = await fetch(`${base}/api/health`, { headers: { 'x-request-id': 'trace-123' } });
  assert.equal(echoed.headers.get('x-request-id'), 'trace-123');
  const missing = await call('/api/invoices/nope/client-view');
  assert.equal(missing.status, 404);
  assert.ok(missing.data.requestId, 'errors name the request id');
});

test('setup demo', async () => {
  assert.equal((await call('/api/settings/paypal/demo', { businessName: 'Test Studio' })).status, 200);
});

test('receipts: bank payments need one, PayPal payments do not, sending is tracked', async () => {
  const { receipts, summary } = (await call('/api/receipts')).data;
  assert.ok(receipts.length > 5);
  assert.equal(summary.total, receipts.length);
  for (const r of receipts) assert.match(r.receipt, /^R-\d+$/);
  const bank = receipts.filter((r) => r.via === 'bank');
  assert.ok(bank.length >= 2, 'the demo has a client who pays by bank transfer');
  assert.ok(receipts.filter((r) => r.via === 'paypal').every((r) => r.status === 'auto'), 'PayPal sends its own receipt');
  const needed = receipts.find((r) => r.status === 'needed');
  assert.ok(needed, 'the newest bank payment still needs a receipt');

  const sent = await call(`/api/receipts/${needed.invoiceId}/sent`, { via: 'email' });
  assert.equal(sent.status, 200);
  const after = (await call('/api/receipts')).data;
  assert.equal(after.receipts.find((r) => r.invoiceId === needed.invoiceId).status, 'sent');
  assert.equal(after.summary.needed, summary.needed - 1);
});

test('receipts: the public link works, the owner preview is not counted as a view', async () => {
  const { receipts } = (await call('/api/receipts')).data;
  const r = receipts.find((x) => x.status === 'sent');
  const token = r.link.split('/r/')[1].split('?')[0];
  const preview = await call(`/api/r/${token}?preview=1`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.paid, true);
  assert.equal(preview.data.receipt, r.receipt);
  assert.equal((await call('/api/receipts')).data.receipts.find((x) => x.invoiceId === r.invoiceId).status, 'sent', 'preview does not mark it viewed');
  assert.equal((await call(`/api/r/${token}`)).status, 200);
  assert.equal((await call('/api/receipts')).data.receipts.find((x) => x.invoiceId === r.invoiceId).status, 'viewed');
  assert.equal((await call('/api/r/not-a-real-token-123456')).status, 404);
  assert.equal((await call(`/r/${token}`)).status, 200, 'receipt page is public');
});

test("client view: the email, payment page and receipt preview for an unpaid invoice", async () => {
  const { invoices } = (await call('/api/invoices')).data;
  const open = invoices.find((i) => i.status === 'SENT' && i.client === 'Marcus Vance');
  const v = (await call(`/api/invoices/${open.id}/client-view`)).data;
  assert.equal(v.email.to, 'marcus@apexgrowthlab.io');
  assert.match(v.email.subject, new RegExp(`#${open.number}`));
  assert.equal(v.document.paid, false);
  assert.equal(v.document.invoice, open.number);
  assert.ok(v.payerUrl);
  assert.equal(v.receiptLink, null, 'no receipt link before payment');
});

test('growth: work areas follow the profession', () => {
  assert.equal(areaOf('Stripe checkout integration', 'web_developer'), 'Integrations and APIs');
  assert.equal(areaOf('Clinic waiting-room posters', 'graphic_designer'), 'Print and packaging');
  assert.equal(areaOf('Brand voice guide', 'content_writer'), 'Brand and messaging');
  assert.equal(areaOf('Pricing study', 'consultant'), 'Pricing');
  assert.equal(areaOf('Monthly retainer', 'other'), 'Retainers and ongoing work');
  assert.equal(areaOf('Something unusual', 'photographer'), 'Other work');
});

test('growth: segments, industries, concentration and honest opportunities', async () => {
  const g = (await call('/api/growth')).data;
  const seg = Object.fromEntries(g.clients.map((c) => [c.name, c.segment]));
  assert.equal(seg['Kiran Deshmukh'], 'champion');
  assert.equal(seg['Marcus Vance'], 'fix', 'valuable but pays late');
  assert.equal(seg['Sofia Martinez'], 'slipping', 'quiet well past her usual cadence');

  const focus = g.industries.find((x) => x.verdict === 'focus');
  assert.equal(focus.name, 'Software & SaaS');
  assert.equal(g.industries.reduce((t, x) => t + x.share, 0) >= 98, true);
  for (const x of g.industries) assert.ok(x.score >= 0 && x.score <= 100);

  assert.ok(g.areas.length >= 4);
  const ret = g.areas.find((a) => a.recurring);
  assert.equal(ret.trend.label, 'recurring', 'a retainer does not trend with demand');

  assert.ok(g.concentration.hhi > 0 && g.concentration.hhi <= 10000);
  assert.ok(['spread', 'moderate', 'concentrated'].includes(g.concentration.label));
  assert.ok(g.dso.now > 0);

  assert.ok(g.opportunities.length >= 3);
  for (const o of g.opportunities) {
    assert.ok(o.basis, 'every opportunity says what it is based on');
    if (o.amount !== null) assert.ok(o.amount > 0 && o.amountLabel);
  }
  assert.ok(g.opportunities.some((o) => o.kind === 'winback' && /Sofia/.test(o.title)));
  assert.ok(g.opportunities.some((o) => o.kind === 'retainer'));
  // nothing here is a recommendation to put a retainer client on another retainer
  assert.ok(!g.opportunities.some((o) => o.kind === 'retainer' && /Kiran/.test(o.title)));
});

test('growth: plan falls back to the numbers without AI, and uses AI when there is one', async () => {
  const basic = (await call('/api/growth/plan', { refresh: true })).data;
  assert.equal(basic.source, 'rules');
  assert.ok(basic.headline && basic.steps.length >= 3);

  setLlmOverride(async () => ({ content: [{ type: 'text', text: 'HEADLINE: Grow in Software & SaaS.\n- Offer Rachel a retainer.\n- Call Sofia.\n- Deposit for Marcus.' }] }));
  try {
    const ai = (await call('/api/growth/plan', { refresh: true })).data;
    assert.equal(ai.source, 'ai');
    assert.equal(ai.headline, 'Grow in Software & SaaS.');
    assert.equal(ai.steps.length, 3);
  } finally {
    setLlmOverride(null);
  }
});

test('client industry can be changed and feeds the sector view', async () => {
  const g = growthReport();
  const daniel = g.clients.find((c) => c.name === 'Daniel Brooks');
  const r = await call(`/api/clients/${daniel.id}/industry`, { industry: 'Hospitality & food' });
  assert.equal(r.status, 200);
  assert.equal(r.data.client.industry, 'Hospitality & food');
  const after = (await call('/api/growth')).data;
  assert.ok(after.industries.some((x) => x.name === 'Hospitality & food' && x.clientNames.includes('Daniel Brooks')));
  assert.equal((await call('/api/clients/nope/industry', { industry: 'x' })).status, 404);
});

test('assistant can read growth insights', async () => {
  let toolResult = null;
  setLlmOverride(async ({ messages }) => {
    const last = messages.at(-1);
    if (last.role === 'user') return { content: [{ type: 'tool_call', id: 'g', name: 'get_growth_insights', input: {} }] };
    toolResult = JSON.parse(last.content[0].output);
    return { content: [{ type: 'text', text: 'Focus on Software & SaaS.' }] };
  });
  try {
    const r = await call('/api/chat', { message: 'Where should I focus to grow?' });
    assert.equal(r.status, 200);
    assert.ok(toolResult.industries.length && toolResult.workAreas.length);
    assert.equal(toolResult.page, '/growth');
  } finally {
    setLlmOverride(null);
  }
});
