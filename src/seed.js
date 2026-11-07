// Demo data so the dashboard, risk labels and forecast have history to work with.
// This file is the graphic designer's book, written by hand: a founder who always pays late,
// an engineering lead on a retainer who pays like clockwork, a brand team whose accounts
// department pays two days after the due date, an operations director who buys almost every
// month and pays in parts, and a one-off private client. Other professions get the same
// clients buying their kind of work (see personas.js).
// Historical invoices are marked source:"seed" (shown as "demo", never sent to PayPal).
// In demo mode we also add open/overdue invoices so follow-ups can be shown straight away.
import { config, isoDate, addDays } from './config.js';
import { upsertClient, logActivity, insertInvoice, transaction, kvSet, insertSchedule, listInvoices, updateInvoice } from './db.js';
import { ensureReceipt } from './receipts.js';
import { listClients } from './db.js';
const listClientsByEmail = (email) => listClients().find((c) => c.email.toLowerCase() === email.toLowerCase());
import { isMock, mockPut } from './paypal.js';
import { invoiceTotal } from './analytics.js';
import { personaFor, personaInvoices } from './personas.js';
import { normalType } from './business.js';

const CLIENTS = [
  { key: 'ryan', name: 'Marcus Vance', role: 'Founder & CEO', company: 'Apex Growth Lab', industry: 'Marketing & agencies', email: 'marcus@apexgrowthlab.io', net: 15 },
  { key: 'priya', name: 'Kiran Deshmukh', role: 'Principal Engineer', company: 'Overcast Labs', industry: 'Software & SaaS', email: 'kiran@overcastlabs.io', net: 15 },
  { key: 'marcus', name: 'William Evans', role: 'Head of Brand', company: 'Voltline Energy', industry: 'Energy & utilities', email: 'william@voltlineenergy.com', net: 30 },
  { key: 'dani', name: 'Rachel Adams', role: 'Operations Director', company: 'Summit Peak Consulting', industry: 'Professional services', email: 'rachel@summitpeakconsulting.com', net: 15 },
  { key: 'sofia', name: 'Sofia Martinez', role: 'Marketing Manager', company: 'Lumen Health', industry: 'Healthcare', email: 'sofia@lumenhealth.co', net: 15 },
  { key: 'ben', name: 'Daniel Brooks', role: '', company: '', industry: 'Private clients', email: 'daniel.brooks@fastmail.com', net: 15, upfront: true },
];

const RETAINER = ['Monthly design retainer (product UI + marketing)', 1, 725];

// [client, issued N days ago, days late when paid, line items, extra]
const HISTORY = [
  ['marcus', 176, 2, [['Can artwork adaptations', 4, 162.5]]],
  // a clinic's marketing team: paid on time every few weeks, then went quiet (Growth: slipping away)
  ['sofia', 158, 0, [['Patient brochure layout', 1, 420]]],
  ['ryan', 168, 11, [['Logo refresh', 1, 640], ['Brand colour and type sheet', 1, 180]]],
  ['priya', 161, 0, [RETAINER]],
  ['dani', 151, 0, [['LinkedIn post templates', 8, 42.5]]],
  ['dani', 122, 2, [['Workshop flyer', 1, 185], ['Social content pack', 6, 32.5]]],
  ['marcus', 141, 2, [['Brand guidelines v2', 1, 1180]]],
  ['sofia', 121, 0, [['Clinic waiting-room posters', 3, 95], ['Social content pack', 6, 32.5]]],
  ['ryan', 131, 16, [['Ad creative set, 3 campaigns', 3, 145]]],
  ['priya', 130, 0, [RETAINER]],
  ['priya', 113, 0, [['Onboarding screens, 6 views', 1, 418], ['Empty-state illustrations', 1, 95]]],
  ['marcus', 105, 2, [['Event booth graphics', 2, 240], ['Print-ready file prep', 2, 45]]],
  ['priya', 99, 1, [RETAINER]],
  ['ryan', 96, 9, [['Landing page design, revisions', 1, 312.5]]],
  ['sofia', 84, 0, [['Health-check campaign ads', 4, 120]]],
  ['dani', 86, 4, [['Workshop flyer', 1, 185], ['Poster printing, 24 × 36 in', 3, 28]]],
  ['ryan', 72, null, [['Investor one-pager', 1, 535]], { cancelled: true, note: 'Duplicate - replaced by the next invoice' }],
  ['marcus', 70, 2, [['Campaign landing page layout', 1, 387.5]]],
  ['priya', 68, 0, [RETAINER]],
  ['ryan', 63, 19, [['Investor one-pager', 1, 535], ['Chart and icon set', 6, 22.5]]],
  // a private client who pays the whole invoice up front, the day it arrives
  ['ben', 58, -15, [['Save-the-date cards', 1, 285]]],
  ['dani', 51, 1, [['Team headshot retouching', 14, 18.75]]],
  ['dani', 30, 3, [['Social content pack', 12, 32.5], ['Webinar promo graphics', 1, 140]]],
  ['priya', 38, 0, [RETAINER]],
];

// Paid inside the current month, so "Earned this month" is never empty (e.g. on the 1st).
const THIS_MONTH = [
  ['priya', [RETAINER]],
  ['ben', [['Wedding invitation suite', 1, 460], ['Envelope addressing', 120, 1.5]]],
];

// open invoices, demo mode only (a connected PayPal account has its own)
const OPEN = [
  // chronic late payer: 12 days overdue, already nudged once
  { key: 'ryan', work: [['Pitch deck redesign (24 slides)', 1, 1080], ['Extra slide variants', 2, 80]], issue: -27, reminders: 1 },
  // pays two days late, every time
  { key: 'marcus', work: [['Retail shelf display design', 1, 387.5]], issue: -33 },
  // reliable retainer client
  { key: 'priya', work: [RETAINER], issue: -2 },
  // pays in parts: half already paid
  { key: 'dani', work: [['Social content pack', 12, 32.5]], issue: -9, status: 'PARTIALLY_PAID', deposit: 195 },
];

/** Load sample history. The sample business follows the chosen business type. */
/**
 * A brand team's accounts department pays by bank transfer (ACH), not PayPal, like most
 * companies. Those payments are recorded as "marked paid", and PayPal sends no receipt for
 * them, so receipts are tracked: the older ones were sent, the newest still needs one.
 */
function markBankPayer(clientId) {
  const paid = listInvoices({ clientId }).filter((i) => i.status === 'PAID' && i.source === 'seed').sort((a, b) => a.paidDate.localeCompare(b.paidDate));
  paid.forEach((inv, k) => {
    updateInvoice(inv.id, { status: 'MARKED_AS_PAID' });
    kvSet(`paidVia:${inv.id}`, 'bank');
    const r = ensureReceipt({ ...inv, status: 'MARKED_AS_PAID' });
    if (k < paid.length - 1) kvSet(`receipt:${inv.id}`, { ...r, sentAt: `${addDays(inv.paidDate, 1)}T10:00:00.000Z`, sentVia: 'email', viewedAt: k < paid.length - 2 ? `${addDays(inv.paidDate, 2)}T09:00:00.000Z` : null });
  });
}

export function seedDemo(profession = normalType(config.businessType)) {
  const persona = personaFor(profession);
  transaction(() => (persona ? seedPersona(persona) : seedInner()));
  const bank = (persona ? persona.find((c) => c.key === 'william') : CLIENTS.find((c) => c.key === 'marcus'))?.email;
  const row = bank && listClientsByEmail(bank);
  if (row) markBankPayer(row.id);
  kvSet('demo:persona', persona ? profession : 'graphic_designer');
  logActivity('seed', 'Demo history loaded');
}

const linesOf = (arr) => arr.map(([name, quantity, unitPrice]) => ({ name, quantity, unitPrice }));

/** Generated seeding for every profession except the hand-made design studio. */
function seedPersona(clients) {
  const today = isoDate();
  const mock = isMock();
  const rows = {};
  for (const c of clients) rows[c.key] = upsertClient({ name: c.name, email: c.email, company: c.company, role: c.role, industry: c.industry });
  let seq = 1017;
  for (const r of personaInvoices(clients)) {
    const c = r.client;
    const open = r.late === null;
    if (open && !mock) continue; // only real PayPal invoices can be open on a connected account
    const issue = addDays(today, -r.ago);
    const due = addDays(issue, c.net);
    const items = linesOf(r.work);
    const number = String(++seq);
    const overdueDays = open ? Math.round((Date.parse(today) - Date.parse(due)) / 864e5) : 0;
    const paypalId = open ? `INV2-MOCK-${number}` : null;
    const reminded = open ? overdueDays > 5 : r.late > 7;
    if (open) mockPut(paypalId, { status: 'SENT', reminders: reminded ? 1 : 0 });
    insertInvoice({
      paypalId,
      number,
      clientId: rows[c.key].id,
      items,
      currency: config.currency,
      total: invoiceTotal(items),
      status: open ? 'SENT' : 'PAID',
      issueDate: issue,
      dueDate: due,
      paidDate: open ? null : addDays(due, r.late),
      note: '',
      payerUrl: open ? `/mock-pay.html?id=${paypalId}` : null,
      reminders: reminded ? [{ at: open ? addDays(today, -3) : addDays(due, 5), subject: 'Friendly reminder', tone: 'friendly' }] : [],
      source: open ? 'paypal' : 'seed',
    });
  }
  const [yy, mm] = today.split('-').map(Number);
  const firstNext = new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
  for (const c of clients.filter((x) => x.retainer)) {
    insertSchedule({ clientId: rows[c.key].id, items: linesOf([c.retainer.item]), currency: config.currency, frequency: 'monthly', nextRun: firstNext, dueInDays: c.retainer.due });
  }
  kvSet('mock:seq', seq);
}

function seedInner() {
  const today = isoDate();
  const byKey = {};
  for (const c of CLIENTS) byKey[c.key] = { ...c, row: upsertClient({ name: c.name, email: c.email, company: c.company, role: c.role, industry: c.industry }) };
  const lines = (arr) => arr.map(([name, quantity, unitPrice]) => ({ name, quantity, unitPrice }));

  const open = isMock() ? OPEN : [];
  // invoice numbers run in date order, like a real invoice book
  const order = [
    ...HISTORY.map((h, i) => [`h${i}`, h[1]]),
    ...THIS_MONTH.map((_, i) => [`t${i}`, 12]),
    ...open.map((o, i) => [`o${i}`, -o.issue]),
  ].sort((x, y) => y[1] - x[1]);
  const numberOf = Object.fromEntries(order.map(([tag], k) => [tag, String(1018 + k)]));
  const seq = 1017 + order.length;

  for (const [hi, [key, ago, late, work, extra = {}]] of HISTORY.entries()) {
    const c = byKey[key];
    const issue = addDays(today, -ago);
    const due = addDays(issue, c.net);
    const items = lines(work);
    const paid = late === null ? null : addDays(due, late);
    insertInvoice({
      paypalId: null,
      number: numberOf[`h${hi}`],
      clientId: c.row.id,
      items,
      currency: config.currency,
      total: invoiceTotal(items),
      status: extra.cancelled ? 'CANCELLED' : 'PAID',
      issueDate: issue,
      dueDate: due,
      paidDate: paid && paid > today ? today : paid,
      note: extra.note || '',
      payerUrl: null,
      reminders: late > 7 ? [{ at: addDays(due, 5), subject: 'Friendly reminder', tone: 'friendly' }] : [],
      source: 'seed',
    });
  }

  for (const [ti, [key, work]] of THIS_MONTH.entries()) {
    const c = byKey[key];
    const items = lines(work);
    insertInvoice({
      paypalId: null,
      number: numberOf[`t${ti}`],
      clientId: c.row.id,
      items,
      currency: config.currency,
      total: invoiceTotal(items),
      status: 'PAID',
      issueDate: addDays(today, -12),
      dueDate: addDays(today, -12 + c.net),
      paidDate: c.upfront ? addDays(today, -12) : today,
      note: '',
      payerUrl: null,
      reminders: [],
      source: 'seed',
    });
  }

  {
    for (const [oi, o] of open.entries()) {
      const c = byKey[o.key];
      const number = numberOf[`o${oi}`];
      const paypalId = `INV2-MOCK-${number}`;
      const items = lines(o.work);
      const status = o.status || 'SENT';
      mockPut(paypalId, { status, reminders: o.reminders || 0 });
      insertInvoice({
        paypalId,
        number,
        clientId: c.row.id,
        items,
        currency: config.currency,
        total: invoiceTotal(items),
        status,
        issueDate: addDays(today, o.issue),
        dueDate: addDays(today, o.issue + c.net),
        paidDate: null,
        note: '',
        payerUrl: `/mock-pay.html?id=${paypalId}`,
        depositAmount: o.deposit || 0,
        reminders: o.reminders ? [{ at: addDays(today, -5), subject: 'Friendly reminder', tone: 'friendly' }] : [],
        source: 'paypal',
      });
    }
  }
  // Priya's monthly retainer runs on a schedule (next one on the 1st of next month)
  const [yy, mm] = today.split('-').map(Number);
  const firstNext = new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
  insertSchedule({ clientId: byKey.priya.row.id, items: lines([RETAINER]), currency: config.currency, frequency: 'monthly', nextRun: firstNext, dueInDays: 15 });
  // new demo invoices continue the same numbering
  kvSet('mock:seq', seq);
}
