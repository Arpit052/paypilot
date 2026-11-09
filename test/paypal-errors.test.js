// how PayPilot behaves when PayPal misbehaves. A local fake PayPal answers with
// 401 / 422 / 429 / 500 or hangs, and we check retries, timeouts and the message the user sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-pperr-'));
process.env.PAYPAL_MODE = 'sandbox';
process.env.PAYPAL_CLIENT_ID = 'fake-id';
process.env.PAYPAL_CLIENT_SECRET = 'fake-secret';
process.env.PAYPAL_TIMEOUT_MS = '400';
process.env.PAYPAL_RETRY_MS = '10';
process.env.LLM_PROVIDER = 'none';
process.env.APP_TIMEZONE = 'UTC';

// what the fake PayPal does next, per path
let script = {};
const hits = [];
let tokens = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, rid: req.headers['paypal-request-id'] || null, auth: req.headers.authorization });
    if (req.url === '/v1/oauth2/token') {
      tokens++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: `tok${tokens}`, expires_in: 32400, scope: 'https://uri.paypal.com/services/invoicing' }));
    }
    const queue = script[req.url] || [];
    const next = queue.length ? queue.shift() : { status: 200, body: { status: 'SENT', id: 'INV2-TEST' } };
    if (next.hang) return; // never answer
    if (next.needsToken && req.headers.authorization !== `Bearer ${next.needsToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_token' }));
    }
    res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers || {}) });
    res.end(JSON.stringify(next.body || {}));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const { config } = await import('../src/config.js');
config.paypal.baseUrl = `http://127.0.0.1:${fake.address().port}`;
const { paypal, PayPalError, friendlyPaypalError } = await import('../src/paypal.js');
test.after(() => fake.close());

const reset = (s) => {
  script = s;
  hits.length = 0;
};

test('a GET that gets 429 or 503 is retried and then succeeds', async () => {
  reset({ '/v2/invoicing/invoices/INV2-A': [{ status: 429, headers: { 'retry-after': '0' } }, { status: 503 }, { status: 200, body: { status: 'PAID' } }] });
  const r = await paypal.getInvoice('INV2-A');
  assert.equal(r.status, 'PAID');
  assert.equal(hits.filter((h) => h.url === '/v2/invoicing/invoices/INV2-A').length, 3);
});

test('a hung PayPal call times out instead of hanging the app', async () => {
  reset({ '/v2/invoicing/invoices/INV2-H': [{ hang: true }, { hang: true }, { hang: true }] });
  const t0 = Date.now();
  await assert.rejects(paypal.getInvoice('INV2-H'), (e) => e instanceof PayPalError && /didn't answer|timed out/i.test(e.message));
  assert.ok(Date.now() - t0 < 5000);
});

test('an expired token (401) is refreshed once and the call goes through', async () => {
  reset({ '/v2/invoicing/invoices/INV2-T': [{ needsToken: 'tok999', status: 200 }, { status: 200, body: { status: 'SENT' } }] });
  const r = await paypal.getInvoice('INV2-T');
  assert.equal(r.status, 'SENT');
});

test('a reminder (POST) is retried on 429 with the same request id, never on 500', async () => {
  reset({ '/v2/invoicing/invoices/INV2-R/remind': [{ status: 429 }, { status: 200 }] });
  await paypal.remind('INV2-R', { subject: 's', note: 'n', requestId: 'act_1' });
  const posts = hits.filter((h) => h.url.endsWith('/remind'));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].rid, posts[1].rid);
  reset({ '/v2/invoicing/invoices/INV2-R/remind': [{ status: 500 }, { status: 200 }] });
  await assert.rejects(paypal.remind('INV2-R', { subject: 's', note: 'n', requestId: 'act_2' }));
  assert.equal(hits.filter((h) => h.url.endsWith('/remind')).length, 1, 'a 500 on a write may have gone through: no blind retry');
});

test('PayPal errors become plain sentences for the user', () => {
  const m = (status, body) => friendlyPaypalError(new PayPalError('PayPal POST /v2/invoicing/invoices failed', status, body));
  assert.match(m(422, { details: [{ issue: 'INVALID_CURRENCY_CODE' }] }), /currency/i);
  assert.match(m(422, { details: [{ field: '/primary_recipients/0/billing_info/email_address', issue: 'INVALID_STRING_LENGTH' }] }), /email/i);
  assert.match(m(401, {}), /keys|connect/i);
  assert.match(m(429, {}), /busy|try again/i);
  assert.match(m(500, {}), /PayPal.*(problem|down|try again)/i);
  for (const s of [400, 401, 403, 404, 422, 429, 500, 503]) assert.doesNotMatch(m(s, {}), /\/v2\/|POST|GET/, 'no raw API paths in what the user reads');
});
