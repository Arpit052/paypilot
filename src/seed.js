// Demo data so the dashboard, risk scores and forecast have history to work with.
// Historical (paid) invoices are marked source:"seed". In mock mode we also seed
// open/overdue invoices so the follow-up flow can be shown immediately.
import { config, isoDate, addDays } from './config.js';
import { db, save, newId, upsertClient, logActivity } from './db.js';
import { isMock } from './paypal.js';
import { invoiceTotal } from './analytics.js';

const CLIENTS = [
  { name: 'Rahul Sharma', email: 'rahul.sharma@example.com', lateBy: [12, 18, 9, 21] },
  { name: 'Priya Mehta', email: 'priya@mehtastudio.example', lateBy: [0, 0, 1, 0, 0] },
  { name: 'Acme Labs', email: 'billing@acmelabs.example', lateBy: [3, 6, 2] },
  { name: 'Neha Kapoor', email: 'neha.k@example.com', lateBy: [0, 4] },
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
  const today = isoDate();
  const s = db();
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
      s.invoices.push({
        id: newId('inv'),
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

  if (isMock) {
    const m = (s.mockPaypal ||= { seq: 1000, invoices: {} });
    const open = [
      { email: 'rahul.sharma@example.com', item: ['Website redesign - phase 1', 1, 850], issue: -26, due: -12, reminders: 1 },
      { email: 'billing@acmelabs.example', item: ['Pitch deck design', 1, 320], issue: -12, due: -3, reminders: 0 },
      { email: 'priya@mehtastudio.example', item: ['Monthly retainer', 1, 600], issue: -2, due: 12, reminders: 0 },
      { email: 'neha.k@example.com', item: ['Instagram post pack', 10, 25], issue: -1, due: 6, reminders: 0 },
    ];
    for (const o of open) {
      const client = s.clients.find((c) => c.email === o.email);
      const number = String(++m.seq).padStart(4, '0');
      const paypalId = `INV2-MOCK-${number}`;
      const items = [{ name: o.item[0], quantity: o.item[1], unitPrice: o.item[2] }];
      m.invoices[paypalId] = { status: 'SENT', reminders: o.reminders };
      s.invoices.push({
        id: newId('inv'),
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
  s.invoices.sort((a, b) => b.issueDate.localeCompare(a.issueDate));
  save();
  logActivity('seed', 'Demo history loaded');
}
