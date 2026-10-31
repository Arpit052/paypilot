// Human-in-the-loop: the AI only *proposes* actions that move money or contact
// clients. Nothing reaches PayPal until the user approves the action card.
import { config, isoDate, addDays } from './config.js';
import { db, save, newId, logActivity, upsertClient, findInvoice } from './db.js';
import { paypal, PayPalError } from './paypal.js';
import { invoiceTotal, isOpen } from './analytics.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function createAction(type, payload, { origin = 'chat', summary } = {}) {
  const a = {
    id: newId('act'),
    type,
    status: 'pending',
    origin,
    summary,
    payload,
    createdAt: new Date().toISOString(),
  };
  db().actions.unshift(a);
  save();
  return a;
}

export function listActions({ status, origin, type } = {}) {
  return db().actions.filter(
    (a) => (!status || a.status === status) && (!origin || a.origin === origin) && (!type || a.type === type)
  );
}

export function getAction(id) {
  return db().actions.find((a) => a.id === id) || null;
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
    const inv = {
      id: newId('inv'),
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
    };
    db().invoices.unshift(inv);
    save();
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
    inv.reminders.push({ at: isoDate(), subject, tone: payload.tone || 'friendly' });
    save();
    logActivity('reminder_sent', `Reminder (${payload.tone || 'friendly'}) sent for invoice #${inv.number}`);
    return { number: inv.number, remindersSent: inv.reminders.length };
  },

  async cancel_invoice(payload) {
    const inv = findInvoice(payload.invoiceId);
    if (!inv) throw new Error('Invoice not found');
    if (!isOpen(inv)) throw new Error(`Invoice #${inv.number} is ${inv.status}; cannot cancel`);
    await paypal.cancel(inv.paypalId, {
      subject: `Invoice #${inv.number} cancelled`,
      note: payload.reason || 'This invoice has been cancelled.',
    });
    inv.status = 'CANCELLED';
    save();
    logActivity('invoice_cancelled', `Invoice #${inv.number} cancelled`);
    return { number: inv.number, status: 'CANCELLED' };
  },
};

/** Approve (optionally with user edits) and execute against PayPal. */
export async function approveAction(id, edits) {
  const a = getAction(id);
  if (!a) throw Object.assign(new Error('Action not found'), { status: 404 });
  if (a.status !== 'pending') throw Object.assign(new Error(`Action already ${a.status}`), { status: 409 });
  const payload = edits && typeof edits === 'object' ? { ...a.payload, ...edits } : a.payload;
  a.status = 'executing';
  save();
  try {
    const result = await executors[a.type](payload);
    a.payload = payload;
    a.status = 'approved';
    a.result = result;
    a.error = null;
    a.decidedAt = new Date().toISOString();
    save();
    return a;
  } catch (e) {
    // keep it pending so the user can fix & retry
    a.status = 'pending';
    a.error = e.message;
    save();
    const status = e instanceof PayPalError ? (e.status < 500 ? 400 : 502) : e instanceof TypeError ? 502 : 400;
    throw Object.assign(new Error(e.message), { status });
  }
}

export function rejectAction(id) {
  const a = getAction(id);
  if (!a) throw Object.assign(new Error('Action not found'), { status: 404 });
  if (a.status !== 'pending') throw Object.assign(new Error(`Action already ${a.status}`), { status: 409 });
  a.status = 'rejected';
  a.decidedAt = new Date().toISOString();
  save();
  return a;
}
