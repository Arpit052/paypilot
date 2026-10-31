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
  if (last.role === 'user' && /bill/i.test(userText)) {
    return {
      content: [
        { type: 'tool_call', id: 't1', name: 'get_client_insights', input: { client: 'Rahul Sharma' } },
        {
          type: 'tool_call',
          id: 't2',
          name: 'propose_invoice',
          input: {
            client_name: 'Rahul Sharma',
            client_email: 'rahul.sharma@example.com',
            items: [{ name: 'Logo concept', quantity: 3, unit_price: 150 }],
            due_in_days: 10,
          },
        },
      ],
    };
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
  assert.equal(data.clients.length, 4);
  const rahul = data.clients.find((c) => c.name === 'Rahul Sharma');
  assert.equal(rahul.riskLabel, 'high', 'late payer should be high risk');
  const priya = data.clients.find((c) => c.name === 'Priya Mehta');
  assert.equal(priya.riskLabel, 'low');
});

let actionId;
test('chat → AI proposes invoice (nothing sent yet)', async () => {
  const before = (await call('/api/invoices')).data.invoices.length;
  const { status, data } = await call('/api/chat', { sessionId: 's1', message: 'Bill Rahul for 3 logos at $150, due in 10 days' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.deepEqual(data.tools, ['get_client_insights', 'propose_invoice']);
  assert.equal(data.actions.length, 1);
  const a = data.actions[0];
  assert.equal(a.type, 'create_invoice');
  assert.equal(a.status, 'pending');
  assert.equal(a.payload.total, 450);
  assert.equal(a.payload.risk.label, 'high');
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

test('approve with user edits → invoice sent via PayPal (mock)', async () => {
  const { status, data } = await call(`/api/actions/${actionId}/approve`, {
    edits: { items: [{ name: 'Logo concept', quantity: 3, unitPrice: 160 }] },
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
  const { data } = await call('/api/chat', { sessionId: 's3', message: 'bill rahul' });
  const id = data.actions[0].id;
  const r = await call(`/api/actions/${id}/approve`, { edits: { clientEmail: 'not-an-email' } });
  assert.equal(r.status, 400);
  const pend = (await call('/api/actions?status=pending')).data.actions.find((a) => a.id === id);
  assert.match(pend.error, /email/);
  assert.equal((await call(`/api/actions/${id}/reject`, {})).data.action.status, 'rejected');
});

test('payment via webhook path flips status to PAID', async () => {
  const inv = (await call('/api/invoices')).data.invoices.find((i) => i.paypalId?.startsWith('INV2-MOCK') && i.client === 'Neha Kapoor');
  const r = await call(`/api/mock/pay/${inv.paypalId}`, {});
  assert.equal(r.data.changed, true);
  const after = (await call('/api/invoices')).data.invoices.find((i) => i.id === inv.id);
  assert.equal(after.status, 'PAID');
  assert.ok(after.paidDate);
});

test('follow-up scan drafts reminders for overdue invoices only, then sends', async () => {
  const { data } = await call('/api/followups/scan', {});
  const nums = data.created.map((a) => a.payload.client).sort();
  assert.deepEqual(nums, ['Acme Labs', 'Rahul Sharma']);
  const rahul = data.created.find((a) => a.payload.client === 'Rahul Sharma');
  assert.equal(rahul.payload.tone, 'firm', 'second reminder escalates');
  assert.equal(rahul.payload.subject, 'Quick reminder', 'AI drafted');
  // rescan does not duplicate
  assert.equal((await call('/api/followups/scan', {})).data.created.length, 0);
  const sent = await call(`/api/actions/${rahul.id}/approve`, { edits: { message: 'Edited by me' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.action.result.remindersSent, 2);
});

test('dashboard figures', async () => {
  const { data } = await call('/api/dashboard');
  assert.ok(data.summary.overdueInvoices >= 2);
  assert.equal(data.chart.months.length, 6);
  assert.equal(data.chart.weeks.length, 4);
  assert.ok(data.forecast.invoices.length >= 1);
  assert.ok(data.activity.length > 0);
});

test('cron endpoint requires secret; static pages served', async () => {
  assert.equal((await call('/api/cron/followups?key=x')).status, 403);
  for (const p of ['/', '/dashboard', '/followups', '/clients', '/app.css', '/common.js']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
  }
  assert.equal((await fetch(base + '/../package.json')).status, 404);
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
    client: { name: 'Priya Mehta', email: 'p@x.com' },
    items: [{ name: 'Retainer', quantity: 1, unitPrice: 600 }],
    currency: 'USD',
    issueDate: '2026-11-01',
    dueDate: '2026-11-15',
    note: 'Thanks!',
  });
  assert.equal(b.detail.invoice_number, '0007');
  assert.equal(b.detail.payment_term.due_date, '2026-11-15');
  assert.deepEqual(b.primary_recipients[0].billing_info.name, { given_name: 'Priya', surname: 'Mehta' });
  assert.deepEqual(b.items[0].unit_amount, { currency_code: 'USD', value: '600.00' });
  assert.equal(b.items[0].quantity, '1');
});
