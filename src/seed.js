// Demo data so the dashboard, risk labels and forecast have history to work with.
// Modelled on a small design studio's real client mix: a chronic late payer, a dental
// office that pays like clockwork, an architecture firm whose accounts team always pays
// two days after the due date, a gym owner who pays in parts, and a one-off private client.
// Historical invoices are marked source:"seed" (shown as "demo", never sent to PayPal).
// In demo mode we also add open/overdue invoices so follow-ups can be shown straight away.
import { config, isoDate, addDays } from './config.js';
import { upsertClient, logActivity, insertInvoice, findClient, transaction, kvSet, insertSchedule } from './db.js';
import { isMock, mockPut } from './paypal.js';
import { invoiceTotal } from './analytics.js';

const CLIENTS = [
  { key: 'ryan', name: 'Ryan Castillo', company: 'Castillo Coffee Roasters', email: 'ryan@castillocoffee.co', net: 15 },
  { key: 'priya', name: 'Priya Raman', company: 'Brightline Dental', email: 'office@brightlinedental.com', net: 15 },
  { key: 'marcus', name: 'Marcus Hollis', company: 'Hollis & Grant Architects', email: 'ap@hollisgrant.com', net: 30 },
  { key: 'dani', name: 'Danielle Okafor', company: 'Okafor Fitness', email: 'dani@okaforfitness.com', net: 15 },
  { key: 'ben', name: 'Ben Whitaker', company: '', email: 'ben.whitaker@fastmail.com', net: 15 },
];

const RETAINER = ['Monthly design retainer (social + print)', 1, 725];

// [client, issued N days ago, days late when paid, line items, extra]
const HISTORY = [
  ['marcus', 176, 2, [['Project case-study layouts', 4, 162.5]]],
  ['ryan', 168, 11, [['Logo refresh', 1, 640], ['Brand colour and type sheet', 1, 180]]],
  ['priya', 161, 0, [RETAINER]],
  ['dani', 151, 0, [['Social media templates', 8, 42.5]]],
  ['marcus', 141, 2, [['Brand guidelines v2', 1, 1180]]],
  ['ryan', 131, 16, [['Bag label design, 3 blends', 3, 145]]],
  ['priya', 130, 0, [RETAINER]],
  ['priya', 113, 0, [['Patient welcome kit', 1, 418], ['Appointment card layout', 1, 95]]],
  ['marcus', 105, 2, [['Award submission boards', 2, 240], ['Print-ready file prep', 2, 45]]],
  ['priya', 99, 1, [RETAINER]],
  ['ryan', 96, 9, [['Packaging revisions, round 1', 1, 312.5]]],
  ['dani', 86, 4, [['Class schedule poster', 1, 185], ['Poster printing, 24 × 36 in', 3, 28]]],
  ['ryan', 72, null, [['Café menu board', 1, 535]], { cancelled: true, note: 'Duplicate - replaced by the next invoice' }],
  ['marcus', 70, 2, [['Website copy and layout, about page', 1, 387.5]]],
  ['priya', 68, 0, [RETAINER]],
  ['ryan', 63, 19, [['Café menu board', 1, 535], ['Menu photo retouching', 6, 22.5]]],
  ['ben', 58, 0, [['Save-the-date cards', 1, 285]]],
  ['dani', 51, 1, [['Photo retouching', 14, 18.75]]],
  ['priya', 38, 0, [RETAINER]],
];

// Paid inside the current month, so "Earned this month" is never empty (e.g. on the 1st).
const THIS_MONTH = [
  ['priya', [RETAINER]],
  ['ben', [['Wedding invitation suite', 1, 460], ['Envelope addressing', 120, 1.5]]],
];

export function seedDemo() {
  transaction(seedInner);
  logActivity('seed', 'Demo history loaded');
}

function seedInner() {
  const today = isoDate();
  const byKey = {};
  for (const c of CLIENTS) byKey[c.key] = { ...c, row: upsertClient({ name: c.name, email: c.email, company: c.company }) };
  const lines = (arr) => arr.map(([name, quantity, unitPrice]) => ({ name, quantity, unitPrice }));

  // invoice numbers run in date order, like a real invoice book
  let seq = 1017;
  const next = () => String(++seq);

  for (const [key, ago, late, work, extra = {}] of HISTORY) {
    const c = byKey[key];
    const issue = addDays(today, -ago);
    const due = addDays(issue, c.net);
    const items = lines(work);
    const paid = late === null ? null : addDays(due, late);
    insertInvoice({
      paypalId: null,
      number: next(),
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

  for (const [key, work] of THIS_MONTH) {
    const c = byKey[key];
    const items = lines(work);
    insertInvoice({
      paypalId: null,
      number: next(),
      clientId: c.row.id,
      items,
      currency: config.currency,
      total: invoiceTotal(items),
      status: 'PAID',
      issueDate: addDays(today, -12),
      dueDate: addDays(today, -12 + c.net),
      paidDate: today,
      note: '',
      payerUrl: null,
      reminders: [],
      source: 'seed',
    });
  }

  if (isMock()) {
    const open = [
      // chronic late payer: 12 days overdue, already nudged once
      { key: 'ryan', work: [['Packaging redesign, round 2', 1, 1080], ['Dieline adjustments', 2, 80]], issue: -27, reminders: 1 },
      // pays two days late, every time
      { key: 'marcus', work: [['Website copy and layout, services page', 1, 387.5]], issue: -33 },
      // reliable retainer client
      { key: 'priya', work: [RETAINER], issue: -2 },
      // pays in parts: half already paid
      { key: 'dani', work: [['Instagram content pack', 12, 32.5]], issue: -9, status: 'PARTIALLY_PAID', deposit: 195 },
    ];
    for (const o of open) {
      const c = byKey[o.key];
      const number = next();
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
