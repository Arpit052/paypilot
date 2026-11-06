// End-to-end test with mock PayPal and a scripted fake LLM. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.DEFAULT_CURRENCY = 'USD';
process.env.SCHEDULER_INTERVAL_MIN = '0';
process.env.APP_TIMEZONE = 'UTC';

const { start } = await import('../server.js');
const { setLlmOverride, toAnthropic, toOpenAI } = await import('../src/llm.js');
const { buildInvoiceBody } = await import('../src/paypal.js');

const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const call = async (p, body) => {
  const res = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: res.status, data: await res.json() };
};
test.after(() => server.close());

// Fake model: first turn asks for client insights + proposes invoice, then replies.
let calls = [];
setLlmOverride(async ({ messages, tools }) => {
  calls.push({ messages, tools });
  const last = messages.at(-1);
  const userText = last.role === 'user' ? last.content.find((c) => c.type === 'text')?.text || '' : '';
  if (/HEADLINE:/.test(userText)) {
    return { content: [{ type: 'text', text: 'HEADLINE: Ryan Castillo owes $1,240 and is 12 days late.\n- Send Ryan a firm reminder for #1001.\n- Nudge Marcus Hollis on #1002.' }] };
  }
  if (last.role === 'user' && /bill/i.test(userText)) {
    return {
      content: [
        { type: 'tool_call', id: 't1', name: 'get_client_insights', input: { client: 'Ryan Castillo' } },
        {
          type: 'tool_call',
          id: 't2',
          name: 'propose_invoice',
          input: {
            client_name: 'Ryan Castillo',
            client_email: 'ryan@castillocoffee.co',
            items: [{ name: 'Logo concept', quantity: 3, unit_price: 150 }],
            due_in_days: 10,
          },
        },
      ],
    };
  }
  if (last.role === 'user' && /tax/i.test(userText)) {
    return { content: [{ type: 'tool_call', id: 'tx', name: 'propose_invoice', input: { client_name: 'Danielle Okafor', client_email: 'dani@okaforfitness.com', items: [{ name: 'Instagram post', quantity: 10, unit_price: 25 }], tax_percent: 8, deposit_percent: 20 } }] };
  }
  if (last.role === 'user' && /every month/i.test(userText)) {
    return { content: [{ type: 'tool_call', id: 'rc', name: 'propose_recurring', input: { client_name: 'Priya Raman', client_email: 'office@brightlinedental.com', items: [{ name: 'Design retainer', quantity: 1, unit_price: 600 }], frequency: 'monthly' } }] };
  }
  if (last.role === 'user' && /owe/i.test(userText)) {
    return { content: [{ type: 'tool_call', id: 't3', name: 'list_invoices', input: { status: 'overdue' } }] };
  }
  if (last.role === 'tool') {
    const out = last.content.map((c) => JSON.parse(c.output));
    return { content: [{ type: 'text', text: `Done: ${JSON.stringify(out).slice(0, 200)}` }] };
  }
  // follow-up drafting call (no tools)
  return { content: [{ type: 'text', text: '{"subject":"Quick reminder","message":"Hi, gentle nudge on the invoice. Thanks!"}' }] };
});

test('config + empty state', async () => {
  const { data } = await call('/api/config');
  assert.equal(data.paypalMode, 'mock');
  assert.equal(data.llmProvider, 'none');
});

test('seed demo history', async () => {
  const r = await call('/api/demo/seed', {});
  assert.equal(r.status, 200);
  const { data } = await call('/api/clients');
  assert.equal(data.clients.length, 5);
  const jake = data.clients.find((c) => c.name === 'Ryan Castillo');
  assert.equal(jake.riskLabel, 'high', 'late payer should be high risk');
  const emily = data.clients.find((c) => c.name === 'Priya Raman');
  assert.equal(emily.riskLabel, 'none', 'reliable payer = no risk');
  assert.ok(data.clients.every((c) => c.avgDaysLate === null || Number.isInteger(c.avgDaysLate)), 'whole days only');
});

let actionId;
test('chat → AI proposes invoice (nothing sent yet)', async () => {
  const before = (await call('/api/invoices')).data.invoices.length;
  const { status, data } = await call('/api/chat', { sessionId: 's1', message: 'Bill Jake for 3 logos at $150, due in 10 days' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.deepEqual(data.tools, ['get_client_insights', 'propose_invoice']);
  assert.equal(data.actions.length, 1);
  const a = data.actions[0];
  assert.equal(a.type, 'create_invoice');
  assert.equal(a.status, 'pending');
  assert.equal(a.payload.total, 450);
  assert.equal(a.payload.risk.label, 'high');
  assert.equal(a.payload.depositAmount, 225, 'high-risk client gets a suggested 50% deposit');
  assert.equal(a.payload.depositSuggested, true);
  actionId = a.id;
  assert.equal((await call('/api/invoices')).data.invoices.length, before, 'no invoice before approval');
  // tool results were fed back to the model
  assert.equal(calls.at(-1).messages.at(-1).role, 'tool');
});

test('chat history persists across turns and images are stripped', async () => {
  calls = [];
  const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await call('/api/chat', { sessionId: 's2', message: 'who owes me?', image: { mediaType: 'image/png', data: tiny } });
  assert.equal(calls[0].messages.at(-1).content[0].type, 'image');
  await call('/api/chat', { sessionId: 's2', message: 'who owes me?' });
  const hist = calls.at(-2).messages; // first call of 2nd turn
  assert.ok(hist.length > 1);
  assert.ok(!hist.some((m) => m.content.some((c) => c.type === 'image')), 'old images stripped');
});

test('assistant conversation is saved for when you come back to the page', async () => {
  const h = (await call('/api/chat/history?sessionId=s2')).data;
  assert.equal(h.pending, false);
  assert.equal(h.messages.filter((m) => m.role === 'user').length, 2);
  assert.equal(h.messages[0].image, true, 'screenshot noted, not stored');
  assert.ok(!JSON.stringify(h).includes('iVBOR'), 'image data is not kept');
  assert.equal(h.messages.at(-1).role, 'bot');
  await call('/api/chat/reset', { sessionId: 's2' });
  assert.equal((await call('/api/chat/history?sessionId=s2')).data.messages.length, 0);
});

test('approve with user edits → invoice sent via PayPal (mock)', async () => {
  const { status, data } = await call(`/api/actions/${actionId}/approve`, {
    edits: { items: [{ name: 'Logo concept', quantity: 3, unitPrice: 160 }], depositAmount: 0 },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.action.status, 'approved');
  assert.ok(data.action.result.paypalId.startsWith('INV2-MOCK-'));
  const inv = (await call('/api/invoices')).data.invoices.find((i) => i.paypalId === data.action.result.paypalId);
  assert.equal(inv.total, 480);
  assert.equal(inv.status, 'SENT');
  // second approve is rejected
  assert.equal((await call(`/api/actions/${actionId}/approve`, {})).status, 409);
});

test('approve rejects invalid edits and keeps action pending', async () => {
  const { data } = await call('/api/chat', { sessionId: 's3', message: 'bill jake' });
  const id = data.actions[0].id;
  const r = await call(`/api/actions/${id}/approve`, { edits: { clientEmail: 'not-an-email' } });
  assert.equal(r.status, 400);
  const pend = (await call('/api/actions?status=pending')).data.actions.find((a) => a.id === id);
  assert.match(pend.error, /email/);
  assert.equal((await call(`/api/actions/${id}/reject`, {})).data.action.status, 'rejected');
});

test('payment pushes a live notification over SSE and is stored', async () => {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const inv = (await call('/api/invoices')).data.invoices.find((i) => i.paypalId?.startsWith('INV2-MOCK') && i.client === 'Marcus Hollis');
  await call(`/api/mock/pay/${inv.paypalId}`, {});
  let text = '';
  const until = Date.now() + 3000;
  while (!text.includes('event: notification') && Date.now() < until) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  assert.match(text, /event: notification/);
  assert.match(text, /Payment received: \$387\.50/);
  const n = (await call('/api/notifications')).data;
  assert.ok(n.unread >= 1);
  assert.equal(n.notifications[0].kind, 'payment');
  assert.equal((await call('/api/notifications/read', {})).data.unread, 0);
});

test('payment via webhook path flips status to PAID', async () => {
  const inv = (await call('/api/invoices')).data.invoices.find((i) => i.paypalId?.startsWith('INV2-MOCK') && i.client === 'Danielle Okafor');
  const r = await call(`/api/mock/pay/${inv.paypalId}`, {});
  assert.equal(r.data.changed, true);
  const after = (await call('/api/invoices')).data.invoices.find((i) => i.id === inv.id);
  assert.equal(after.status, 'PAID');
  assert.ok(after.paidDate);
});

test('follow-up scan drafts reminders for overdue invoices only, then sends', async () => {
  const { data } = await call('/api/followups/scan', {});
  const reminders = data.created.filter((a) => a.type === 'send_reminder');
  assert.deepEqual(reminders.map((a) => a.payload.client).sort(), ['Ryan Castillo']);
  const jake = reminders.find((a) => a.payload.client === 'Ryan Castillo');
  // Ryan is 12 days late (> 7-day policy), so a late-fee slip is drafted too
  const fees = data.created.filter((a) => a.type === 'add_late_fee');
  assert.deepEqual(fees.map((a) => a.payload.client), ['Ryan Castillo']);
  assert.equal(fees[0].payload.fee, 62, '5% of $1,240');
  assert.equal(jake.payload.tone, 'firm', 'second reminder escalates');
  assert.equal(jake.payload.subject, 'Quick reminder', 'AI drafted');
  // rescan does not duplicate
  assert.equal((await call('/api/followups/scan', {})).data.created.length, 0);
  const sent = await call(`/api/actions/${jake.id}/approve`, { edits: { message: 'Edited by me' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.action.result.remindersSent, 2);
  // approving the late fee updates the invoice total; a second fee is refused
  const fee = await call(`/api/actions/${fees[0].id}/approve`, {});
  assert.equal(fee.status, 200, JSON.stringify(fee.data));
  assert.equal(fee.data.action.result.newTotal, 1302);
  assert.equal((await call('/api/followups/scan', {})).data.created.filter((a) => a.type === 'add_late_fee').length, 0);
});

test('settings: business details validate and apply; secrets never returned', async () => {
  assert.equal((await call('/api/settings/business', { defaultTaxPercent: 80 })).status, 400);
  const ok = await call('/api/settings/business', { businessName: 'Test Studio', defaultTaxPercent: 8 });
  assert.equal(ok.status, 200);
  const { data } = await call('/api/settings');
  assert.equal(data.business.businessName, 'Test Studio');
  assert.equal(data.paypal.mode, 'mock');
  assert.ok(!JSON.stringify(data).toLowerCase().includes('secret'));
  // obviously incomplete keys are rejected before contacting PayPal
  assert.equal((await call('/api/settings/paypal/connect', { clientId: 'abc', clientSecret: 'x' })).status, 400);
  await call('/api/settings/business', { businessName: 'Test Studio', defaultTaxPercent: 0 });
});

test('dashboard figures', async () => {
  const { data } = await call('/api/dashboard');
  assert.ok(data.summary.overdueInvoices >= 1);
  assert.equal(data.chart.months.length, 6);
  assert.ok(data.forecast.invoices.length >= 1);
  assert.ok(data.activity.length > 0);
});

test('cron endpoint requires secret; static pages served', async () => {
  assert.equal((await call('/api/cron/followups?key=x')).status, 403);
  for (const p of ['/', '/dashboard', '/assistant', '/followups', '/calendar', '/analytics', '/clients', '/settings', '/app.css', '/common.js']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
  }
  assert.equal((await fetch(base + '/../package.json')).status, 404);
});

test('sales tax + deposit flow through to the PayPal invoice body', async () => {
  const { data } = await call('/api/chat', { sessionId: 'tax', message: 'Invoice Olivia for 10 posts at $25 plus 8% tax' });
  const a = data.actions[0];
  assert.equal(a.payload.subtotal, 250);
  assert.equal(a.payload.tax, 20);
  assert.equal(a.payload.total, 270);
  assert.equal(a.payload.depositAmount, 54);
  const ok = await call(`/api/actions/${a.id}/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const inv = (await call('/api/invoices')).data.invoices.find((i) => i.paypalId === ok.data.action.result.paypalId);
  assert.equal(inv.total, 270);
  assert.equal(inv.taxPercent, 8);
  assert.equal(inv.depositAmount, 54);
  const { kvGet } = await import('../src/db.js');
  const body = kvGet(`mock:inv:${inv.paypalId}`).body;
  assert.deepEqual(body.items[0].tax, { name: 'Sales Tax', percent: '8' });
  assert.deepEqual(body.configuration.partial_payment, { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '54.00' } });
  // a deposit >= total is rejected
  const bad = await call('/api/chat', { sessionId: 'tax2', message: 'tax again' });
  const r = await call(`/api/actions/${bad.data.actions[0].id}/approve`, { edits: { depositAmount: 999 } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Deposit must be less/);
});

test('PayPal create is idempotent per approval', async () => {
  const { paypal } = await import('../src/paypal.js');
  const args = { client: { name: 'A B', email: 'a@b.co' }, items: [{ name: 'x', quantity: 1, unitPrice: 5 }], currency: 'USD', dueDate: '2030-01-01', requestId: 'act_same' };
  const one = await paypal.createAndSendInvoice(args);
  const two = await paypal.createAndSendInvoice(args);
  assert.equal(one.paypalId, two.paypalId);
});

test('recurring invoices: schedule → due draft → next month', async () => {
  const { data } = await call('/api/chat', { sessionId: 'rec', message: 'Set up Emily for $600 every month' });
  const a = data.actions[0];
  assert.equal(a.type, 'create_schedule');
  const ok = await call(`/api/actions/${a.id}/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // starts today -> first draft is created immediately
  const draftId = ok.data.action.result.firstDraftId;
  assert.ok(draftId, 'first draft created on approval');
  const pend = (await call('/api/actions?status=pending&origin=schedule')).data.actions.find((x) => x.id === draftId);
  assert.equal(pend.payload.total, 600);
  let sch = (await call('/api/schedules')).data.schedules;
  assert.equal(sch.length, 1);
  assert.ok(sch[0].nextRun > ok.data.action.payload.startDate, 'next run advanced to next month');
  assert.equal((await call('/api/schedules/run', {})).data.created.length, 0, 'not due again yet');
  // manual form path (no AI)
  const form = await call('/api/schedules', { clientName: 'Marcus Hollis', clientEmail: 'ap@hollisgrant.com', description: 'Weekly support', amount: 150, frequency: 'weekly' });
  assert.equal(form.status, 200, JSON.stringify(form.data));
  assert.ok(form.data.action.result.firstDraftId);
  const bad = await call('/api/schedules', { clientName: 'X', clientEmail: 'nope', description: 'x', amount: 5, frequency: 'weekly' });
  assert.equal(bad.status, 400);
  sch = (await call('/api/schedules')).data.schedules;
  assert.equal(sch.length, 2);
  await call(`/api/schedules/${sch[0].id}/pause`, {});
  assert.equal((await call('/api/schedules')).data.schedules.find((x) => x.id === sch[0].id).active, false);
});

test('AI money brief uses computed facts', async () => {
  const { briefFacts } = await import('../src/brief.js');
  const f = briefFacts();
  assert.ok(f.overdue.byCustomer.length >= 1);
  assert.ok(f.overdue.byCustomer[0].amount >= f.overdue.byCustomer.at(-1).amount, 'sorted by amount');
  assert.ok(f.topCustomers[0].rank === 1 && f.topCustomers[0].totalPaid >= (f.topCustomers[1]?.totalPaid || 0));
  assert.ok(f.lifetime.paidInvoices > 0);
  assert.ok('changePct' in f.thisMonth);
  const { status, data } = await call('/api/brief', { refresh: true });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.facts.lifetime);
  assert.ok(data.ai.headline, JSON.stringify(data.ai));
  assert.ok(data.ai.actions.length >= 1);
  assert.equal((await call('/api/brief', {})).data.cached, true);
});

test('top customers, monthly payments and CSV export', async () => {
  const top = (await call('/api/insights/top-customers?limit=3')).data.customers;
  assert.equal(top[0].rank, 1);
  assert.ok(top[0].totalPaid >= top[1].totalPaid);
  const month = new Date().toISOString().slice(0, 7);
  const p = (await call(`/api/payments?month=${month}`)).data;
  assert.equal(p.month, month);
  assert.ok(p.payments.every((x) => x.paidDate.startsWith(month)));
  assert.equal((await call('/api/payments?month=bad')).status, 400);
  const csv = await fetch(base + '/api/invoices.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text.split("\r\n")[0], /^Invoice,Client,Reference,Work/);
});

test('new invoice form: send now, save as draft, validation', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    clientName: 'Sarah Johnson', clientEmail: 'sarah@johnsonbakery.example', company: 'Johnson Bakery LLC',
    items: [{ name: 'Menu design', quantity: 1, unitPrice: 400 }, { name: 'Print-ready files', quantity: 2, unitPrice: 50 }],
    currency: 'USD', issueDate: today, dueDate: today, taxPercent: 5, depositAmount: 100, reference: 'PO-2291', note: 'Thanks!', sendNow: true,
  };
  const sent = await call('/api/invoices', body);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.sent, true);
  const inv = (await call('/api/invoices')).data.invoices.find((i) => i.paypalId === sent.data.action.result.paypalId);
  assert.equal(inv.total, 525);
  assert.equal(inv.reference, 'PO-2291');
  assert.equal(inv.status, 'SENT');
  const c = (await call('/api/clients')).data.clients.find((x) => x.email === 'sarah@johnsonbakery.example');
  assert.equal(c.company, 'Johnson Bakery LLC');
  const { kvGet } = await import('../src/db.js');
  const pb = kvGet(`mock:inv:${inv.paypalId}`).body;
  assert.equal(pb.detail.reference, 'PO-2291');
  assert.equal(pb.primary_recipients[0].billing_info.business_name, 'Johnson Bakery LLC');
  const draft = await call('/api/invoices', { ...body, sendNow: false });
  assert.equal(draft.data.sent, false);
  assert.equal(draft.data.action.status, 'pending');
  assert.equal(draft.data.action.origin, 'form');
  const future = await call('/api/invoices', { ...body, issueDate: '2999-01-01' });
  assert.equal(future.status, 400);
  const badEmail = await call('/api/invoices', { ...body, clientEmail: 'nope' });
  assert.equal(badEmail.status, 400);
});

test('health endpoint + security headers', async () => {
  const res = await fetch(base + '/api/health');
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('calendar helpers', async () => {
  const { addMonths, addDays } = await import('../src/config.js');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});

test('provider adapters map tool calls correctly', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAA' }, { type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'list_invoices', input: { status: 'open' } }] },
    { role: 'tool', content: [{ type: 'tool_result', id: 'c1', name: 'list_invoices', output: '{}' }] },
  ];
  const a = toAnthropic(msgs);
  assert.equal(a[0].content[0].source.media_type, 'image/png');
  assert.equal(a[1].content[0].type, 'tool_use');
  assert.equal(a[2].role, 'user');
  assert.equal(a[2].content[0].tool_use_id, 'c1');
  const o = toOpenAI('sys', msgs);
  assert.equal(o[0].role, 'system');
  assert.equal(o[1].content[0].image_url.url, 'data:image/png;base64,AAA');
  assert.equal(o[2].tool_calls[0].function.arguments, '{"status":"open"}');
  assert.equal(o[3].role, 'tool');
});

test('PayPal invoice body shape', () => {
  const b = buildInvoiceBody({
    number: '0007',
    client: { name: 'Priya Raman', email: 'p@x.com' },
    items: [{ name: 'Retainer', quantity: 1, unitPrice: 600 }],
    currency: 'USD',
    issueDate: '2026-11-01',
    dueDate: '2026-11-15',
    note: 'Thanks!',
  });
  assert.equal(b.detail.invoice_number, '0007');
  assert.equal(b.detail.payment_term.due_date, '2026-11-15');
  assert.deepEqual(b.primary_recipients[0].billing_info.name, { given_name: 'Priya', surname: 'Raman' });
  assert.deepEqual(b.items[0].unit_amount, { currency_code: 'USD', value: '600.00' });
  assert.equal(b.items[0].quantity, '1');
});

test('collections board groups unpaid invoices and drafts in one click', async () => {
  const { data } = await call('/api/collections');
  assert.equal(data.stages.length, 4);
  assert.ok(data.cards.every((c) => ['upcoming', 'late', 'later', 'critical'].includes(c.stage)));
  const open = data.cards.find((c) => c.actionable && !c.drafts.length);
  if (open) {
    const r = await call('/api/followups/draft', { invoiceId: open.id, kind: 'reminder' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.action.type, 'send_reminder');
    // asking again returns the same draft instead of a duplicate
    assert.equal((await call('/api/followups/draft', { invoiceId: open.id, kind: 'reminder' })).data.action.id, r.data.action.id);
  }
});

test('PayPal-unsupported currencies are refused with a clear message', async () => {
  const r = await call('/api/invoices', { clientName: 'Asha Rao', clientEmail: 'asha@example.com', items: [{ name: 'Logo', quantity: 1, unitPrice: 5000 }], currency: 'INR', sendNow: true });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /can't be in INR/);
});

test('AI text with literal \\n is turned into real line breaks', async () => {
  const { cleanText } = await import('../src/actions.js');
  assert.equal(cleanText('Hi,\\n\\nThanks\\nAna'), 'Hi,\n\nThanks\nAna');
});

test('removing a client hides them (PayPal untouched)', async () => {
  const before = (await call('/api/clients')).data.clients;
  const ben = before.find((c) => c.name === 'Ben Whitaker');
  const r = await fetch(`${base}/api/clients/${ben.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  const after = (await call('/api/clients')).data.clients;
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.some((c) => c.id === ben.id));
});

test('autopilot plans every unpaid invoice and never softens the tone', async () => {
  const { data } = await call('/api/collections');
  assert.ok(data.autopilot.enabled);
  assert.ok(data.cards.every((c) => !c.actionable || c.plan.steps.length === 3));
  assert.ok(Array.isArray(data.comingUp));
  const bad = await call('/api/autopilot', { firmAfter: 10, finalAfter: 5 });
  assert.equal(bad.status, 400, 'final must come after firm');
  // after a final reminder, the next one is final too
  const { toneFor } = await import('../src/followups.js');
  assert.equal(toneFor({ reminders: [{ tone: 'final' }] }, 0), 'final');
  assert.equal(toneFor({ reminders: [] }, 0), 'friendly');
  // two runs at once create each draft only once
  const [a, b] = await Promise.all([call('/api/autopilot/run', {}), call('/api/autopilot/run', {})]);
  const ids = [...a.data.created, ...b.data.created].map((x) => x.id);
  assert.equal(new Set(ids).size, a.data.created.length);
});

test('mark an invoice as paid by hand', async () => {
  const open = (await call('/api/invoices')).data.invoices.find((i) => ['SENT', 'PARTIALLY_PAID'].includes(i.status) && i.paypalId?.startsWith('INV2-MOCK'));
  const r = await call(`/api/invoices/${open.id}/mark-paid`, { method: 'cash' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = (await call('/api/invoices')).data.invoices.find((i) => i.id === open.id);
  assert.equal(after.status, 'MARKED_AS_PAID');
  assert.ok(after.paidDate);
  assert.equal((await call(`/api/invoices/${open.id}/mark-paid`, {})).status, 400, 'cannot pay twice');
});

test('calendar, analytics, preferences and reminder preview', async () => {
  const cal = (await call('/api/calendar')).data;
  assert.match(cal.month, /^\d{4}-\d{2}$/);
  assert.ok(cal.events.every((e) => e.date >= cal.start && e.date <= cal.end));
  const an = (await call('/api/analytics?months=6')).data;
  assert.equal(an.months, 6);
  assert.equal(an.timing.length, 4);
  assert.ok(an.weeks.length >= 26);
  const bad = await call('/api/settings/business', { reminderStyle: 'angry' });
  assert.equal(bad.status, 400);
  const ok = await call('/api/settings/business', { reminderStyle: 'brief', ownerName: 'Ana Ortiz', defaultTermsDays: 15, notify: { import: false } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const s = (await call('/api/settings')).data.business;
  assert.equal(s.defaultTermsDays, 15);
  assert.equal(s.notify.import, false);
  assert.equal(s.notify.payment, true);
  const pv = await call('/api/settings/preview-reminder', {});
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.ok(pv.data.subject && pv.data.message);
  const backup = await fetch(base + '/api/export.json');
  assert.equal(backup.status, 200);
  assert.ok(Array.isArray((await backup.json()).invoices));
});
