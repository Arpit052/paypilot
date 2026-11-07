// Early-pay discount: "Pay within 48 hours and get 2% off."
// The invoice goes out with a PayPal invoice-level discount. If it's paid inside the window
// the client keeps the discount; if not, PayPilot removes the discount on PayPal (a full
// update, which also re-sends the invoice) and the normal due date applies. The owner
// switched this on when approving the invoice, and the invoice note tells the client.
//
// The suggested percentage follows the client's history: there's no point paying a client
// who already pays on time, and a late payer is worth a slightly bigger nudge.
import { config, isoDate, cents } from './config.js';
import { kvGet, kvSet, kvList, getInvoice, updateInvoice, logActivity } from './db.js';
import { clientStats, isOpen } from './analytics.js';
import { paypal, notOnCurrentPaypal } from './paypal.js';
import { notify } from './notify.js';

const r2 = (n) => cents(n);
export const EARLY_HOURS = 48;

/** Suggested discount for a client (0 = don't bother). */
export function suggestEarlyPay(clientId, total) {
  if (!(total >= 150)) return { percent: 0, reason: 'Small invoices are not worth discounting.' };
  const st = clientId ? clientStats(clientId) : { riskLabel: 'new', avgDaysLate: null };
  if (st.riskLabel === 'high') return { percent: 3, reason: `Usually pays about ${st.avgDaysLate} days late, so a bigger nudge is worth it.` };
  if (st.riskLabel === 'medium') return { percent: 2, reason: `Often pays a few days late (about ${st.avgDaysLate}).` };
  if (st.riskLabel === 'new') return { percent: 2, reason: 'A new client: a small incentive sets a good habit.' };
  return { percent: 0, reason: 'Already pays on time, so a discount would only cost you money.' };
}

/** Discount amount on the pre-tax subtotal, and the window end. */
export function earlyPayTerms(subtotal, percent, from = new Date()) {
  const p = Math.min(10, Math.max(0, Number(percent) || 0));
  return { percent: p, amount: r2((subtotal * p) / 100), until: new Date(from.getTime() + EARLY_HOURS * 3600e3).toISOString() };
}

export function noteLineFor({ amount, until, currency, fullTotal, dueDate }) {
  const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v);
  const when = new Date(until).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: config.timezone || 'UTC', timeZoneName: 'short' });
  const due = new Date(`${dueDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `Early-pay offer: pay by ${when} and keep the ${fmt(amount)} discount already applied. After that the full ${fmt(fullTotal)} applies, due ${due}.`;
}

export function saveEarlyPay(invoiceId, data) {
  kvSet(`earlypay:${invoiceId}`, { status: 'active', ...data });
}
export const getEarlyPay = (invoiceId) => kvGet(`earlypay:${invoiceId}`);

/** Close finished windows: paid in time -> "used"; still open after the window -> discount removed. */
export async function settleEarlyPay(now = new Date()) {
  const done = [];
  for (const { key, value: e } of kvList('earlypay:')) {
    if (!e || e.status !== 'active') continue;
    const id = key.slice('earlypay:'.length);
    const inv = getInvoice(id);
    if (!inv) continue;
    if (['PAID', 'MARKED_AS_PAID'].includes(inv.status)) {
      kvSet(key, { ...e, status: 'used', closedAt: now.toISOString() });
      if (inv.paidDate && inv.paidDate <= e.until.slice(0, 10)) {
        logActivity('earlypay_used', `Invoice #${inv.number} was paid early; the client kept the ${e.percent}% discount`);
        notify({ kind: 'payment', title: 'Paid early', body: `Invoice #${inv.number} was paid inside the early-pay window. The ${e.percent}% discount worked.`, link: '/dashboard', invoiceId: id });
      }
      done.push({ id, status: 'used' });
      continue;
    }
    if (!isOpen(inv) || new Date(e.until) > now) continue;
    if (inv.status === 'PARTIALLY_PAID') continue; // leave a part-paid invoice alone
    try {
      if (inv.paypalId && !notOnCurrentPaypal(inv)) await paypal.removeDiscount(inv.paypalId, { requestId: `ep-${id}` });
      updateInvoice(id, { total: e.fullTotal });
      kvSet(key, { ...e, status: 'expired', closedAt: now.toISOString() });
      logActivity('earlypay_expired', `Early-pay window ended on invoice #${inv.number}; total is back to ${inv.currency} ${e.fullTotal}`);
      notify({ kind: 'overdue', title: 'Early-pay offer ended', body: `Invoice #${inv.number} wasn't paid in time, so the ${e.percent}% discount was removed on PayPal. The full amount is due ${inv.dueDate}.`, link: '/dashboard', invoiceId: id });
      done.push({ id, status: 'expired' });
    } catch (err) {
      kvSet(key, { ...e, tries: (e.tries || 0) + 1, lastError: err.message });
      if ((e.tries || 0) + 1 === 3) notify({ kind: 'approval', title: 'Could not end an early-pay offer', body: `PayPal refused to remove the discount on invoice #${inv.number}: ${err.message}`, link: '/dashboard', invoiceId: id });
    }
  }
  return done;
}

export const todayIso = isoDate;
