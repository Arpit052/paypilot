// Business insights computed from invoice history: client risk, earnings, cash-flow forecast.
import { config, isoDate, addDays, daysBetween } from './config.js';
import { listInvoices, getClient } from './db.js';

export const OPEN_STATUSES = ['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'SCHEDULED'];
export const PAID_STATUSES = ['PAID', 'MARKED_AS_PAID'];

export const isOpen = (inv) => OPEN_STATUSES.includes(inv.status);
export const isPaid = (inv) => PAID_STATUSES.includes(inv.status);
export const isOverdue = (inv, today = isoDate()) => isOpen(inv) && inv.dueDate < today;

export function invoiceTotal(items) {
  return Math.round(items.reduce((s, it) => s + Number(it.quantity) * Number(it.unitPrice), 0) * 100) / 100;
}

/** Subtotal, sales tax (per line, like PayPal) and grand total. */
export function invoiceTotals(items, taxPercent = 0) {
  const r = (n) => Math.round(n * 100) / 100;
  let subtotal = 0;
  let tax = 0;
  for (const it of items) {
    const line = r(Number(it.quantity) * Number(it.unitPrice));
    subtotal += line;
    tax += r((line * taxPercent) / 100);
  }
  return { subtotal: r(subtotal), tax: r(tax), total: r(subtotal + tax) };
}

export function clientStats(clientId, today = isoDate()) {
  const invs = listInvoices({ clientId });
  const paid = invs.filter((i) => isPaid(i) && i.paidDate);
  const delays = paid.map((i) => Math.max(0, daysBetween(i.dueDate, i.paidDate)));
  const avgDaysLate = delays.length ? Math.round((delays.reduce((a, b) => a + b, 0) / delays.length) * 10) / 10 : null;
  const latePayments = delays.filter((d) => d > 2).length;
  const open = invs.filter(isOpen);
  const overdue = open.filter((i) => isOverdue(i, today));
  const maxOverdueDays = overdue.reduce((m, i) => Math.max(m, daysBetween(i.dueDate, today)), 0);

  let risk = 0;
  if (avgDaysLate !== null) risk += Math.min(45, avgDaysLate * 3);
  if (paid.length) risk += (latePayments / paid.length) * 25;
  risk += Math.min(40, overdue.length * 15 + maxOverdueDays);
  if (!paid.length && !overdue.length) risk = 20; // new client: unknown
  risk = Math.round(Math.min(100, risk));
  const riskLabel = risk >= 60 ? 'high' : risk >= 30 ? 'medium' : 'low';

  const sumBy = (arr) => arr.reduce((s, i) => s + i.total, 0);
  return {
    invoiceCount: invs.length,
    paidCount: paid.length,
    totalBilled: round(sumBy(invs.filter((i) => i.status !== 'CANCELLED'))),
    totalPaid: round(sumBy(invs.filter(isPaid))),
    outstanding: round(sumBy(open)),
    overdueCount: overdue.length,
    overdueAmount: round(sumBy(overdue)),
    avgDaysLate,
    latePayments,
    riskScore: risk,
    riskLabel,
    currency: invs[0]?.currency || config.currency,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function byCurrency(invs, pick = (i) => i.total) {
  const out = {};
  for (const i of invs) out[i.currency] = round((out[i.currency] || 0) + pick(i));
  return out;
}

export function earningsSummary({ from, to } = {}, today = isoDate()) {
  from ||= today.slice(0, 8) + '01';
  to ||= today;
  const all = listInvoices();
  const paidInRange = all.filter((i) => isPaid(i) && i.paidDate && i.paidDate >= from && i.paidDate <= to);
  const issuedInRange = all.filter((i) => i.status !== 'CANCELLED' && i.issueDate >= from && i.issueDate <= to);
  const open = all.filter(isOpen);
  const overdue = open.filter((i) => isOverdue(i, today));
  return {
    from,
    to,
    earned: byCurrency(paidInRange),
    paidInvoices: paidInRange.length,
    billed: byCurrency(issuedInRange),
    issuedInvoices: issuedInRange.length,
    outstanding: byCurrency(open),
    openInvoices: open.length,
    overdue: byCurrency(overdue),
    overdueInvoices: overdue.length,
  };
}

/**
 * Expected cash-in over the next `days` days. Each open invoice gets an expected
 * pay date (due date + the client's historical average delay) and a probability
 * based on the client's risk.
 */
export function forecastCashflow(days = 30, today = isoDate()) {
  const horizon = addDays(today, days);
  const rows = [];
  for (const inv of listInvoices().filter(isOpen)) {
    const st = clientStats(inv.clientId, today);
    let expected = addDays(inv.dueDate, Math.round(st.avgDaysLate ?? 3));
    let probability = { low: 0.95, medium: 0.8, high: 0.6 }[st.riskLabel];
    if (expected < today) {
      const overdueDays = daysBetween(inv.dueDate, today);
      expected = addDays(today, 7);
      probability = overdueDays > 30 ? 0.35 : overdueDays > 14 ? 0.55 : 0.7;
    }
    if (expected <= horizon) {
      rows.push({
        invoice: inv.number,
        client: clientName(inv.clientId),
        amount: inv.total,
        currency: inv.currency,
        expectedDate: expected,
        probability,
        expectedValue: round(inv.total * probability),
      });
    }
  }
  rows.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
  return {
    horizonDays: days,
    expected: byCurrency(rows, (r) => r.expectedValue),
    bestCase: byCurrency(rows, (r) => r.amount),
    invoices: rows,
  };
}

export function clientName(id) {
  return getClient(id)?.name || 'Unknown';
}

/** Data for the dashboard chart: last 6 months earned + next 4 weeks forecast (primary currency). */
export function chartSeries(today = isoDate()) {
  const cur = config.currency;
  const months = [];
  const allInvoices = listInvoices();
  const d = new Date(today + 'T00:00:00Z');
  for (let k = 5; k >= 0; k--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1));
    const key = m.toISOString().slice(0, 7);
    const label = m.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
    const value = allInvoices
      .filter((i) => isPaid(i) && i.currency === cur && i.paidDate?.startsWith(key))
      .reduce((s, i) => s + i.total, 0);
    months.push({ label, value: round(value), kind: 'actual' });
  }
  const fc = forecastCashflow(28, today);
  const weeks = [0, 1, 2, 3].map((w) => {
    const start = addDays(today, w * 7);
    const end = addDays(today, w * 7 + 6);
    const value = fc.invoices
      .filter((r) => r.currency === cur && r.expectedDate >= start && r.expectedDate <= end)
      .reduce((s, r) => s + r.expectedValue, 0);
    return { label: `Wk ${w + 1}`, value: round(value), kind: 'forecast' };
  });
  return { currency: cur, months, weeks };
}
