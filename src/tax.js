// Year-end tax summary for a US freelancer, ready to hand to an accountant.
// It is a summary of what PayPilot knows, not tax advice and not a tax form:
//   - gross income received in the year (cash basis: counted on the day it was paid)
//   - PayPal processing fees (estimated at the US invoicing rate; deductible as a business expense)
//   - sales tax collected (not income) and late fees collected
//   - income by IRS estimated-tax period, so quarterly payments line up
//   - by client, with which forms to expect: PayPal reports PayPal payments on 1099-K once you
//     pass $20,000 and 200 transactions; clients who paid you outside PayPal $2,000+ in 2026
//     ($600 before 2026) generally send a 1099-NEC
//   - a rough self-employment tax figure and the user's own set-aside from the Budget page
import { config, isoDate } from './config.js';
import { listInvoices, getClient, kvGet } from './db.js';
import { isPaid, invoiceTotals } from './analytics.js';
import { PAYPAL_FEE, budgetProfile } from './budget.js';

const r2 = (n) => Math.round(n * 100) / 100;
const NEC_THRESHOLD = (year) => (year >= 2026 ? 2000 : 600);
const K_THRESHOLD = { amount: 20000, count: 200 };
const SE_RATE = 0.153; // Social Security 12.4% + Medicare 2.9%
const SE_BASE = 0.9235; // SE tax applies to 92.35% of net earnings

// IRS estimated-tax periods for individuals (payment due dates in brackets)
const PERIODS = [
  { key: 'Q1', label: 'Jan 1 – Mar 31', months: [1, 2, 3], due: (y) => `${y}-04-15` },
  { key: 'Q2', label: 'Apr 1 – May 31', months: [4, 5], due: (y) => `${y}-06-15` },
  { key: 'Q3', label: 'Jun 1 – Aug 31', months: [6, 7, 8], due: (y) => `${y}-09-15` },
  { key: 'Q4', label: 'Sep 1 – Dec 31', months: [9, 10, 11, 12], due: (y) => `${y + 1}-01-15` },
];

export function taxYears() {
  const ys = new Set(listInvoices().filter((i) => isPaid(i) && i.paidDate).map((i) => Number(i.paidDate.slice(0, 4))));
  ys.add(Number(isoDate().slice(0, 4)));
  return [...ys].sort((a, b) => b - a);
}

export function taxReport(year = Number(isoDate().slice(0, 4))) {
  year = Number(year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw Object.assign(new Error('Pick a valid year'), { status: 400 });
  const cur = config.currency;
  const paid = listInvoices().filter((i) => isPaid(i) && i.paidDate?.startsWith(String(year)));
  const other = paid.filter((i) => i.currency !== cur);
  const rows = paid
    .filter((i) => i.currency === cur)
    .map((i) => {
      const t = invoiceTotals(i.items, i.taxPercent);
      const lateFees = r2(i.items.filter((x) => x.lateFee).reduce((s, x) => s + x.quantity * x.unitPrice, 0));
      const outside = i.status === 'MARKED_AS_PAID';
      const via = outside ? kvGet(`paidVia:${i.id}`) || 'outside PayPal' : 'PayPal';
      const fee = outside ? 0 : r2(i.total * (PAYPAL_FEE.pct / 100) + (cur === 'USD' ? PAYPAL_FEE.fixedUSD : 0));
      const c = getClient(i.clientId);
      return {
        number: i.number,
        paidDate: i.paidDate,
        client: c?.name || 'Unknown',
        company: c?.company || '',
        email: c?.email || '',
        gross: i.total,
        salesTax: r2(t.tax || 0),
        income: r2(i.total - (t.tax || 0)), // sales tax collected is owed to the state, not income
        lateFees,
        via,
        outside,
        fee,
        demo: i.source === 'seed',
      };
    })
    .sort((a, b) => a.paidDate.localeCompare(b.paidDate));

  const sum = (xs, f) => r2(xs.reduce((t, x) => t + f(x), 0));
  const gross = sum(rows, (r) => r.gross);
  const salesTax = sum(rows, (r) => r.salesTax);
  const income = sum(rows, (r) => r.income);
  const fees = sum(rows, (r) => r.fee);
  const lateFees = sum(rows, (r) => r.lateFees);
  const net = r2(income - fees);

  // by client, with the forms each is likely to produce
  const byClient = new Map();
  for (const r of rows) {
    const c = byClient.get(r.email) || { client: r.client, company: r.company, email: r.email, total: 0, viaPaypal: 0, outside: 0, invoices: 0 };
    c.total = r2(c.total + r.income);
    if (r.outside) c.outside = r2(c.outside + r.income);
    else c.viaPaypal = r2(c.viaPaypal + r.income);
    c.invoices++;
    byClient.set(r.email, c);
  }
  const nec = NEC_THRESHOLD(year);
  const clients = [...byClient.values()]
    .map((c) => ({ ...c, expect1099NEC: c.outside >= nec }))
    .sort((a, b) => b.total - a.total);

  const paypalGross = sum(rows.filter((r) => !r.outside), (r) => r.gross);
  const paypalCount = rows.filter((r) => !r.outside).length;

  const periods = PERIODS.map((p) => {
    const inP = rows.filter((r) => p.months.includes(Number(r.paidDate.slice(5, 7))));
    const pIncome = sum(inP, (r) => r.income);
    const pFees = sum(inP, (r) => r.fee);
    return { key: p.key, label: p.label, due: p.due(year), income: pIncome, fees: pFees, net: r2(pIncome - pFees), invoices: inP.length };
  });

  const seTax = r2(Math.max(0, net) * SE_BASE * SE_RATE);
  const setAsidePct = budgetProfile().taxPct || 0;

  return {
    year,
    currency: cur,
    generatedAt: new Date().toISOString(),
    business: config.businessName || '',
    owner: config.ownerName || '',
    totals: { gross, salesTax, income, lateFees, fees, net, invoices: rows.length },
    feeRate: { pct: PAYPAL_FEE.pct, fixed: cur === 'USD' ? PAYPAL_FEE.fixedUSD : 0 },
    periods,
    clients,
    forms: {
      necThreshold: nec,
      necClients: clients.filter((c) => c.expect1099NEC).map((c) => c.client),
      k: { ...K_THRESHOLD, paypalGross, paypalCount, likely: paypalGross > K_THRESHOLD.amount && paypalCount > K_THRESHOLD.count },
    },
    estimates: {
      selfEmploymentTax: seTax,
      setAsidePct,
      setAside: r2(net * (setAsidePct / 100)),
    },
    rows,
    otherCurrency: other.map((i) => ({ number: i.number, currency: i.currency, total: i.total })),
    hasDemo: rows.some((r) => r.demo),
  };
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per paid invoice, ready for a spreadsheet or an accountant. */
export function taxCsv(year) {
  const r = taxReport(year);
  const head = ['Paid date', 'Invoice', 'Client', 'Company', 'Client email', `Gross (${r.currency})`, 'Sales tax collected', 'Income', 'Late fees included', 'Paid via', 'PayPal fee (estimated)', 'Net after fees'];
  const lines = r.rows.map((x) => [x.paidDate, x.number, x.client, x.company, x.email, x.gross, x.salesTax, x.income, x.lateFees, x.via, x.fee, r2(x.income - x.fee)]);
  const total = ['TOTAL', '', '', '', '', r.totals.gross, r.totals.salesTax, r.totals.income, r.totals.lateFees, '', r.totals.fees, r.totals.net];
  return [head, ...lines, total].map((l) => l.map(csvCell).join(',')).join('\n') + '\n';
}
