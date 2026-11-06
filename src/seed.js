// Demo data so the dashboard, risk labels and forecast have history to work with.
// It's modelled on a small US design studio's real-world mix of clients: one who is
// always on time, one who pays a couple of days late like clockwork, one chronic late
// payer, one who pays in instalments, and a brand-new client.
// Historical (paid) invoices are marked source:"seed". In demo mode we also add
// open/overdue invoices so the follow-up flow can be shown straight away.
import { config, isoDate, addDays } from './config.js';
import { upsertClient, logActivity, insertInvoice, findClient, transaction } from './db.js';
import { isMock, mockNextNumber, mockPut } from './paypal.js';
import { invoiceTotal } from './analytics.js';

// lateBy: days late for each past invoice (0 = on time). work: what they were billed for.
const CLIENTS = [
  {
    name: 'Ryan Castillo',
    company: 'Castillo Coffee Roasters',
    email: 'ryan@castillocoffee.example',
    lateBy: [11, 16, 9, 19],
    work: [['Logo refresh', 1, 640], ['Bag label design, 3 blends', 3, 145], ['Packaging revisions, round 3', 1, 312.5], ['Café menu board', 1, 535]],
  },
  {
    name: 'Priya Raman',
    company: 'Brightline Dental',
    email: 'priya@brightlinedental.example',
    lateBy: [0, 0, 0, 1, 0],
    work: [['Monthly design retainer', 1, 725], ['Monthly design retainer', 1, 725], ['Patient welcome kit', 1, 418], ['Monthly design retainer', 1, 725], ['Appointment card reprint layout', 1, 95]],
  },
  {
    name: 'Marcus Hollis',
    company: 'Hollis & Grant Architects',
    email: 'billing@hollisgrant.example',
    lateBy: [2, 2, 2, 2, 2],
    work: [['Project case-study layouts', 4, 162.5], ['Brand guidelines v2', 1, 1180], ['Award submission boards', 2, 240], ['Website copy & layout, about page', 1, 387.5], ['Holiday card design', 1, 210]],
  },
  {
    name: 'Danielle Okafor',
    company: 'Okafor Fitness',
    email: 'dani@okaforfitness.example',
    lateBy: [0, 4, 1],
    work: [['Social media templates', 8, 42.5], ['Class schedule poster', 1, 185], ['Photo retouching', 14, 18.75]],
  },
  {
    name: 'Ben Whitaker',
    company: '',
    email: 'ben.whitaker@example.com',
    lateBy: [0],
    work: [['Wedding invitation suite', 1, 460]],
  },
];

export function seedDemo() {
  transaction(seedInner);
  logActivity('seed', 'Demo history loaded');
}

function seedInner() {
  const today = isoDate();
  let seq = 900;

  CLIENTS.forEach((c, ci) => {
    const client = upsertClient({ name: c.name, email: c.email, company: c.company });
    c.lateBy.forEach((late, idx) => {
      // spread over the last ~6 months, a little irregular like real work
      const issue = addDays(today, -172 + idx * 33 + ((ci * 7 + idx * 5) % 11));
      const due = addDays(issue, idx % 3 === 0 ? 14 : 30);
      const [name, quantity, unitPrice] = c.work[idx % c.work.length];
      const items = [{ name, quantity, unitPrice }];
      const paid = addDays(due, late);
      if (paid > today) return;
      insertInvoice({
        paypalId: null,
        number: `D-${++seq}`,
        clientId: client.id,
        items,
        currency: config.currency,
        total: invoiceTotal(items),
        status: 'PAID',
        issueDate: issue,
        dueDate: due,
        paidDate: paid,
        note: '',
        payerUrl: null,
        reminders: late > 7 ? [{ at: addDays(due, 5), subject: 'Friendly reminder', tone: 'friendly' }] : [],
        source: 'seed',
      });
    });
  });

  // Payments inside the current month, so "Earned this month" is never empty
  // (e.g. when the demo runs on the 1st).
  const recentPaid = [
    { email: 'priya@brightlinedental.example', item: ['Monthly design retainer', 1, 725] },
    { email: 'ben.whitaker@example.com', item: ['Save-the-date cards', 1, 285] },
  ];
  for (const r of recentPaid) {
    const client = findClient(r.email);
    const items = [{ name: r.item[0], quantity: r.item[1], unitPrice: r.item[2] }];
    insertInvoice({
      paypalId: null,
      number: `D-${++seq}`,
      clientId: client.id,
      items,
      currency: config.currency,
      total: invoiceTotal(items),
      status: 'PAID',
      issueDate: addDays(today, -14),
      dueDate: today,
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
      { email: 'ryan@castillocoffee.example', item: ['Packaging redesign, round 2', 1, 1240], issue: -42, due: -12, reminders: 1 },
      // pays a couple of days late, every time
      { email: 'billing@hollisgrant.example', item: ['Website copy & layout, services page', 1, 387.5], issue: -33, due: -3, reminders: 0 },
      // reliable retainer client
      { email: 'priya@brightlinedental.example', item: ['Monthly design retainer', 1, 725], issue: -2, due: 12, reminders: 0 },
      // pays in instalments: half already paid
      { email: 'dani@okaforfitness.example', item: ['Instagram content pack', 12, 32.5], issue: -9, due: 6, reminders: 0, status: 'PARTIALLY_PAID', deposit: 195 },
    ];
    for (const o of open) {
      const client = findClient(o.email);
      const number = mockNextNumber();
      const paypalId = `INV2-MOCK-${number}`;
      const items = [{ name: o.item[0], quantity: o.item[1], unitPrice: o.item[2] }];
      const status = o.status || 'SENT';
      mockPut(paypalId, { status, reminders: o.reminders });
      insertInvoice({
        paypalId,
        number,
        clientId: client.id,
        items,
        currency: config.currency,
        total: invoiceTotal(items),
        status,
        issueDate: addDays(today, o.issue),
        dueDate: addDays(today, o.due),
        paidDate: null,
        note: '',
        payerUrl: `/mock-pay.html?id=${paypalId}`,
        depositAmount: o.deposit || 0,
        reminders: o.reminders ? [{ at: addDays(today, -5), subject: 'Friendly reminder', tone: 'friendly' }] : [],
        source: 'paypal',
      });
    }
  }
}
