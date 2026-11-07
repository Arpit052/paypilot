// Human-in-the-loop: the AI only *proposes* actions that move money or contact
// clients. Nothing reaches PayPal until the user approves the action card.
import { config, isoDate, addDays, cents } from './config.js';
import { logActivity, upsertClient, findInvoice, insertInvoice, updateInvoice, insertAction, insertSchedule, getAction as dbGetAction, listActions as dbListActions, updateAction, transitionAction, kvSet, kvGet } from './db.js';
import { paypal, PayPalError, friendlyPaypalError, notOnCurrentPaypal, isMock } from './paypal.js';
import { invoiceTotals, isOpen } from './analytics.js';
import { cleanWorkUrl, newToken, attachDelivery, unlockLink, noteLine as deliveryNote } from './delivery.js';
import { earlyPayTerms, noteLineFor as earlyNote, saveEarlyPay } from './earlypay.js';

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

const round2 = (n) => cents(n);

/** AI models sometimes return "\\n" as text instead of a line break. Turn those into real breaks. */
export function cleanText(t) {
  return String(t || '')
    .replace(/\\r\\n|\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

/** Shared validation for client + line items (invoices and recurring schedules). */
function notOnPaypalMessage(inv) {
  return isMock()
    ? `Invoice #${inv.number} lives on your real PayPal account, but PayPilot is in demo mode. Reconnect PayPal in Settings to manage it.`
    : `Invoice #${inv.number} is demo data and isn't on PayPal, so it can't be changed there.`;
}

function normaliseLines(d) {
  const clientName = String(d.clientName || '').trim();
  const clientEmail = String(d.clientEmail || '').trim();
  if (!clientName) throw invalid('Client name is required');
  if (!EMAIL_RE.test(clientEmail)) throw invalid('A valid client email is required');
  const items = (d.items || [])
    .map((it) => ({
      name: String(it.name || '').trim().slice(0, 200),
      quantity: Number(it.quantity ?? 1),
      unitPrice: round2(Number(it.unitPrice ?? it.unit_price)),
    }))
    .filter((it) => it.name);
  if (!items.length) throw invalid('At least one line item is required');
  if (items.length > 100) throw invalid('An invoice can have at most 100 line items');
  for (const it of items) {
    if (!(it.quantity > 0) || !Number.isFinite(it.quantity)) throw invalid(`Quantity for "${it.name}" must be a positive number`);
    if (!(it.unitPrice > 0) || !Number.isFinite(it.unitPrice)) throw invalid(`Price for "${it.name}" must be a positive amount`);
    if (it.quantity > 1e6 || it.unitPrice * it.quantity > 9999999.99) throw invalid(`"${it.name}" is too large for one invoice line`);
  }
  const taxPercent = round2(Number(d.taxPercent ?? d.tax_percent ?? config.defaultTaxPercent) || 0);
  if (taxPercent < 0 || taxPercent > 50) throw invalid('Sales tax must be between 0% and 50%');
  const currency = String(d.currency || config.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw invalid('Currency must be a 3-letter code like USD');
  if (!config.paypalCurrencies.includes(currency))
    throw invalid(`PayPal invoices can't be in ${currency}. Choose a currency PayPal supports, such as USD, EUR or GBP. Your client still pays from their own account.`);
  const company = String(d.company || '').trim().slice(0, 120);
  return { clientName, clientEmail, company, items, taxPercent, currency, note: String(d.note === undefined ? config.defaultNote || '' : d.note || '').trim().slice(0, 4000) };
}

/** Normalise + validate an invoice draft. Throws on bad input. Shared by the AI tool and the approve step. */
export function normaliseInvoiceDraft(d) {
  const base = normaliseLines(d);
  const today = isoDate();
  const isDate = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  let issueDate = isDate(d.issueDate) ? d.issueDate : today;
  if (issueDate > today) throw invalid('Issue date cannot be in the future');
  let dueDate = isDate(d.dueDate) ? d.dueDate : addDays(today, Number(d.dueInDays ?? config.defaultTermsDays ?? 7));
  if (dueDate < today) dueDate = today;
  if (dueDate < issueDate) throw invalid('Due date must be on or after the issue date');
  const reference = String(d.reference || '').trim().slice(0, 120);
  const { subtotal, tax, total } = invoiceTotals(base.items, base.taxPercent);
  // Deposit (PayPal partial payment): absolute amount, or a percentage of the total.
  let depositAmount = Number(d.depositAmount ?? 0) || 0;
  const depositPercent = Number(d.depositPercent ?? d.deposit_percent ?? 0) || 0;
  if (!depositAmount && depositPercent > 0) depositAmount = round2((total * Math.min(depositPercent, 95)) / 100);
  depositAmount = round2(depositAmount);
  if (depositAmount < 0) throw invalid('Deposit cannot be negative');
  if (depositAmount >= total) throw invalid('Deposit must be less than the invoice total');
  // pay to unlock: the final work, shown to the client only once this invoice is paid
  const deliveryUrl = cleanWorkUrl(d.deliveryUrl ?? d.delivery_url ?? '');
  // early-pay discount (percent off the subtotal if paid within 48 hours)
  const earlyPayPercent = Math.min(10, Math.max(0, round2(Number(d.earlyPayPercent ?? d.early_pay_percent ?? 0) || 0)));
  if (earlyPayPercent && depositAmount) throw invalid('Use either a deposit or an early-pay discount on one invoice, not both');
  return {
    ...base,
    issueDate,
    dueDate,
    reference,
    subtotal,
    tax,
    total,
    depositAmount,
    depositSuggested: Boolean(d.depositSuggested) && depositAmount > 0,
    deliveryUrl,
    deliveryLabel: String(d.deliveryLabel || '').trim().slice(0, 80),
    earlyPayPercent,
    earlyPayAmount: earlyPayPercent ? round2((subtotal * earlyPayPercent) / 100) : 0,
  };
}

/** Normalise + validate a recurring schedule. */
export function normaliseScheduleDraft(d) {
  const base = normaliseLines(d);
  const frequency = String(d.frequency || 'monthly').toLowerCase();
  if (!['weekly', 'monthly'].includes(frequency)) throw invalid('Frequency must be weekly or monthly');
  const today = isoDate();
  let startDate = d.startDate && /^\d{4}-\d{2}-\d{2}$/.test(d.startDate) ? d.startDate : today;
  if (startDate < today) startDate = today;
  const dueInDays = Math.min(Math.max(Math.round(Number(d.dueInDays ?? config.defaultTermsDays ?? 7)), 0), 90);
  const { total } = invoiceTotals(base.items, base.taxPercent);
  return { ...base, frequency, startDate, dueInDays, total };
}

export const hasLateFee = (inv) => (inv.items || []).some((it) => it.lateFee);

/** Build the payload for a late-fee approval slip (used by follow-ups and the assistant). */
export function lateFeeDraft(inv, { percent = config.lateFeePercent, clientName = '', daysOverdue = 0 } = {}) {
  const pct = round2(Number(percent));
  if (!(pct > 0 && pct <= 25)) throw invalid('Late fee must be between 0.5% and 25%');
  const fee = round2((inv.total * pct) / 100);
  return { invoiceId: inv.id, number: inv.number, client: clientName, amount: inv.total, currency: inv.currency, dueDate: inv.dueDate, daysOverdue, percent: pct, fee, newTotal: round2(inv.total + fee) };
}

const executors = {
  async create_invoice(payload, requestId) {
    const draft = normaliseInvoiceDraft(payload);
    const client = upsertClient({ name: draft.clientName, email: draft.clientEmail, company: draft.company });
    // the token is fixed per approval, so a retry puts the same unlock link in the note
    const token = draft.deliveryUrl ? kvGet(`dtok-for:${requestId}`) || newToken() : null;
    if (token && requestId) kvSet(`dtok-for:${requestId}`, token);
    const ep = draft.earlyPayPercent ? earlyPayTerms(draft.subtotal, draft.earlyPayPercent) : null;
    const fullTotal = draft.total;
    const notes = [draft.note];
    if (ep) notes.push(earlyNote({ amount: ep.amount, until: ep.until, currency: draft.currency, fullTotal, dueDate: draft.dueDate }));
    if (token) notes.push(deliveryNote(token));
    const note = notes.filter(Boolean).join('\n\n');
    const pp = await paypal.createAndSendInvoice({
      client,
      issueDate: draft.issueDate < isoDate() ? draft.issueDate : undefined, // today -> let PayPal default it
      reference: draft.reference,
      items: draft.items,
      currency: draft.currency,
      dueDate: draft.dueDate,
      note,
      taxPercent: draft.taxPercent,
      depositAmount: draft.depositAmount,
      discountAmount: ep ? ep.amount : 0,
      requestId,
    });
    const discounted = ep && !pp.discountRefused;
    // local total after the discount (tax is charged on the discounted subtotal)
    const afterDiscount = discounted ? round2(fullTotal - ep.amount - (draft.taxPercent ? round2((ep.amount * draft.taxPercent) / 100) : 0)) : fullTotal;
    const inv = insertInvoice({
      paypalId: pp.paypalId,
      number: pp.number,
      clientId: client.id,
      items: draft.items,
      currency: draft.currency,
      total: pp.total || afterDiscount, // PayPal's own total wins if it computed one
      status: pp.status,
      issueDate: draft.issueDate || pp.issueDate || isoDate(),
      dueDate: draft.dueDate,
      paidDate: null,
      note,
      payerUrl: pp.payerUrl,
      reminders: [],
      source: 'paypal',
      taxPercent: draft.taxPercent,
      depositAmount: draft.depositAmount,
      reference: draft.reference,
    });
    if (token) attachDelivery(inv.id, { url: draft.deliveryUrl, label: draft.deliveryLabel, token });
    if (discounted) saveEarlyPay(inv.id, { percent: ep.percent, amount: ep.amount, until: ep.until, fullTotal, discountedTotal: inv.total });
    logActivity(
      'invoice_sent',
      `Invoice #${inv.number} for ${draft.currency} ${inv.total} sent to ${client.name}${draft.depositAmount ? ` (deposit ${draft.currency} ${draft.depositAmount} due upfront)` : ''}${discounted ? ` with a ${ep.percent}% early-pay discount for 48 hours` : ''}${token ? ', final files locked until paid' : ''}`
    );
    return {
      invoiceId: inv.id,
      number: inv.number,
      paypalId: inv.paypalId,
      payerUrl: inv.payerUrl,
      ...(token ? { unlockLink: unlockLink(token) } : {}),
      ...(ep && pp.discountRefused ? { notice: "PayPal didn't accept the early-pay discount on this account, so the invoice went out at the full price." } : {}),
      ...(pp.depositAsNote
        ? { notice: `Your PayPal account's country doesn't support split payments, so the ${draft.currency} ${draft.depositAmount} deposit was added to the invoice as a note. The client pays the full amount through PayPal.` }
        : {}),
    };
  },

  async send_reminder(payload, requestId) {
    const inv = findInvoice(payload.invoiceId);
    if (!inv) throw new Error('Invoice not found');
    if (!isOpen(inv)) throw new Error(`Invoice #${inv.number} is ${inv.status}; no reminder needed`);
    if (notOnCurrentPaypal(inv)) throw invalid(notOnPaypalMessage(inv));
    const subject = cleanText(payload.subject) || `Reminder: invoice #${inv.number}`;
    const message = cleanText(payload.message);
    if (!message) throw new Error('Reminder message is empty');
    await paypal.remind(inv.paypalId, { subject, note: message, requestId });
    const reminders = [...inv.reminders, { at: isoDate(), subject, tone: payload.tone || 'friendly' }];
    updateInvoice(inv.id, { reminders });
    logActivity('reminder_sent', `Reminder (${payload.tone || 'friendly'}) sent for invoice #${inv.number}`);
    return { number: inv.number, remindersSent: reminders.length };
  },

  async cancel_invoice(payload, requestId) {
    const inv = findInvoice(payload.invoiceId);
    if (!inv) throw new Error('Invoice not found');
    if (!isOpen(inv)) throw new Error(`Invoice #${inv.number} is ${inv.status}; cannot cancel`);
    if (notOnCurrentPaypal(inv)) throw invalid(notOnPaypalMessage(inv));
    await paypal.cancel(inv.paypalId, {
      subject: `Invoice #${inv.number} cancelled`,
      note: payload.reason || 'This invoice has been cancelled.',
      requestId,
    });
    updateInvoice(inv.id, { status: 'CANCELLED' });
    logActivity('invoice_cancelled', `Invoice #${inv.number} cancelled`);
    return { number: inv.number, status: 'CANCELLED' };
  },

  async add_late_fee(payload, requestId) {
    const inv = findInvoice(payload.invoiceId);
    if (!inv) throw new Error('Invoice not found');
    if (!isOpen(inv)) throw invalid(`Invoice #${inv.number} is ${inv.status}; no late fee needed`);
    if (notOnCurrentPaypal(inv)) throw invalid(notOnPaypalMessage(inv));
    if (hasLateFee(inv)) throw invalid(`Invoice #${inv.number} already has a late fee`);
    const d = lateFeeDraft(inv, { percent: payload.percent });
    const name = `Late fee (${d.percent}%)`;
    const r = await paypal.addLateFee(inv.paypalId, { name, amount: d.fee, currency: inv.currency, requestId });
    const items = [...inv.items, { name, quantity: 1, unitPrice: d.fee, lateFee: true, noTax: true, addedAt: isoDate() }];
    const total = r.total || d.newTotal;
    updateInvoice(inv.id, { items, total });
    logActivity('late_fee', `Late fee of ${inv.currency} ${d.fee} added to invoice #${inv.number} (new total ${inv.currency} ${total})`);
    return { number: inv.number, fee: d.fee, newTotal: total };
  },

  // Recurring invoices: approving stores the schedule only. Each time it comes due, the
  // scheduler creates a normal invoice *draft* that still needs approval - nothing auto-sends.
  async create_schedule(payload) {
    const d = normaliseScheduleDraft(payload);
    const client = upsertClient({ name: d.clientName, email: d.clientEmail });
    const sc = insertSchedule({
      clientId: client.id,
      items: d.items,
      currency: d.currency,
      taxPercent: d.taxPercent,
      frequency: d.frequency,
      nextRun: d.startDate,
      dueInDays: d.dueInDays,
      note: d.note,
    });
    logActivity('schedule_created', `Recurring ${d.frequency} invoice set up for ${client.name} (${d.currency} ${d.total}), first invoice ${d.startDate}`);
    // starts today -> create the first draft right away so the user sees it in the tray
    let firstDraft = null;
    if (d.startDate <= isoDate()) {
      const { runRecurring } = await import('./recurring.js');
      firstDraft = runRecurring().find((x) => x.payload.scheduleId === sc.id) || null;
    }
    return { scheduleId: sc.id, nextRun: firstDraft ? null : sc.nextRun, frequency: sc.frequency, firstDraftId: firstDraft?.id || null };
  },
};

/** Approve (optionally with user edits) and execute against PayPal. */
const INVOICE_ACTIONS = new Set(['send_reminder', 'cancel_invoice', 'add_late_fee']);
const gone = (a) => INVOICE_ACTIONS.has(a.type) && !findInvoice(a.payload?.invoiceId);

/**
 * Drafts whose invoice no longer exists (e.g. demo invoices removed when PayPal was
 * connected, or after "Reset demo") are closed so they can't fail on approve.
 */
export function dropStaleActions() {
  let n = 0;
  for (const a of dbListActions({ status: 'pending' })) {
    if (!gone(a)) continue;
    updateAction(a.id, { status: 'rejected', error: 'Closed automatically: this invoice no longer exists.', decidedAt: new Date().toISOString() });
    n++;
  }
  return n;
}

const METHODS = { bank: 'BANK_TRANSFER', cash: 'CASH', check: 'CHECK', card: 'CREDIT_CARD', paypal: 'PAYPAL', other: 'OTHER' };

/**
 * You were paid outside PayPal (or PayPal didn't catch it): record it. On real PayPal the
 * payment is recorded on the invoice too, so both sides agree.
 */
export async function markPaid(invoiceId, { method = 'bank', date, note } = {}) {
  const inv = findInvoice(invoiceId);
  if (!inv) throw invalid('Invoice not found');
  if (!isOpen(inv)) throw invalid(`Invoice #${inv.number} is already ${inv.status.toLowerCase().replace(/_/g, ' ')}.`);
  const today = isoDate();
  const paidDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : today;
  if (paidDate > today) throw invalid("The payment date can't be in the future");
  if (inv.paypalId) {
    if (notOnCurrentPaypal(inv)) throw invalid(notOnPaypalMessage(inv));
    await paypal.recordPayment(inv.paypalId, { amount: inv.total, currency: inv.currency, method: METHODS[method] || 'OTHER', date: paidDate, note, requestId: `mark-${inv.id}` });
  }
  const { applyStatus } = await import('./sync.js');
  applyStatus(inv, 'MARKED_AS_PAID', paidDate);
  kvSet(`paidVia:${inv.id}`, method); // for the tax report and receipts: paid outside PayPal
  logActivity('marked_paid', `Invoice #${inv.number} marked as paid (${method})`);
  // paid outside PayPal: PayPal won't email a receipt, so remind the owner to send one
  const { notify } = await import('./notify.js');
  notify({ kind: 'payment', title: 'Receipt needed', body: `Invoice #${inv.number} was paid by ${method}. PayPal won't send a receipt for that, so send R-${inv.number} from Receipts.`, link: '/receipts', invoiceId: inv.id });
  return { number: inv.number, status: 'MARKED_AS_PAID', paidDate };
}

export async function approveAction(id, edits) {
  const a = getAction(id);
  if (!a) throw Object.assign(new Error('Action not found'), { status: 404 });
  if (a.status === 'pending' && gone(a)) {
    dropStaleActions();
    throw Object.assign(new Error('This invoice no longer exists, so the draft was closed. Refresh the page.'), { status: 410 });
  }
  // atomic claim: a double-click can never execute the same action twice
  if (!transitionAction(id, 'pending', 'executing')) throw Object.assign(new Error(`Action already ${a.status}`), { status: 409 });
  const payload = edits && typeof edits === 'object' ? { ...a.payload, ...edits } : a.payload;
  try {
    const result = await executors[a.type](payload, a.id);
    return updateAction(id, { payload, status: 'approved', result, error: null, decidedAt: new Date().toISOString() });
  } catch (e) {
    // back to pending so the user can fix & retry
    const msg = e instanceof PayPalError ? friendlyPaypalError(e) : e.message;
    if (e instanceof PayPalError) console.error(`  [action ${id}] ${e.message}`);
    updateAction(id, { status: 'pending', error: msg });
    const status = e instanceof PayPalError ? (e.status < 500 && !e.network ? 400 : 502) : e instanceof TypeError ? 502 : 400;
    throw Object.assign(new Error(msg), { status });
  }
}

export function rejectAction(id) {
  const a = getAction(id);
  if (!a) throw Object.assign(new Error('Action not found'), { status: 404 });
  if (!transitionAction(id, 'pending', 'rejected')) throw Object.assign(new Error(`Action already ${a.status}`), { status: 409 });
  return updateAction(id, { decidedAt: new Date().toISOString() });
}
