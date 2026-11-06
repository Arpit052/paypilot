// Calendar: everything money-related on a date - due dates, payments received,
// reminders sent, Autopilot's planned reminders and recurring invoices.
import { isoDate, addDays } from './config.js';
import { listInvoices, listSchedules, listActions, getClient } from './db.js';
import { isOpen, isPaid } from './analytics.js';
import { notOnCurrentPaypal } from './paypal.js';
import { planFor, autopilotSettings } from './autopilot.js';

export function calendarMonth(month, today = isoDate()) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) month = today.slice(0, 7);
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of the month
  const inRange = (d) => d && d >= start && d <= end;
  const events = [];
  const settings = autopilotSettings();
  const actions = listActions({});
  const name = (inv) => getClient(inv.clientId)?.name || 'Client';
  const base = (inv) => ({ invoiceId: inv.id, number: inv.number, client: name(inv), amount: inv.total, currency: inv.currency });

  for (const inv of listInvoices()) {
    if (inv.status === 'CANCELLED') continue;
    if (isPaid(inv) && inRange(inv.paidDate)) events.push({ date: inv.paidDate, kind: 'paid', ...base(inv), late: inv.paidDate > inv.dueDate });
    if (isOpen(inv) && inRange(inv.dueDate)) events.push({ date: inv.dueDate, kind: inv.dueDate < today ? 'overdue' : 'due', ...base(inv), payerUrl: inv.payerUrl });
    for (const r of inv.reminders || []) if (inRange(r.at)) events.push({ date: r.at, kind: 'reminded', tone: r.tone || 'friendly', ...base(inv) });
    if (isOpen(inv) && inv.paypalId && !notOnCurrentPaypal(inv) && settings.enabled) {
      const { steps } = planFor(inv, { settings, actions, today });
      const firmestDue = [...steps].reverse().find((s) => s.state === 'due');
      for (const s of steps) {
        if (!['planned', 'due', 'waiting'].includes(s.state)) continue;
        if (s.state === 'due' && s !== firmestDue) continue; // only the step Autopilot will actually take
        const date = s.date < today ? today : s.date;
        if (inRange(date)) events.push({ date, kind: 'planned', tone: s.tone, label: s.label, state: s.state, ...base(inv) });
      }
    }
  }
  for (const sc of listSchedules()) {
    if (!sc.active) continue;
    const c = getClient(sc.clientId);
    const total = sc.items.reduce((t, i) => t + i.quantity * i.unitPrice, 0);
    let d = sc.nextRun;
    for (let n = 0; n < 6 && d && d <= end; n++) {
      if (d >= start) events.push({ date: d, kind: 'recurring', client: c?.name || 'Client', amount: Math.round(total * 100) / 100, currency: sc.currency, frequency: sc.frequency });
      d = sc.frequency === 'weekly' ? addDays(d, 7) : addMonthsSafe(d);
    }
  }

  const sum = (kinds) => {
    const out = {};
    for (const e of events) if (kinds.includes(e.kind)) out[e.currency] = Math.round(((out[e.currency] || 0) + e.amount) * 100) / 100;
    return out;
  };
  const order = { overdue: 0, due: 1, paid: 2, planned: 3, reminded: 4, recurring: 5 };
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : order[a.kind] - order[b.kind]));
  return {
    month,
    start,
    end,
    today,
    events,
    totals: { due: sum(['due', 'overdue']), paid: sum(['paid']), recurring: sum(['recurring']) },
    counts: { planned: events.filter((e) => e.kind === 'planned').length, reminded: events.filter((e) => e.kind === 'reminded').length },
  };
}

function addMonthsSafe(d) {
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
