// Collections board: every unpaid invoice, grouped by how late it is, with what has
// already been done (reminders, late fees) and what's waiting for approval.
import { config, isoDate, daysBetween } from './config.js';
import { listInvoices, getClient, listActions, findInvoice } from './db.js';
import { isOpen, clientStats } from './analytics.js';
import { notOnCurrentPaypal } from './paypal.js';
import { hasLateFee } from './actions.js';
import { draftReminder, draftLateFees } from './followups.js';
import { createAction, lateFeeDraft } from './actions.js';
import { planFor, comingUp, autopilotSettings } from './autopilot.js';
import { lifetimeStats } from './analytics.js';
import { addDays } from './config.js';

export const STAGES = [
  { key: 'upcoming', label: 'Not due yet', hint: 'Due soon. A friendly heads-up can help.' },
  { key: 'late', label: '1–7 days late', hint: 'A polite nudge usually does it.' },
  { key: 'later', label: '8–30 days late', hint: 'Time for a firmer reminder, maybe a late fee.' },
  { key: 'critical', label: '30+ days late', hint: 'Final reminder. Consider pausing work.' },
];

function stageOf(daysLate) {
  if (daysLate <= 0) return 'upcoming';
  if (daysLate <= 7) return 'late';
  if (daysLate <= 30) return 'later';
  return 'critical';
}

const add = (map, cur, v) => ((map[cur] = Math.round(((map[cur] || 0) + v) * 100) / 100), map);

export function collections(today = isoDate()) {
  const pending = listActions({ status: 'pending' }).filter((a) => ['send_reminder', 'add_late_fee'].includes(a.type));
  const decidedFee = new Set(listActions({ type: 'add_late_fee' }).filter((a) => a.status !== 'pending').map((a) => a.payload.invoiceId));
  const totals = { owed: {}, upcoming: {}, late: {}, later: {}, critical: {} };
  const counts = { upcoming: 0, late: 0, later: 0, critical: 0 };
  const cards = [];
  const settings = autopilotSettings();
  const allActions = listActions({});
  const weekEnd = addDays(today, 7);
  const dueThisWeek = {};
  for (const inv of listInvoices()) {
    if (!isOpen(inv) || !inv.paypalId) continue;
    const c = getClient(inv.clientId) || {};
    const daysLate = daysBetween(inv.dueDate, today); // negative = due in N days
    const stage = stageOf(daysLate);
    const st = clientStats(inv.clientId, today);
    const drafts = pending.filter((a) => a.payload.invoiceId === inv.id).map((a) => ({ id: a.id, type: a.type, tone: a.payload.tone }));
    const actionable = !notOnCurrentPaypal(inv);
    add(totals.owed, inv.currency, inv.total);
    if (daysLate <= 0 && inv.dueDate <= weekEnd) add(dueThisWeek, inv.currency, inv.total);
    const plan = actionable ? planFor(inv, { settings, actions: allActions, today }) : { steps: [], next: null };
    const last = (inv.reminders || []).at(-1) || null;
    add(totals[stage], inv.currency, inv.total);
    counts[stage]++;
    cards.push({
      id: inv.id,
      number: inv.number,
      client: c.name || 'Unknown client',
      company: c.company || '',
      email: c.email || '',
      total: inv.total,
      currency: inv.currency,
      status: inv.status,
      depositAmount: inv.depositAmount || 0,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      daysLate,
      stage,
      work: inv.items.map((i) => i.name).join(', '),
      reminders: inv.reminders || [],
      risk: st.riskLabel,
      usuallyLate: st.avgDaysLate,
      payerUrl: inv.payerUrl,
      drafts,
      actionable,
      lateFeeEligible:
        actionable && config.lateFeePercent > 0 && daysLate >= config.lateFeeAfterDays && !hasLateFee(inv) && !decidedFee.has(inv.id),
      hasLateFee: hasLateFee(inv),
      plan,
      lastContact: last ? { at: last.at, tone: last.tone || 'friendly' } : null,
    });
  }
  cards.sort((a, b) => b.daysLate - a.daysLate || b.total - a.total);
  const recent = listActions({})
    .filter((a) => ['send_reminder', 'add_late_fee'].includes(a.type) && a.status === 'approved')
    .slice(0, 40)
    .map((a) => ({ type: a.type, number: a.payload.number, client: a.payload.client, tone: a.payload.tone, fee: a.result?.fee ?? a.payload.fee, currency: a.payload.currency, at: isoDate(a.decidedAt || a.createdAt) }));
  const life = lifetimeStats(today);
  return {
    today,
    stages: STAGES,
    totals,
    counts,
    cards,
    recent,
    dueThisWeek,
    speed: { avgDaysToGetPaid: life.avgDaysToGetPaid, onTimeRate: life.onTimeRate },
    autopilot: settings,
    comingUp: comingUp(21, today),
    waiting: allActions.filter((a) => a.status === 'pending' && ['send_reminder', 'add_late_fee'].includes(a.type)).length,
    lateFee: { percent: config.lateFeePercent, afterDays: config.lateFeeAfterDays },
  };
}

/** One-click "Draft reminder" / "Add late fee" on a card. Returns the pending draft. */
export async function draftFor(invoiceId, kind) {
  const inv = findInvoice(invoiceId);
  const bad = (m, status = 400) => Object.assign(new Error(m), { status });
  if (!inv) throw bad('Invoice not found', 404);
  if (!isOpen(inv)) throw bad(`Invoice #${inv.number} is already ${inv.status.toLowerCase().replace(/_/g, ' ')}.`);
  if (notOnCurrentPaypal(inv)) throw bad(`Invoice #${inv.number} isn't on the PayPal account you're connected to.`);
  const existing = listActions({ status: 'pending' }).find((a) => a.payload.invoiceId === inv.id && a.type === (kind === 'late_fee' ? 'add_late_fee' : 'send_reminder'));
  if (existing) return existing;
  if (kind === 'late_fee') {
    const today = isoDate();
    const daysOverdue = daysBetween(inv.dueDate, today);
    if (daysOverdue < 1) throw bad("This invoice isn't overdue yet.");
    if (hasLateFee(inv)) throw bad(`Invoice #${inv.number} already has a late fee.`);
    const payload = lateFeeDraft(inv, { clientName: getClient(inv.clientId)?.name || '', daysOverdue, percent: config.lateFeePercent || 5 });
    return createAction('add_late_fee', payload, { origin: 'followup', summary: `Late fee #${inv.number} (${payload.percent}%)` });
  }
  return draftReminder(inv);
}

export { draftLateFees };
