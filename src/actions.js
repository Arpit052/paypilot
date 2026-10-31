// Human-in-the-loop: the AI only *proposes* actions that move money or contact
// clients. Nothing reaches PayPal until the user approves the action card.
import { config, isoDate, addDays } from './config.js';
import { logActivity, upsertClient, findInvoice, insertInvoice, updateInvoice, insertAction, getAction as dbGetAction, listActions as dbListActions, updateAction, transitionAction } from './db.js';
import { paypal, PayPalError } from './paypal.js';
import { invoiceTotal, isOpen } from './analytics.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function createAction(type, payload, { origin = 'chat', summary } = {}) {
  return insertAction({ type, origin, summary, payload });
}

export function listActions(filter = {}) {
  return dbListActions(filter);
}

export function getAction(id) {
  return dbGetAction(id);
}

/** Normalise + validate an invoice draft. Throws on bad input. Shared by the AI tool and the approve step. */
export function normaliseInvoiceDraft(d) {
  const clientName = String(d.clientName || '').trim();
  const clientEmail = String(d.clientEmail || '').trim();
  if (!clientName) throw new Error('Client name is required');
  if (!EMAIL_RE.test(clientEmail)) throw new Error('A valid client email is required');
  const items = (d.items || [])
    .map((it) => ({
      name: String(it.name || '').trim(),
      quantity: Number(it.quantity ?? 1),
      unitPrice: Number(it.unitPrice ?? it.unit_price),
    }))
    .filter((it) => it.name);
  if (!items.length) throw new Error('At least one line item is required');
  for (const it of items) {
    if (!(it.quantity > 0)) throw new Error(`Quantity for "${it.name}" must be positive`);
    if (!(it.unitPrice > 0)) throw new Error(`Price for "${it.name}" must be positive`);
  }
  const today = isoDate();
  let dueDate = d.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(d.dueDate) ? d.dueDate : addDays(today, Number(d.dueInDays ?? 7));
  if (dueDate < today) dueDate = today;
  return {
    clientName,
    clientEmail,
    items,
    currency: String(d.currency || config.currency).toUpperCase(),
    dueDate,
    note: String(d.note || '').trim(),
    total: invoiceTotal(items),
  };
}

const executors = {
  async create_invoice(payload) {
    const draft = normaliseInvoiceDraft(payload);
    const client = upsertClient({ name: draft.clientName, email: draft.clientEmail });
    const pp = await paypal.createAndSendInvoice({
      client,
      items: draft.items,
      currency: draft.currency,
      dueDate: draft.dueDate,
      note: draft.note,
    });
    const inv = insertInvoice({
      paypalId: pp.paypalId,
      number: pp.number,
      clientId: client.id,
      items: draft.items,
      currency: draft.currency,
      total: draft.total,
      status: pp.status,
      issueDate: pp.issueDate || isoDate(),
      dueDate: draft.dueDate,
      paidDate: null,
      note: draft.note,
      payerUrl: pp.payerUrl,
      reminders: [],
      source: 'paypal',
    });
    logActivity('invoice_sent', `Invoice #${inv.number} for ${draft.currency} ${draft.total} sent to ${client.name}`);
    return { invoiceId: inv.id, number: inv.number, paypalId: inv.paypalId, payerUrl: inv.payerUrl };
  },

  async send_reminder(payload) {
    const inv = findInvoice(payload.invoiceId);
    if (!inv) throw new Error('Invoice not found');
    if (!isOpen(inv)) throw new Error(`Invoice #${inv.number} is ${inv.status}; no reminder needed`);
    const subject = String(payload.subject || '').trim() || `Reminder: invoice #${inv.number}`;
    const message = String(payload.message || '').trim();
    if (!message) throw new Error('Reminder message is empty');
    await paypal.remind(inv.paypalId, { subject, note: message });
    const reminders = [...inv.reminders, { at: isoDate(), subject, tone: payload.tone || 'friendly' }];
    updateInvoice(inv.id, { reminders });
    logActivity('reminder_sent', `Reminder (${payload.tone || 'friendly'}) sent for invoice #${inv.number}`);
    return { number: inv.number, remindersSent: reminders.length };
  },

  async cancel_invoice(payload) {
    const inv = findInvoice(payload.invoiceId);
    if (!inv) throw new Error('Invoice not found');
    if (!isOpen(inv)) throw new Error(`Invoice #${inv.number} is ${inv.status}; cannot cancel`);
    await paypal.cancel(inv.paypalId, {
      subject: `Invoice #${inv.number} cancelled`,
      note: payload.reason || 'This invoice has been cancelled.',
    });
    updateInvoice(inv.id, { status: 'CANCELLED' });
    logActivity('invoice_cancelled', `Invoice #${inv.number} cancelled`);
    return { number: inv.number, status: 'CANCELLED' };
  },
};

/** Approve (optionally with user edits) and execute against PayPal. */
export async function approveAction(id, edits) {
  const a = getAction(id);
  if (!a) throw Object.assign(new Error('Action not found'), { status: 404 });
  // atomic claim: a double-click can never execute the same action twice
  if (!transitionAction(id, 'pending', 'executing')) throw Object.assign(new Error(`Action already ${a.status}`), { status: 409 });
  const payload = edits && typeof edits === 'object' ? { ...a.payload, ...edits } : a.payload;
  try {
    const result = await executors[a.type](payload);
    return updateAction(id, { payload, status: 'approved', result, error: null, decidedAt: new Date().toISOString() });
  } catch (e) {
    // back to pending so the user can fix & retry
    updateAction(id, { status: 'pending', error: e.message });
    const status = e instanceof PayPalError ? (e.status < 500 ? 400 : 502) : e instanceof TypeError ? 502 : 400;
    throw Object.assign(new Error(e.message), { status });
  }
}

export function rejectAction(id) {
  const a = getAction(id);
  if (!a) throw Object.assign(new Error('Action not found'), { status: 404 });
  if (!transitionAction(id, 'pending', 'rejected')) throw Object.assign(new Error(`Action already ${a.status}`), { status: 409 });
  return updateAction(id, { decidedAt: new Date().toISOString() });
}
