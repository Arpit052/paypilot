// Demo data so the dashboard, risk scores and forecast have history to work with.
// Historical (paid) invoices are marked source:"seed". In mock mode we also seed
// open/overdue invoices so the follow-up flow can be shown immediately.
import { config, isoDate, addDays } from './config.js';
import { upsertClient, logActivity, insertInvoice, findClient, transaction, insertTimeEntry, kvSet } from './db.js';
import { isMock, mockNextNumber, mockPut } from './paypal.js';
import { invoiceTotal } from './analytics.js';

const CLIENTS = [
  { name: 'Jake Miller', email: 'jake.miller@example.com', lateBy: [12, 18, 9, 21] },
  { name: 'Emily Carter', email: 'emily@cartercreative.example', lateBy: [0, 0, 1, 0, 0] },
  { name: 'Acme Labs', email: 'billing@acmelabs.example', lateBy: [3, 6, 2] },
  { name: 'Olivia Brooks', email: 'olivia.brooks@example.com', lateBy: [0, 4] },
];

const WORK = [
  ['Logo design', 150],
  ['Landing page design', 400],
  ['Social media kit', 120],
  ['Brand guidelines PDF', 250],
  ['UI audit', 180],
  ['Revision round', 40],
  ['Monthly retainer', 600],
];

export function seedDemo() {
  transaction(seedInner);
  logActivity('seed', 'Demo history loaded');
}

function seedInner() {
  const today = isoDate();
  let seq = 900;
  let k = 0;
  const pick = () => WORK[k++ % WORK.length];

  for (const c of CLIENTS) {
    const client = upsertClient(c);
    c.lateBy.forEach((late, idx) => {
      const issue = addDays(today, -170 + idx * 35 + (k % 9));
      const due = addDays(issue, 14);
      const [name, price] = pick();
      const items = [{ name, quantity: 1 + (idx % 2), unitPrice: price }];
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
        paidDate: addDays(due, late) > today ? today : addDays(due, late),
        note: '',
        payerUrl: null,
        reminders: [],
        source: 'seed',
      });
    });
  }

  // A couple of payments inside the current month, so "Earned this month" is never empty
  // (e.g. when the demo runs on the 1st).
  const monthStart = today.slice(0, 8) + '01';
  const recentPaid = [
    { email: 'emily@cartercreative.example', item: ['Monthly retainer', 1, 600], paid: today },
    { email: 'olivia.brooks@example.com', item: ['Landing page copy', 1, 300], paid: today },
  ];
  for (const r of recentPaid) {
    const client = findClient(r.email);
    const items = [{ name: r.item[0], quantity: r.item[1], unitPrice: r.item[2] }];
    const due = r.paid < monthStart ? monthStart : r.paid;
    insertInvoice({
      paypalId: null,
      number: `D-${++seq}`,
      clientId: client.id,
      items,
      currency: config.currency,
      total: invoiceTotal(items),
      status: 'PAID',
      issueDate: addDays(due, -14),
      dueDate: due,
      paidDate: r.paid,
      note: '',
      payerUrl: null,
      reminders: [],
      source: 'seed',
    });
  }

  // Some unbilled hours so the Time page has something to invoice.
  const olivia = findClient('olivia.brooks@example.com');
  kvSet(`rate:${olivia.id}`, 65);
  for (const [daysAgo, task, minutes] of [[3, 'Content calendar', 150], [1, 'Content calendar', 95], [1, 'Caption writing', 60]]) {
    const start = new Date(`${addDays(today, -daysAgo)}T10:00:00Z`);
    insertTimeEntry({ clientId: olivia.id, task, startedAt: start.toISOString(), endedAt: new Date(start.getTime() + minutes * 60000).toISOString(), minutes, hourlyRate: 65 });
  }

  if (isMock) {
    const open = [
      { email: 'jake.miller@example.com', item: ['Website redesign - phase 1', 1, 850], issue: -26, due: -12, reminders: 1 },
      { email: 'billing@acmelabs.example', item: ['Pitch deck design', 1, 320], issue: -12, due: -3, reminders: 0 },
      { email: 'emily@cartercreative.example', item: ['Monthly retainer', 1, 600], issue: -2, due: 12, reminders: 0 },
      { email: 'olivia.brooks@example.com', item: ['Instagram post pack', 10, 25], issue: -1, due: 6, reminders: 0 },
    ];
    for (const o of open) {
      const client = findClient(o.email);
      const number = mockNextNumber();
      const paypalId = `INV2-MOCK-${number}`;
      const items = [{ name: o.item[0], quantity: o.item[1], unitPrice: o.item[2] }];
      mockPut(paypalId, { status: 'SENT', reminders: o.reminders });
      insertInvoice({
        paypalId,
        number,
        clientId: client.id,
        items,
        currency: config.currency,
        total: invoiceTotal(items),
        status: 'SENT',
        issueDate: addDays(today, o.issue),
        dueDate: addDays(today, o.due),
        paidDate: null,
        note: '',
        payerUrl: `/mock-pay.html?id=${paypalId}`,
        reminders: o.reminders ? [{ at: addDays(today, -5), subject: 'Friendly reminder', tone: 'friendly' }] : [],
        source: 'paypal',
      });
    }
  }
}
