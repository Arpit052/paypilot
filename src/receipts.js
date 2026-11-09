// Receipts: every paid invoice gets a numbered receipt (R-<invoice number>) on a private,
// printable page. PayPal emails its own receipt when a client pays through PayPal; payments
// made outside PayPal (bank transfer, cash, cheque) need one from you, so those are tracked
// until you mark them sent. Opening the link marks the receipt as viewed.
import { config, isoDate, cents } from './config.js';
import { kvGet, kvSet, listInvoices, getInvoice, getClient, logActivity } from './db.js';
import { isPaid, invoiceTotals } from './analytics.js';
import { newToken, publicBase } from './delivery.js';
import { getEarlyPay } from './earlypay.js';
import { currentSpace } from './context.js';
import { notePublicToken } from './workspace.js';

const PAID = ['PAID', 'MARKED_AS_PAID'];
const r2 = (n) => cents(n);

/** The receipt record for a paid invoice, created on first use. */
export function ensureReceipt(inv) {
  if (!inv || !PAID.includes(inv.status)) return null;
  let r = kvGet(`receipt:${inv.id}`);
  if (!r) {
    r = { token: newToken(), number: `R-${inv.number}`, createdAt: new Date().toISOString(), sentAt: null, sentVia: null, viewedAt: null, views: 0 };
    kvSet(`receipt:${inv.id}`, r);
    kvSet(`rtoken:${r.token}`, inv.id);
    notePublicToken(currentSpace(), r.token);
  }
  return r;
}

const linkFor = (r) => `${publicBase()}/r/${r.token}`;
/** Path of the public receipt page for a paid invoice (null if unpaid). */
export const receiptPathFor = (inv) => {
  const r = ensureReceipt(inv);
  return r ? `/r/${r.token}` : null;
};
const methodOf = (inv) => (inv.status === 'MARKED_AS_PAID' ? kvGet(`paidVia:${inv.id}`) || 'outside PayPal' : 'PayPal');

/** Status of one receipt: auto (PayPal sent it), needed, sent, viewed. */
function statusOf(inv, r) {
  if (r.viewedAt) return 'viewed';
  if (r.sentAt) return 'sent';
  return inv.status === 'PAID' ? 'auto' : 'needed';
}

export function listReceipts({ year } = {}) {
  const rows = listInvoices()
    .filter((i) => isPaid(i) && i.paidDate && (!year || i.paidDate.startsWith(String(year))))
    .map((inv) => {
      const r = ensureReceipt(inv);
      const c = getClient(inv.clientId);
      return {
        invoiceId: inv.id,
        invoice: inv.number,
        receipt: r.number,
        client: c?.name || 'Unknown',
        company: c?.company || '',
        email: c?.email || '',
        amount: inv.total,
        currency: inv.currency,
        paidDate: inv.paidDate,
        via: methodOf(inv),
        status: statusOf(inv, r),
        sentAt: r.sentAt,
        sentVia: r.sentVia,
        viewedAt: r.viewedAt,
        link: linkFor(r),
        demo: inv.source === 'seed',
      };
    })
    .sort((a, b) => b.paidDate.localeCompare(a.paidDate) || Number(b.invoice) - Number(a.invoice));
  const month = isoDate().slice(0, 7);
  return {
    receipts: rows,
    summary: {
      total: rows.length,
      needed: rows.filter((x) => x.status === 'needed').length,
      sent: rows.filter((x) => ['sent', 'viewed'].includes(x.status)).length,
      viewed: rows.filter((x) => x.status === 'viewed').length,
      auto: rows.filter((x) => x.status === 'auto').length,
      thisMonth: rows.filter((x) => x.paidDate.startsWith(month)).length,
    },
  };
}

export function markReceiptSent(invoiceId, via = 'email') {
  const inv = getInvoice(invoiceId);
  const r = ensureReceipt(inv);
  if (!r) throw Object.assign(new Error('Only paid invoices have receipts'), { status: 400 });
  kvSet(`receipt:${inv.id}`, { ...r, sentAt: r.sentAt || new Date().toISOString(), sentVia: String(via).slice(0, 20) });
  logActivity('receipt_sent', `Receipt ${r.number} sent to ${getClient(inv.clientId)?.name || 'client'}`);
  return { ...r, link: linkFor(r) };
}

/** Everything the receipt page shows. `owner` previews don't count as client views. */
export function receiptView(token, { owner = false } = {}) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  const id = kvGet(`rtoken:${token}`);
  const inv = id && getInvoice(id);
  const r = id && kvGet(`receipt:${id}`);
  if (!inv || !r || r.token !== token || !PAID.includes(inv.status)) return null;
  if (!owner) kvSet(`receipt:${id}`, { ...r, viewedAt: r.viewedAt || new Date().toISOString(), views: (r.views || 0) + 1 });
  return documentFor(inv, r.number);
}

/** The receipt (or, for an unpaid invoice, a preview of it) as plain data. */
export function documentFor(inv, number = `R-${inv.number}`) {
  const c = getClient(inv.clientId);
  const t = invoiceTotals(inv.items, inv.taxPercent);
  const ep = getEarlyPay(inv.id);
  const discount = ep && ep.status !== 'expired' ? ep.amount : 0;
  return {
    receipt: number,
    invoice: inv.number,
    paid: PAID.includes(inv.status),
    paidDate: inv.paidDate,
    method: methodOf(inv),
    business: config.businessName || '',
    owner: config.ownerName || '',
    businessEmail: config.businessEmail || '',
    website: config.website || '',
    client: { name: c?.name || '', company: c?.company || '', email: c?.email || '' },
    items: inv.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, amount: r2(i.quantity * i.unitPrice) })),
    subtotal: t.subtotal,
    discount,
    tax: t.tax ? r2(t.tax - (discount && inv.taxPercent ? (discount * inv.taxPercent) / 100 : 0)) : 0,
    taxPercent: inv.taxPercent || 0,
    total: inv.total,
    currency: inv.currency,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    note: inv.note || '',
    depositAmount: inv.depositAmount || 0,
  };
}
