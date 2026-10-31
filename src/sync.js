// Keeps local invoice state in sync with PayPal: polling + webhooks.
import { isoDate } from './config.js';
import { listInvoices, getInvoiceByPaypalId, updateInvoice, logActivity } from './db.js';
import { paypal } from './paypal.js';
import { isOpen, clientName } from './analytics.js';

function applyStatus(inv, status, paidDate) {
  if (!status || status === inv.status) return false;
  const was = inv.status;
  if (['PAID', 'MARKED_AS_PAID'].includes(status)) {
    updateInvoice(inv.id, { status, paidDate: paidDate || isoDate() });
    logActivity('invoice_paid', `💰 ${clientName(inv.clientId)} paid invoice #${inv.number} (${inv.currency} ${inv.total})`);
  } else {
    updateInvoice(inv.id, { status });
    logActivity('status', `Invoice #${inv.number}: ${was} → ${status}`);
  }
  return true;
}

/** Poll PayPal for every open invoice. Returns number of invoices that changed. */
export async function syncInvoices() {
  const open = listInvoices().filter((i) => i.paypalId && i.source !== 'seed' && isOpen(i)).slice(0, 50);
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
