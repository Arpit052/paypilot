// Keeps local invoice state in sync with PayPal: polling + webhooks.
import { isoDate } from './config.js';
import { listInvoices, getInvoiceByPaypalId, updateInvoice, logActivity, upsertClient, findClient, insertInvoice, kvGet } from './db.js';
import { paypal, notOnCurrentPaypal, isMock } from './paypal.js';
import { isOpen, clientName } from './analytics.js';
import { notify } from './notify.js';

function applyStatus(inv, status, paidDate) {
  if (!status || status === inv.status) return false;
  const was = inv.status;
  const who = clientName(inv.clientId);
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: inv.currency }).format(inv.total);
  if (['PAID', 'MARKED_AS_PAID'].includes(status)) {
    updateInvoice(inv.id, { status, paidDate: paidDate || isoDate() });
    logActivity('invoice_paid', `💰 ${who} paid invoice #${inv.number} (${inv.currency} ${inv.total})`);
    notify({ kind: 'payment', title: `Payment received: ${amount}`, body: `${who} paid invoice #${inv.number}.`, link: '/dashboard', invoiceId: inv.id });
  } else if (status === 'PARTIALLY_PAID') {
    updateInvoice(inv.id, { status });
    logActivity('status', `${who} made a partial payment on invoice #${inv.number}`);
    notify({ kind: 'payment', title: 'Deposit received', body: `${who} made a partial payment on invoice #${inv.number} (${amount} total).`, link: '/dashboard', invoiceId: inv.id });
  } else {
    updateInvoice(inv.id, { status });
    logActivity('status', `Invoice #${inv.number}: ${was} → ${status}`);
  }
  return true;
}

const SKIP_ON_IMPORT = new Set(['DRAFT', 'SCHEDULED', 'CANCELLED']);
const num = (m) => Math.round(Number(m?.value || 0) * 100) / 100;

/** Turn a full PayPal invoice into PayPilot's shape (plus the recipient for the client record). */
export function fromPaypalInvoice(raw) {
  const d = raw.detail || {};
  const bill = raw.primary_recipients?.[0]?.billing_info || {};
  const n = bill.name || {};
  const name = n.full_name || [n.given_name, n.surname].filter(Boolean).join(' ') || bill.business_name || bill.email_address || 'PayPal customer';
  const items = (raw.items || []).map((it) => ({
    name: String(it.name || 'Item').slice(0, 200),
    quantity: Number(it.quantity) || 1,
    unitPrice: num(it.unit_amount),
  }));
  const taxPercent = Number(raw.items?.find((it) => it.tax?.percent)?.tax?.percent) || 0;
  const total = num(raw.amount) || items.reduce((t, it) => t + it.quantity * it.unitPrice, 0);
  if (!items.length) items.push({ name: 'Invoice total', quantity: 1, unitPrice: total });
  const tx = raw.payments?.transactions;
  const paidDate = Array.isArray(tx) && tx.length ? String(tx.at(-1).payment_date || '').slice(0, 10) || null : null;
  const created = String(d.metadata?.create_time || '').slice(0, 10);
  const issueDate = d.invoice_date || created || isoDate();
  return {
    client: { name: String(name).slice(0, 120), email: bill.email_address || '', company: bill.business_name || '' },
    invoice: {
      paypalId: raw.id,
      number: d.invoice_number || raw.id,
      items,
      currency: d.currency_code || raw.amount?.currency_code || 'USD',
      total,
      status: raw.status,
      issueDate,
      dueDate: d.payment_term?.due_date || issueDate,
      paidDate: ['PAID', 'MARKED_AS_PAID'].includes(raw.status) ? paidDate || issueDate : null,
      note: d.note || '',
      payerUrl: d.metadata?.recipient_view_url || (raw.links || []).find((l) => l.rel === 'payer-view')?.href || null,
      taxPercent,
      depositAmount: num(raw.configuration?.partial_payment?.minimum_amount_due),
      reference: d.reference || '',
      source: 'import',
    },
  };
}

let lastImportAt = 0;

/**
 * Bring in invoices that were created directly on PayPal (website, app, other tools),
 * so PayPilot tracks them too. Real PayPal only.
 */
export async function importFromPaypal({ max = 300 } = {}) {
  if (isMock()) return { imported: 0 };
  lastImportAt = Date.now();
  const list = await paypal.listInvoices({ max });
  const hidden = new Set((kvGet('hidden:emails') || []).map((e) => e.toLowerCase()));
  const fresh = list.filter(
    (x) => x.id && !SKIP_ON_IMPORT.has(x.status) && !getInvoiceByPaypalId(x.id) && !hidden.has(String(x.primary_recipients?.[0]?.billing_info?.email_address || '').toLowerCase())
  );
  let imported = 0;
  const errors = [];
  for (const entry of fresh.slice(0, 50)) {
    try {
      const { raw } = await paypal.getInvoice(entry.id);
      const { client, invoice } = fromPaypalInvoice(raw || entry);
      if (!client.email) continue; // nothing to bill or remind without an email
      const c = findClient(client.email) || upsertClient(client);
      insertInvoice({ ...invoice, clientId: c.id, reminders: [] });
      imported++;
    } catch (e) {
      errors.push(`${entry.id}: ${e.message}`);
    }
  }
  if (imported) {
    logActivity('imported', `Imported ${imported} invoice${imported > 1 ? 's' : ''} created on PayPal`);
    notify({ kind: 'import', title: `${imported} invoice${imported > 1 ? 's' : ''} imported from PayPal`, body: 'Invoices you created on PayPal are now tracked in PayPilot too.', link: '/dashboard' });
  }
  return { imported, errors };
}

/** Import at most every few minutes (used by the background payment watcher). */
export function importIfStale(minutes = 10) {
  if (Date.now() - lastImportAt < minutes * 60000) return Promise.resolve({ imported: 0, skipped: true });
  return importFromPaypal();
}

export const syncState = { lastAt: null };

/** Poll PayPal for every open invoice. Returns number of invoices that changed. */
export async function syncInvoices() {
  syncState.lastAt = new Date().toISOString();
  const open = listInvoices().filter((i) => i.paypalId && i.source !== 'seed' && !notOnCurrentPaypal(i) && isOpen(i)).slice(0, 50);
  let changed = 0;
  const errors = [];
  for (const inv of open) {
    try {
      const r = await paypal.getInvoice(inv.paypalId);
      if (r.payerUrl && !inv.payerUrl) updateInvoice(inv.id, { payerUrl: r.payerUrl });
      if (applyStatus(inv, r.status, r.paidDate)) changed++;
    } catch (e) {
      errors.push(`#${inv.number}: ${e.message}`);
    }
  }
  return { checked: open.length, changed, errors };
}

/** Handle a (verified) PayPal webhook event. */
export function applyWebhookEvent(event) {
  const type = event?.event_type || '';
  if (!type.startsWith('INVOICING.INVOICE.')) return { ignored: true, type };
  const res = event.resource?.invoice || event.resource || {};
  const inv = res.id ? getInvoiceByPaypalId(res.id) : null;
  if (!inv) return { ignored: true, reason: 'unknown invoice', type };
  let status = res.status;
  if (type === 'INVOICING.INVOICE.PAID') status ||= 'PAID';
  if (type === 'INVOICING.INVOICE.CANCELLED') status ||= 'CANCELLED';
  const tx = res.payments?.transactions;
  const paidDate = Array.isArray(tx) && tx.length ? String(tx.at(-1).payment_date || '').slice(0, 10) : null;
  const changed = applyStatus(inv, status, paidDate);
  return { ok: true, type, invoice: inv.number, changed };
}
