// PayPal Invoicing v2 client.
//  - "sandbox"/"live": real REST calls to PayPal
//  - "mock": in-process simulation with the same interface (offline dev & tests)
import { config, isoDate, now } from './config.js';
import { db, save } from './db.js';

export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length <= 1) return { given_name: parts[0] || 'Client' };
  return { given_name: parts.slice(0, -1).join(' '), surname: parts.at(-1) };
}

function money(currency, value) {
  return { currency_code: currency, value: Number(value).toFixed(2) };
}

/** Build a PayPal v2 invoice body from our internal shape. Exported for tests. */
export function buildInvoiceBody({ number, client, items, currency, issueDate, dueDate, note }) {
  const body = {
    detail: {
      currency_code: currency,
      invoice_date: issueDate,
      payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dueDate },
    },
    invoicer: { business_name: config.businessName },
    primary_recipients: [
      { billing_info: { name: splitName(client.name), email_address: client.email } },
    ],
    items: items.map((it) => ({
      name: String(it.name).slice(0, 200),
      quantity: String(it.quantity),
      unit_amount: money(currency, it.unitPrice),
      unit_of_measure: 'QUANTITY',
    })),
  };
  if (number) body.detail.invoice_number = number;
  if (note) body.detail.note = String(note).slice(0, 4000);
  return body;
}

function paidDateFrom(inv) {
  const tx = inv?.payments?.transactions;
  if (Array.isArray(tx) && tx.length) return String(tx.at(-1).payment_date || '').slice(0, 10) || null;
  return null;
}

// ======================= REAL PAYPAL =======================
let token = null;
let tokenExp = 0;

async function getToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const { clientId, clientSecret, baseUrl } = config.paypal;
  if (!clientId || !clientSecret) throw new PayPalError('PayPal credentials missing (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).', 500);
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(`PayPal auth failed: ${json.error_description || res.status}`, res.status, json);
  token = json.access_token;
  tokenExp = Date.now() + json.expires_in * 1000;
  return token;
}

async function api(method, path, body, extraHeaders = {}) {
  const t = await getToken();
  const res = await fetch(`${config.paypal.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json.details?.map((d) => `${d.field || ''} ${d.issue || ''} ${d.description || ''}`.trim()).join('; ');
    throw new PayPalError(`PayPal ${method} ${path} failed (${res.status}): ${json.message || ''} ${detail || ''}`.trim(), res.status, json);
  }
  return json;
}

const real = {
  async createAndSendInvoice({ client, items, currency, dueDate, note }) {
    const issueDate = isoDate();
    const { invoice_number: number } = await api('POST', '/v2/invoicing/generate-next-invoice-number');
    const created = await api(
      'POST',
      '/v2/invoicing/invoices',
      buildInvoiceBody({ number, client, items, currency, issueDate, dueDate, note }),
      { Prefer: 'return=representation' }
    );
    const id = created.id || String(created.href || '').split('/').pop();
    if (!id) throw new PayPalError('PayPal did not return an invoice id', 500, created);
    const sent = await api('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: true });
    const payerUrl =
      sent?.href && /payer|invoice\/p/i.test(sent.href)
        ? sent.href
        : (sent?.links || []).find((l) => l.rel === 'payer-view')?.href || null;
    return { paypalId: id, number: created.detail?.invoice_number || number, status: 'SENT', payerUrl, issueDate };
  },

  async getInvoice(paypalId) {
    const inv = await api('GET', `/v2/invoicing/invoices/${paypalId}`);
    const payerUrl = (inv.links || []).find((l) => l.rel === 'payer-view')?.href || null;
    return { status: inv.status, paidDate: paidDateFrom(inv), payerUrl, raw: inv };
  },

  async remind(paypalId, { subject, note }) {
    await api('POST', `/v2/invoicing/invoices/${paypalId}/remind`, {
      subject: String(subject).slice(0, 4000),
      note: String(note).slice(0, 4000),
      send_to_invoicer: true,
    });
    return { ok: true };
  },

  async cancel(paypalId, { subject, note }) {
    await api('POST', `/v2/invoicing/invoices/${paypalId}/cancel`, {
      subject: String(subject).slice(0, 4000),
      note: String(note).slice(0, 4000),
      send_to_invoicer: true,
      send_to_recipient: true,
    });
    return { ok: true };
  },

  async verifyWebhook(headers, event) {
    if (!config.paypal.webhookId) return false;
    const r = await api('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.paypal.webhookId,
      webhook_event: event,
    });
    return r.verification_status === 'SUCCESS';
  },
};

// ======================= MOCK PAYPAL =======================
function mockStore() {
  const s = db();
  s.mockPaypal ||= { seq: 1000, invoices: {} };
  return s.mockPaypal;
}

const mock = {
  async createAndSendInvoice({ client, items, currency, dueDate, note }) {
    const m = mockStore();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(client.email)) throw new PayPalError('Invalid recipient email', 422);
    const number = String(++m.seq).padStart(4, '0');
    const paypalId = `INV2-MOCK-${number}`;
    m.invoices[paypalId] = {
      status: 'SENT',
      body: buildInvoiceBody({ number, client, items, currency, issueDate: isoDate(), dueDate, note }),
      reminders: 0,
    };
    save();
    return { paypalId, number, status: 'SENT', payerUrl: `/mock-pay.html?id=${paypalId}`, issueDate: isoDate() };
  },
  async getInvoice(paypalId) {
    const inv = mockStore().invoices[paypalId];
    if (!inv) throw new PayPalError('Invoice not found', 404);
    return { status: inv.status, paidDate: inv.paidDate || null, payerUrl: `/mock-pay.html?id=${paypalId}` };
  },
  async remind(paypalId) {
    const inv = mockStore().invoices[paypalId];
    if (!inv) throw new PayPalError('Invoice not found', 404);
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) throw new PayPalError(`Cannot remind an invoice in status ${inv.status}`, 422);
    inv.reminders++;
    save();
    return { ok: true };
  },
  async cancel(paypalId) {
    const inv = mockStore().invoices[paypalId];
    if (!inv) throw new PayPalError('Invoice not found', 404);
    if (inv.status === 'PAID') throw new PayPalError('Cannot cancel a paid invoice', 422);
    inv.status = 'CANCELLED';
    save();
    return { ok: true };
  },
  async verifyWebhook() {
    return true;
  },
  /** Mock-only: pretend the client paid. */
  simulatePayment(paypalId) {
    const inv = mockStore().invoices[paypalId];
    if (!inv) throw new PayPalError('Invoice not found', 404);
    inv.status = 'PAID';
    inv.paidDate = isoDate(now());
    save();
    return { status: 'PAID', paidDate: inv.paidDate };
  },
};

export const paypal = config.paypal.mode === 'mock' ? mock : real;
export const isMock = config.paypal.mode === 'mock';
