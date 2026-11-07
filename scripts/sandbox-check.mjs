// Checks your PayPal SANDBOX keys against the real sandbox API, end to end, and cleans up after itself.
// Usage: npm run sandbox-check      (reads keys from Settings or .env; never prints them)
//
// 1. gets a token and checks the app has the Invoicing permission
// 2. creates a DRAFT invoice (never sent to anyone), reads it back, checks the total to the cent
// 3. repeats the create with the same PayPal-Request-Id and checks PayPal returns the same invoice
// 4. sends a webhook verification request with fake headers and checks PayPal says FAILURE
// 5. deletes the draft
import { config } from '../src/config.js';
import { applySettings } from '../src/settings.js';

applySettings();
const { clientId, clientSecret } = config.paypal;
const base = 'https://api-m.sandbox.paypal.com';
if (config.paypal.mode === 'live') {
  console.error('This check only runs against the sandbox. Set PAYPAL_MODE=sandbox.');
  process.exit(1);
}
if (!clientId || !clientSecret) {
  console.error('No PayPal sandbox keys found. Connect PayPal in Settings or add them to .env first.');
  process.exit(1);
}

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};
const t0 = Date.now();
const tokRes = await fetch(`${base}/v1/oauth2/token`, {
  method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
const tok = await tokRes.json().catch(() => ({}));
check('sandbox keys accepted', tokRes.ok, `${Date.now() - t0} ms`);
if (!tokRes.ok) process.exit(1);
check('app has the Invoicing permission', String(tok.scope || '').includes('/services/invoicing'));

const H = { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const rid = `sandbox-check-${Date.now()}`;
const body = {
  detail: { currency_code: 'USD', note: 'PayPilot sandbox check: draft, never sent' },
  primary_recipients: [{ billing_info: { email_address: 'sandbox-check@example.com', name: { given_name: 'Sandbox', surname: 'Check' } } }],
  items: [
    { name: 'Line A', quantity: '1', unit_amount: { currency_code: 'USD', value: '0.10' } },
    { name: 'Line B', quantity: '1', unit_amount: { currency_code: 'USD', value: '0.20' } },
    { name: 'Line C', quantity: '3', unit_amount: { currency_code: 'USD', value: '33.33' } },
  ],
};
const c1 = await fetch(`${base}/v2/invoicing/invoices`, { method: 'POST', headers: { ...H, 'PayPal-Request-Id': rid }, body: JSON.stringify(body) });
const inv = await c1.json().catch(() => ({}));
const id = inv.id || inv.href?.split('/').pop();
check('draft invoice created', c1.ok && Boolean(id), c1.ok ? id : `${c1.status} ${inv.message || ''}`);
if (id) {
  const g = await (await fetch(`${base}/v2/invoicing/invoices/${id}`, { headers: H })).json();
  check('total exact to the cent ($100.29)', g.amount?.value === '100.29', `PayPal says ${g.amount?.value}`);
  check('status is DRAFT (nothing was sent)', g.status === 'DRAFT', g.status);
  const c2 = await fetch(`${base}/v2/invoicing/invoices`, { method: 'POST', headers: { ...H, 'PayPal-Request-Id': rid }, body: JSON.stringify(body) });
  const again = await c2.json().catch(() => ({}));
  const id2 = again.id || again.href?.split('/').pop();
  check('same PayPal-Request-Id returns the same invoice (no duplicate)', id2 === id, id2);
  if (id2 && id2 !== id) await fetch(`${base}/v2/invoicing/invoices/${id2}`, { method: 'DELETE', headers: H });
  const del = await fetch(`${base}/v2/invoicing/invoices/${id}`, { method: 'DELETE', headers: H });
  check('draft deleted again', del.status === 204 || del.ok, String(del.status));
}

if (config.paypal.webhookId) {
  const v = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ auth_algo: 'SHA256withRSA', cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake', transmission_id: 'fake', transmission_sig: 'fake', transmission_time: new Date().toISOString(), webhook_id: config.paypal.webhookId, webhook_event: { event_type: 'INVOICING.INVOICE.PAID', resource: {} } }),
  });
  const vr = await v.json().catch(() => ({}));
  check('forged webhook is rejected by PayPal', vr.verification_status !== 'SUCCESS', vr.verification_status || String(v.status));
} else {
  console.log('SKIP  webhook check (no PAYPAL_WEBHOOK_ID set)');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
