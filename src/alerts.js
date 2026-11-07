// Due-date alerts for the notification bell: "due tomorrow" and "now overdue".
// Each alert is sent once per invoice (remembered in the kv table).
import { isoDate, daysBetween } from './config.js';
import { listInvoices, getClient, kvGet, kvSet } from './db.js';
import { isOpen } from './analytics.js';
import { notOnCurrentPaypal } from './paypal.js';
import { notify } from './notify.js';

const fmt = (v, cur) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(v);

export function noteDueDates(today = isoDate()) {
  let sent = 0;
  for (const inv of listInvoices()) {
    if (!isOpen(inv) || !inv.paypalId || notOnCurrentPaypal(inv)) continue;
    const who = getClient(inv.clientId)?.name || 'A client';
    const days = daysBetween(inv.dueDate, today); // >0 late, <0 not due yet
    const amount = fmt(inv.total, inv.currency);
    if (days > 0 && !kvGet(`alert:overdue:${inv.id}`)) {
      kvSet(`alert:overdue:${inv.id}`, today);
      notify({ kind: 'overdue', title: `${who} is ${days} day${days > 1 ? 's' : ''} late`, body: `Invoice #${inv.number} · ${amount} was due ${inv.dueDate}.`, link: '/invoices', invoiceId: inv.id });
      sent++;
    } else if (days >= -1 && days <= 0 && !kvGet(`alert:due:${inv.id}`)) {
      kvSet(`alert:due:${inv.id}`, today);
      notify({ kind: 'due', title: `Invoice #${inv.number} is due ${days === 0 ? 'today' : 'tomorrow'}`, body: `${who} · ${amount}`, link: '/invoices', invoiceId: inv.id });
      sent++;
    }
  }
  return sent;
}
