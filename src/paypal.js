// PayPal Invoicing v2 client.
//  - "sandbox"/"live": real REST calls to PayPal
//  - "mock": in-process simulation with the same interface (offline dev & tests)
import { config, isoDate, now } from './config.js';
import { kvGet, kvSet, listInvoices } from './db.js';

export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * What the user reads when PayPal refuses something: a plain sentence, never a raw API path.
 * The full technical message stays in the server log.
 */
export function friendlyPaypalError(e) {
  if (!(e instanceof PayPalError)) return e?.message || 'Something went wrong talking to PayPal.';
  if (e.friendly) return e.message;
  const det = Array.isArray(e.details?.details) ? e.details.details : [];
  const txt = det.map((d) => `${d.field || ''} ${d.issue || ''} ${d.description || ''}`).join(' ').toLowerCase();
  const s = e.status;
  // our own short messages (mock PayPal, local checks) are already readable
  if (!/^PayPal (GET|POST|PUT|PATCH|DELETE) \//.test(e.message) && s >= 400 && s < 500 && s !== 401 && s !== 429 && !e.network) return e.message;
  if (s === 408 || e.timeout) return "PayPal didn't answer in time. Nothing was changed on our side, so you can try again.";
  if (s === 401) return "PayPal didn't accept the saved keys. Reconnect PayPal in Settings.";
  if (s === 403) return "PayPal says this app isn't allowed to do that. Check that Invoicing is enabled for your app on developer.paypal.com.";
  if (s === 404) return "PayPal couldn't find this invoice. It may have been deleted on paypal.com.";
  if (s === 429) return 'PayPal is busy right now. Wait a few seconds and try again.';
  if (s >= 500) return 'PayPal is having a problem right now. Try again in a minute.';
  if (/currency/.test(txt)) return "PayPal doesn't accept that currency for this account. Pick another currency.";
  if (/email/.test(txt)) return "PayPal didn't accept the client's email address. Check it and try again.";
  if (/due_date|invoice_date|date/.test(txt)) return "PayPal didn't accept one of the dates. Check the issue and due dates.";
  if (/amount|value|price|quantity/.test(txt)) return "PayPal didn't accept one of the amounts. Check prices and quantities.";
  if (/duplicate|already/.test(txt)) return 'PayPal says this was already done.';
  if (/status|cannot|not_allowed|invalid_state/.test(txt) || /status/i.test(e.details?.message || '')) return "PayPal won't do that for an invoice in its current state.";
  const m = String(e.details?.message || '').replace(/https?:\S+/g, '').trim();
  return m && !/\/v\d\//.test(m) ? `PayPal said: ${m}` : "PayPal didn't accept this. Check the details and try again.";
}

const TIMEOUT_MS = () => Number(process.env.PAYPAL_TIMEOUT_MS || 20000);
const RETRY_MS = () => Number(process.env.PAYPAL_RETRY_MS || 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with a deadline: a hung PayPal must never hang a page or the scheduler. */
async function timedFetch(url, opts) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS()) });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw Object.assign(new PayPalError(timeout ? "PayPal didn't answer in time." : "Couldn't reach PayPal.", timeout ? 408 : 503), { timeout, network: true });
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
export function buildInvoiceBody({ number, client, items, currency, issueDate, dueDate, note, taxPercent = 0, depositAmount = 0, reference = '', discountAmount = 0 }) {
  const body = {
    detail: {
      currency_code: currency,
      payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dueDate },
    },
    // without a name PayPal shows the account's own business name
    ...(config.businessName ? { invoicer: { business_name: config.businessName } } : {}),
    primary_recipients: [
      {
        billing_info: {
          name: splitName(client.name),
          email_address: client.email,
          ...(client.company ? { business_name: String(client.company).slice(0, 300) } : {}),
        },
      },
    ],
    items: items.map((it) => ({
      name: String(it.name).slice(0, 200),
      quantity: String(it.quantity),
      unit_amount: money(currency, it.unitPrice),
      unit_of_measure: 'QUANTITY',
      ...(taxPercent > 0 && !it.noTax ? { tax: { name: 'Sales Tax', percent: String(taxPercent) } } : {}),
    })),
    configuration: {
      allow_tip: false,
      tax_calculated_after_discount: true,
      tax_inclusive: false,
      partial_payment:
        depositAmount > 0
          ? { allow_partial_payment: true, minimum_amount_due: money(currency, depositAmount) }
          : { allow_partial_payment: false },
    },
  };
  // invoice_date is optional - PayPal defaults it to "today" in its own time zone, which
  // avoids "date in the future" errors when the freelancer is ahead of US time.
  if (issueDate) body.detail.invoice_date = issueDate;
  if (number) body.detail.invoice_number = number;
  if (note) body.detail.note = String(note).slice(0, 4000);
  if (reference) body.detail.reference = String(reference).slice(0, 120);
  // early-pay discount: an invoice-level discount PayPal applies before tax
  if (discountAmount > 0) body.amount = { breakdown: { discount: { invoice_discount: { amount: money(currency, discountAmount) } } } };
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
let tokenFor = '';

async function getToken() {
  const { clientId, clientSecret, baseUrl } = config.paypal;
  if (token && tokenFor === clientId && Date.now() < tokenExp - 60000) return token;
  if (!clientId || !clientSecret) throw new PayPalError('PayPal credentials missing (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).', 500);
  const res = await timedFetch(`${baseUrl}/v1/oauth2/token`, {
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
  tokenFor = clientId;
  return token;
}

/**
 * Check a pair of sandbox keys against PayPal before saving them (used by the
 * "Connect PayPal" screen). Never stores anything itself.
 */
export async function verifyCredentials(clientId, clientSecret, baseUrl = 'https://api-m.sandbox.paypal.com') {
  let res;
  try {
    res = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return { ok: false, error: "Couldn't reach PayPal. Check your internet connection and try again." };
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error:
        res.status === 401
          ? "PayPal didn't accept these keys. Copy the Client ID and Secret again from developer.paypal.com → Apps & Credentials (Sandbox)."
          : `PayPal returned an error (${res.status}). Please try again.`,
    };
  }
  if (!String(json.scope || '').includes('/services/invoicing')) {
    return { ok: false, error: 'These keys work, but the app has no Invoicing permission. Enable "Invoicing" for the app on developer.paypal.com.' };
  }
  return { ok: true, appId: json.app_id || null };
}

/**
 * One PayPal REST call, with the retry rules:
 * - reads (GET) retry on 429, 5xx, timeouts and network errors (up to 3 tries)
 * - writes retry only on 429/503 (PayPal didn't process it) and only with a PayPal-Request-Id,
 *   so PayPal de-duplicates; a 500 or timeout on a write may have gone through, so no blind retry
 * - a 401 mid-session (token expired or revoked) gets one fresh token and one more try
 */
async function api(method, path, body, extraHeaders = {}) {
  const read = method === 'GET';
  const idempotent = read || Boolean(extraHeaders['PayPal-Request-Id']);
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return await apiOnce(method, path, body, extraHeaders);
    } catch (e) {
      if (!(e instanceof PayPalError)) throw e;
      if (e.status === 401 && !refreshed && !e.auth) {
        refreshed = true;
        token = null;
        continue;
      }
      const retryable = read ? e.status === 429 || e.status >= 500 || e.network : idempotent && (e.status === 429 || e.status === 503) && !e.timeout;
      if (!retryable || attempt >= 3) throw e;
      await sleep(Math.min(5000, (e.retryAfter ?? 0) * 1000 || RETRY_MS() * 2 ** (attempt - 1)));
    }
  }
}

async function apiOnce(method, path, body, extraHeaders) {
  const t = await getToken().catch((e) => {
    throw Object.assign(e, { auth: true });
  });
  const res = await timedFetch(`${config.paypal.baseUrl}${path}`, {
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
    const err = new PayPalError(`PayPal ${method} ${path} failed (${res.status}): ${json.message || ''} ${detail || ''}`.trim(), res.status, json);
    const ra = Number(res.headers.get('retry-after'));
    if (Number.isFinite(ra) && res.headers.get('retry-after') !== null) err.retryAfter = ra;
    throw err;
  }
  return json;
}

const real = {
  /** Available PayPal balance in a currency, or null if PayPal won't share it (needs the Reporting API). */
  async getBalance(currency) {
    const r = await api('GET', `/v1/reporting/balances?currency_code=${encodeURIComponent(currency)}`);
    const b = (r.balances || []).find((x) => x.currency === currency);
    const v = Number(b?.available_balance?.value ?? b?.total_balance?.value);
    return Number.isFinite(v) ? v : null;
  },
  /**
   * Create + send an invoice. `requestId` (the approval action id) makes this idempotent:
   * - PayPal-Request-Id headers let PayPal de-duplicate retried POSTs
   * - progress is checkpointed locally, so a retry after a partial failure resumes
   *   (reuses the same number / invoice id) instead of creating a duplicate.
   */
  async createAndSendInvoice({ client, items, currency, issueDate, dueDate, note, taxPercent, depositAmount, reference, discountAmount = 0, requestId }) {
    const ck = requestId ? `idem:${requestId}` : null;
    const state = (ck && kvGet(ck)) || {};
    const save = () => ck && kvSet(ck, state);
    const hdr = (step) => (requestId ? { 'PayPal-Request-Id': `${requestId}-${step}` } : {});

    if (!state.number) {
      state.number = String(nextInvoiceNumber());
      kvSet('inv:seq', Number(state.number));
      save();
    }
    if (!state.id) {
      // PayPal doesn't offer split payments to merchants in some countries (India, Brazil,
      // Israel). There we still send the invoice and ask for the deposit in the note.
      const noSplitKey = `paypal:noPartial:${config.paypal.clientId}`;
      const asNote = () => {
        state.depositAsNote = true;
        const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(depositAmount);
        const line = `Deposit: please pay ${fmt} upfront so work can begin. The balance is due by ${dueDate}.`;
        return buildInvoiceBody({ number: state.number, client, items, currency, issueDate, dueDate, note: note ? `${note}\n\n${line}` : line, taxPercent, depositAmount: 0, reference, discountAmount: state.noDiscount ? 0 : discountAmount });
      };
      const body = depositAmount > 0 && kvGet(noSplitKey) ? asNote() : buildInvoiceBody({ number: state.number, client, items, currency, issueDate, dueDate, note, taxPercent, depositAmount, reference, discountAmount });
      let created;
      let payload = body;
      for (let attempt = 0; ; attempt++) {
        try {
          created = await api('POST', '/v2/invoicing/invoices', payload, { Prefer: 'return=representation', ...hdr(`create-${state.number}`) });
          break;
        } catch (e) {
          if (depositAmount > 0 && e.status === 400 && /partial/i.test(e.message) && !state.depositAsNote) {
            kvSet(noSplitKey, true);
            payload = asNote();
            continue;
          }
          // PayPal refused the discount: send at the full price rather than not at all
          if (discountAmount > 0 && !state.noDiscount && e.status === 400 && /discount/i.test(e.message)) {
            state.noDiscount = true;
            const { amount, ...rest } = payload;
            payload = rest;
            continue;
          }
          // that number is already used on this PayPal account (e.g. made on paypal.com): take the next one
          if (attempt < 8 && /duplicate|already exists|invoice_number/i.test(e.message)) {
            state.number = String(Number(state.number) + 1);
            kvSet('inv:seq', Number(state.number));
            payload = { ...payload, detail: { ...payload.detail, invoice_number: state.number } };
            save();
            continue;
          }
          throw e;
        }
      }
      state.id = created.id || String(created.href || '').split('/').pop();
      if (!state.id) throw new PayPalError('PayPal did not return an invoice id', 500, created);
      state.total = Number(created.amount?.value) || null;
      save();
    }
    if (!state.sent) {
      const sent = await api('POST', `/v2/invoicing/invoices/${state.id}/send`, { send_to_invoicer: true }, hdr('send'));
      state.payerUrl =
        sent?.href && /payer|invoice\/p/i.test(sent.href)
          ? sent.href
          : (sent?.links || []).find((l) => l.rel === 'payer-view')?.href || null;
      state.sent = true;
      // the exact link PayPal emails to the client
      const fresh = await api('GET', `/v2/invoicing/invoices/${state.id}`).catch(() => null);
      state.payerUrl = fresh?.detail?.metadata?.recipient_view_url || state.payerUrl;
      save();
    }
    return { paypalId: state.id, number: state.number, status: 'SENT', payerUrl: state.payerUrl, issueDate: isoDate(), total: state.total, depositAsNote: Boolean(state.depositAsNote), discountRefused: Boolean(state.noDiscount) };
  },

  /** Early-pay window over: take the invoice-level discount off (full update) and re-notify the client. */
  async removeDiscount(paypalId, { requestId } = {}) {
    const raw = await api('GET', `/v2/invoicing/invoices/${paypalId}`);
    if (!raw.amount?.breakdown?.discount?.invoice_discount) return { total: Number(raw.amount?.value) || null, already: true };
    const body = { id: raw.id, detail: raw.detail, invoicer: raw.invoicer, primary_recipients: raw.primary_recipients, items: raw.items, configuration: raw.configuration };
    const updated = await api('PUT', `/v2/invoicing/invoices/${paypalId}?send_to_recipient=true&send_to_invoicer=true`, body, {
      Prefer: 'return=representation',
      ...(requestId ? { 'PayPal-Request-Id': `${requestId}-nodiscount` } : {}),
    });
    return { total: Number(updated.amount?.value) || null };
  },

  async getInvoice(paypalId) {
    const inv = await api('GET', `/v2/invoicing/invoices/${paypalId}`);
    const payerUrl = inv.detail?.metadata?.recipient_view_url || (inv.links || []).find((l) => l.rel === 'payer-view')?.href || null;
    return { status: inv.status, paidDate: paidDateFrom(inv), payerUrl, raw: inv };
  },

  /** All invoices on the PayPal account (newest first), up to `max`. List entries have no line items. */
  async listInvoices({ max = 300 } = {}) {
    const out = [];
    for (let page = 1; out.length < max && page <= 10; page++) {
      const r = await api('GET', `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true`);
      out.push(...(r.items || []));
      if (!r.items?.length || out.length >= (r.total_items || 0)) break;
    }
    return out.slice(0, max);
  },

  /**
   * Add a late-fee line to a sent invoice (full update via PUT) and re-notify the client.
   * Idempotent: if a late-fee line is already on the invoice, nothing is added twice.
   */
  async addLateFee(paypalId, { name, amount, currency, requestId }) {
    const raw = await api('GET', `/v2/invoicing/invoices/${paypalId}`);
    if ((raw.items || []).some((it) => /^late fee/i.test(it.name || ''))) return { total: Number(raw.amount?.value) || null, already: true };
    const body = {
      id: raw.id,
      detail: raw.detail,
      invoicer: raw.invoicer,
      primary_recipients: raw.primary_recipients,
      items: [...(raw.items || []), { name: String(name).slice(0, 200), quantity: '1', unit_amount: money(currency, amount), unit_of_measure: 'QUANTITY' }],
      configuration: raw.configuration,
    };
    const updated = await api('PUT', `/v2/invoicing/invoices/${paypalId}?send_to_recipient=true&send_to_invoicer=true`, body, {
      Prefer: 'return=representation',
      ...(requestId ? { 'PayPal-Request-Id': `${requestId}-latefee` } : {}),
    });
    return { total: Number(updated.amount?.value) || null };
  },

  /** Record a payment received outside PayPal (cash, bank transfer, cheque…). Invoice becomes MARKED_AS_PAID. */
  async recordPayment(paypalId, { amount, currency, method = 'BANK_TRANSFER', date, note, requestId }) {
    await api(
      'POST',
      `/v2/invoicing/invoices/${paypalId}/payments`,
      { method, payment_date: date, amount: money(currency, amount), ...(note ? { note: String(note).slice(0, 2000) } : {}) },
      requestId ? { 'PayPal-Request-Id': `${requestId}-paid` } : {}
    );
    return { ok: true };
  },

  async remind(paypalId, { subject, note, requestId }) {
    await api(
      'POST',
      `/v2/invoicing/invoices/${paypalId}/remind`,
      { subject: String(subject).slice(0, 4000), note: String(note).slice(0, 4000), send_to_invoicer: true },
      requestId ? { 'PayPal-Request-Id': `${requestId}-remind` } : {}
    );
    return { ok: true };
  },

  async cancel(paypalId, { subject, note, requestId }) {
    await api(
      'POST',
      `/v2/invoicing/invoices/${paypalId}/cancel`,
      { subject: String(subject).slice(0, 4000), note: String(note).slice(0, 4000), send_to_invoicer: true, send_to_recipient: true },
      requestId ? { 'PayPal-Request-Id': `${requestId}-cancel` } : {}
    );
    return { ok: true };
  },

  async verifyWebhook(headers, event) {
    if (!config.paypal.webhookId) return false;
    // PayPal always signs its webhooks; without these headers it's not from PayPal
    if (!headers['paypal-transmission-sig'] || !headers['paypal-transmission-id'] || !headers['paypal-cert-url']) return false;
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
const mockGet = (id) => kvGet(`mock:inv:${id}`);
const mockPut = (id, v) => kvSet(`mock:inv:${id}`, v);
export function mockNextNumber() {
  const seq = nextInvoiceNumber();
  kvSet('mock:seq', seq);
  return String(seq);
}

/**
 * Clean, human invoice numbers: 1001, 1002, … (no leading zeros). Continues after the
 * highest number PayPilot has seen, so imported and demo invoices never collide.
 */
export function nextInvoiceNumber() {
  let max = Math.max(1000, Number(kvGet('mock:seq', 1000)) || 1000, Number(kvGet('inv:seq', 1000)) || 1000);
  for (const i of listInvoices()) if (/^\d{4,7}$/.test(String(i.number))) max = Math.max(max, Number(i.number));
  return max + 1;
}
export { mockPut };

const mock = {
  async getBalance() {
    return null; // demo mode has no real balance; you type what you have
  },
  async listInvoices() {
    return []; // demo invoices already live in PayPilot's own database
  },
  async createAndSendInvoice({ client, items, currency, issueDate, dueDate, note, taxPercent, depositAmount, reference, discountAmount = 0, requestId }) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(client.email)) throw new PayPalError('Invalid recipient email', 422);
    const done = requestId && kvGet(`idem:${requestId}`);
    if (done) return done; // idempotent retry
    const number = mockNextNumber();
    const paypalId = `INV2-MOCK-${number}`;
    mockPut(paypalId, { status: 'SENT', reminders: 0, discount: discountAmount || 0, body: buildInvoiceBody({ number, client, items, currency, issueDate, dueDate, note, taxPercent, depositAmount, reference, discountAmount }) });
    const result = { paypalId, number, status: 'SENT', payerUrl: `/mock-pay.html?id=${paypalId}`, issueDate: isoDate() };
    if (requestId) kvSet(`idem:${requestId}`, result);
    return result;
  },
  async getInvoice(paypalId) {
    const inv = mockGet(paypalId);
    if (!inv) throw new PayPalError('Invoice not found', 404);
    return { status: inv.status, paidDate: inv.paidDate || null, payerUrl: `/mock-pay.html?id=${paypalId}` };
  },
  async removeDiscount(paypalId) {
    const inv = mockGet(paypalId);
    if (!inv) throw new PayPalError('Invoice not found', 404);
    if (!inv.discount) return { total: null, already: true };
    inv.discount = 0;
    mockPut(paypalId, inv);
    return { total: null };
  },
  async addLateFee(paypalId, { amount }) {
    const inv = mockGet(paypalId);
    if (!inv) throw new PayPalError('Invoice not found', 404);
    if (inv.lateFee) return { total: null, already: true };
    inv.lateFee = amount;
    mockPut(paypalId, inv);
    return { total: null };
  },
  async remind(paypalId) {
    const inv = mockGet(paypalId);
    if (!inv) throw new PayPalError('Invoice not found', 404);
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) throw new PayPalError(`Cannot remind an invoice in status ${inv.status}`, 422);
    inv.reminders++;
    mockPut(paypalId, inv);
    return { ok: true };
  },
  async cancel(paypalId) {
    const inv = mockGet(paypalId);
    if (!inv) throw new PayPalError('Invoice not found', 404);
    if (inv.status === 'PAID') throw new PayPalError('Cannot cancel a paid invoice', 422);
    inv.status = 'CANCELLED';
    mockPut(paypalId, inv);
    return { ok: true };
  },
  async verifyWebhook() {
    return true;
  },
  /** Mock-only: pretend the client paid. */
  async recordPayment(paypalId, { date }) {
    const inv = mockGet(paypalId);
    if (!inv) throw new PayPalError('Invoice not found', 404);
    inv.status = 'MARKED_AS_PAID';
    inv.paidDate = date;
    mockPut(paypalId, inv);
    return { ok: true };
  },
  simulatePayment(paypalId) {
    const inv = mockGet(paypalId);
    if (!inv) throw new PayPalError('Invoice not found', 404);
    inv.status = 'PAID';
    inv.paidDate = isoDate(now());
    mockPut(paypalId, inv);
    return { status: 'PAID', paidDate: inv.paidDate };
  },
};

/** Is PayPal in offline demo mode right now? (Can change at runtime via Settings.) */
export const isMock = () => config.paypal.mode === 'mock';

// Always points at the client for the current mode, so connecting/disconnecting
// PayPal in Settings takes effect immediately without a restart.
export const paypal = new Proxy(
  {},
  { get: (_, key) => (isMock() ? mock : real)[key] }
);

const isMockId = (inv) => String(inv?.paypalId || '').startsWith('INV2-MOCK-');

/**
 * True when an invoice can't be acted on in the current PayPal mode: demo invoices
 * while real PayPal is connected, or real PayPal invoices while in demo mode.
 */
export const notOnCurrentPaypal = (inv) => Boolean(inv?.paypalId) && (isMock() ? !isMockId(inv) : isMockId(inv));
