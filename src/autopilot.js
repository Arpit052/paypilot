// Autopilot: a follow-up plan for every unpaid invoice.
//   N days before the due date  -> friendly heads-up
//   N days after the due date   -> firm reminder
//   N days after the due date   -> final reminder (+ late fee, if turned on)
// On each step's date the AI writes the email and parks it for approval. Nothing is
// sent without a click; discarding a draft skips that step for that invoice.
import { config, isoDate, addDays, daysBetween } from './config.js';
import { listInvoices, listActions, getClient, kvGet, kvSet } from './db.js';
import { isOpen } from './analytics.js';
import { notOnCurrentPaypal } from './paypal.js';
import { createAction, lateFeeDraft, hasLateFee } from './actions.js';
import { draftReminder, TONES } from './followups.js';
import { notify } from './notify.js';

const DEFAULTS = { enabled: true, beforeDays: 2, firmAfter: 3, finalAfter: 10, feeWithFinal: true };
const rank = (t) => TONES.indexOf(t);
export const REMINDER_GAP_DAYS = Math.max(1, config.reminderCooldownDays || 4);

export function autopilotSettings() {
  return { ...DEFAULTS, ...(kvGet('settings:autopilot') || {}) };
}

export function saveAutopilotSettings(input = {}) {
  const cur = autopilotSettings();
  const int = (v, lo, hi, label) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw Object.assign(new Error(`${label} must be between ${lo} and ${hi} days`), { status: 400 });
    return n;
  };
  const next = { ...cur };
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.feeWithFinal !== undefined) next.feeWithFinal = Boolean(input.feeWithFinal);
  if (input.beforeDays !== undefined) next.beforeDays = int(input.beforeDays, 0, 14, 'Heads-up');
  if (input.firmAfter !== undefined) next.firmAfter = int(input.firmAfter, 1, 30, 'Firm reminder');
  if (input.finalAfter !== undefined) next.finalAfter = int(input.finalAfter, 2, 90, 'Final reminder');
  if (next.finalAfter <= next.firmAfter) throw Object.assign(new Error('The final reminder has to come after the firm one'), { status: 400 });
  kvSet('settings:autopilot', next);
  return next;
}

/**
 * The plan for one invoice: every step with its date and whether it's done,
 * skipped (you discarded that draft), waiting (draft ready) or still to come.
 */
export function planFor(inv, { settings = autopilotSettings(), actions = listActions({}), today = isoDate() } = {}) {
  const fee = settings.feeWithFinal && config.lateFeePercent > 0;
  const steps = [
    { key: 'headsup', tone: 'friendly', date: addDays(inv.dueDate, -settings.beforeDays), label: 'Friendly heads-up' },
    { key: 'firm', tone: 'firm', date: addDays(inv.dueDate, settings.firmAfter), label: 'Firm reminder' },
    { key: 'final', tone: 'final', date: addDays(inv.dueDate, settings.finalAfter), label: fee ? `Final reminder + ${config.lateFeePercent}% late fee` : 'Final reminder' },
  ];
  const sentRank = Math.max(-1, ...(inv.reminders || []).map((r) => rank(r.tone || 'friendly')));
  const mine = actions.filter((a) => a.type === 'send_reminder' && a.payload?.invoiceId === inv.id);
  for (const s of steps) {
    if (sentRank >= rank(s.tone)) s.state = 'done';
    else if (mine.some((a) => a.status === 'pending' && rank(a.payload.tone) === rank(s.tone))) s.state = 'waiting';
    else if (mine.some((a) => a.status === 'rejected' && rank(a.payload.tone) >= rank(s.tone) && (a.createdAt || '').slice(0, 10) >= s.date)) s.state = 'skipped';
    else if (s.key === 'headsup' && s.date < inv.issueDate) s.state = 'skipped'; // invoice was sent too close to its due date
    else s.state = s.date <= today ? 'due' : 'planned';
  }
  // a reminder that just went out (by hand or by plan) pauses the next one for a few days,
  // so the board never asks for another reminder the day after you sent one
  const lastSent = (inv.reminders || []).map((r) => r.at).filter(Boolean).sort().at(-1);
  if (lastSent) {
    const resume = addDays(lastSent, REMINDER_GAP_DAYS);
    for (const s of steps) if (s.state === 'due' && resume > today) { s.state = 'planned'; s.date = resume < s.date ? s.date : resume; }
  }
  // a later step already done makes earlier open ones moot
  for (let i = steps.length - 1, later = false; i >= 0; i--) {
    if (later && ['due', 'planned'].includes(steps[i].state)) steps[i].state = 'skipped';
    if (['done', 'waiting'].includes(steps[i].state)) later = true;
  }
  const next = steps.find((s) => s.state === 'waiting') || [...steps].reverse().find((s) => s.state === 'due') || steps.find((s) => s.state === 'planned') || null;
  return { steps, next };
}

const fmt = (v, cur) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(v);

/** What Autopilot will do over the next `days` days, across all invoices. */
export function comingUp(days = 21, today = isoDate()) {
  const settings = autopilotSettings();
  const actions = listActions({});
  const until = addDays(today, days);
  const out = [];
  for (const inv of listInvoices()) {
    if (!isOpen(inv) || !inv.paypalId || notOnCurrentPaypal(inv)) continue;
    const { steps } = planFor(inv, { settings, actions, today });
    const c = getClient(inv.clientId) || {};
    const firmestDue = [...steps].reverse().find((s) => s.state === 'due');
    const firmestWaiting = [...steps].reverse().find((s) => s.state === 'waiting');
    for (const s of steps) {
      if (!['due', 'planned', 'waiting'].includes(s.state) || s.date > until) continue;
      if (s.state === 'due' && s !== firmestDue) continue; // only the firmest overdue step will be sent
      if (s.state === 'waiting' && s !== firmestWaiting) continue; // one draft covers them
      out.push({ date: s.date < today ? today : s.date, state: s.state, tone: s.tone, label: s.label, invoiceId: inv.id, number: inv.number, client: c.name || '', amount: fmt(inv.total, inv.currency) });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : rank(b.tone) - rank(a.tone)));
}

/** Run the plan: draft every step that's due today (or overdue). Returns created drafts. */
let inFlight = null;
export function runAutopilot(today = isoDate()) {
  // one run at a time, so a background run and a button click can't both draft the same reminder
  inFlight ||= runOnce(today).finally(() => (inFlight = null));
  return inFlight;
}

async function runOnce(today) {
  const settings = autopilotSettings();
  if (!settings.enabled) return [];
  const actions = listActions({});
  const created = [];
  for (const inv of listInvoices()) {
    if (!isOpen(inv) || !inv.paypalId || notOnCurrentPaypal(inv)) continue;
    const { steps } = planFor(inv, { settings, actions, today });
    const step = [...steps].reverse().find((s) => s.state === 'due'); // the firmest step that's due
    if (!step) continue;
    if (actions.some((a) => a.status === 'pending' && a.type === 'send_reminder' && a.payload?.invoiceId === inv.id)) continue;
    created.push(await draftReminder(inv, today, { tone: step.tone, origin: 'autopilot' }));
    const daysOverdue = daysBetween(inv.dueDate, today);
    const feeDecided = actions.some((a) => a.type === 'add_late_fee' && a.payload?.invoiceId === inv.id);
    if (step.key === 'final' && settings.feeWithFinal && config.lateFeePercent > 0 && daysOverdue > 0 && !hasLateFee(inv) && !feeDecided) {
      const payload = lateFeeDraft(inv, { clientName: getClient(inv.clientId)?.name || '', daysOverdue });
      created.push(createAction('add_late_fee', payload, { origin: 'autopilot', summary: `Late fee #${inv.number} (${payload.percent}%)` }));
    }
  }
  if (created.length) {
    const n = created.filter((a) => a.type === 'send_reminder').length;
    notify({ kind: 'approval', title: `Autopilot drafted ${n} reminder${n > 1 ? 's' : ''}`, body: 'They are written and waiting for your OK in Collections.', link: '/invoices' });
  }
  return created;
}
