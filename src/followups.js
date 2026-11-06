// Autonomous follow-ups: find overdue invoices and have the AI draft a reminder
// whose tone escalates with lateness. Drafts land in the Follow-ups inbox for approval.
import { config, isoDate, daysBetween } from './config.js';
import { listInvoices } from './db.js';
import { complete, llmAvailable } from './llm.js';
import { createAction, listActions, lateFeeDraft, hasLateFee, cleanText } from './actions.js';
import { notOnCurrentPaypal } from './paypal.js';
import { isOverdue, clientStats, clientName } from './analytics.js';
import { syncInvoices } from './sync.js';

function toneFor(remindersSent, daysOverdue) {
  if (remindersSent >= 2 || daysOverdue > 30) return 'final';
  if (remindersSent === 1 || daysOverdue > 10) return 'firm';
  return 'friendly';
}

function templateReminder(inv, tone, daysOverdue) {
  const name = clientName(inv.clientId).split(' ')[0];
  const amt = new Intl.NumberFormat('en-US', { style: 'currency', currency: inv.currency }).format(inv.total);
  const due = new Date(`${inv.dueDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const sign = config.businessName ? `\n${config.businessName}` : '';
  const body = {
    friendly: `Hi ${name},\n\nHope you're doing well! Just a quick nudge that invoice #${inv.number} for ${amt} ${inv.dueDate >= isoDate() ? 'is due on' : 'was due on'} ${due}. You can pay it securely with the PayPal link in this email.\n\nThanks so much!${sign}`,
    firm: `Hi ${name},\n\nInvoice #${inv.number} for ${amt} is now ${daysOverdue} days past its due date (${due}). Could you please arrange payment this week, or let me know if anything is holding it up?\n\nThank you,${sign}`,
    final: `Hi ${name},\n\nThis is a final reminder that invoice #${inv.number} for ${amt} is ${daysOverdue} days overdue. Please settle it within 3 business days. If there's an issue with the invoice, reply and I'll be glad to help resolve it.\n\nRegards,${sign}`,
  }[tone];
  const subject = { friendly: 'Friendly reminder', firm: 'Payment overdue', final: 'Final reminder' }[tone] + `: invoice #${inv.number}`;
  return { subject, message: body };
}

async function aiReminder(inv, tone, daysOverdue) {
  const st = clientStats(inv.clientId);
  const prompt = `Draft a ${tone} payment reminder email.
Freelancer business: ${config.businessName || '(not set - sign off without a business name)'}
Client: ${clientName(inv.clientId)}
Invoice #${inv.number}: ${inv.currency} ${inv.total} for ${inv.items.map((i) => i.name).join(', ')}
Due date: ${inv.dueDate} (${inv.dueDate >= isoDate() ? 'not overdue yet - write a light, friendly heads-up before the due date' : `${daysOverdue} days overdue`}). Reminders already sent: ${inv.reminders.length}.
Client history: ${st.paidCount} paid invoices, average ${st.avgDaysLate ?? 'n/a'} days late, risk ${st.riskLabel}.
Mention that they can pay via the PayPal link in the email. Max 90 words. Warm but professional; never threatening.
Respond with ONLY JSON: {"subject": "...", "message": "..."}`;
  const { content } = await complete({ system: 'You write concise, professional payment reminder emails. Output JSON only.', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 600 });
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  if (!json.subject || !json.message) throw new Error('bad AI output');
  return { subject: cleanText(json.subject), message: cleanText(json.message) };
}

/** Scan for overdue invoices and create reminder drafts. Returns created actions. */
export async function scanFollowups({ sync = true } = {}) {
  if (sync) await syncInvoices().catch(() => {});
  const today = isoDate();
  const pendingFor = new Set(listActions({ status: 'pending', type: 'send_reminder' }).map((a) => a.payload.invoiceId));
  const created = [];
  for (const inv of listInvoices()) {
    if (!isOverdue(inv, today) || pendingFor.has(inv.id) || !inv.paypalId || notOnCurrentPaypal(inv)) continue;
    const last = inv.reminders.at(-1)?.at;
    if (last && daysBetween(last, today) < config.reminderCooldownDays) continue;
    created.push(await draftReminder(inv, today));
  }
  return [...created, ...draftLateFees(today)];
}

/** Draft one reminder for one invoice (AI first, template if the AI is unavailable). */
export async function draftReminder(inv, today = isoDate()) {
  const daysOverdue = Math.max(0, daysBetween(inv.dueDate, today));
  const tone = daysOverdue === 0 ? 'friendly' : toneFor(inv.reminders.length, daysOverdue);
  let draft;
  let draftedBy = 'ai';
  try {
    if (!llmAvailable()) throw new Error('no llm');
    draft = await aiReminder(inv, tone, daysOverdue);
  } catch {
    draft = templateReminder(inv, tone, daysOverdue);
    draftedBy = 'template';
  }
  return createAction(
    'send_reminder',
    { invoiceId: inv.id, number: inv.number, client: clientName(inv.clientId), amount: inv.total, currency: inv.currency, dueDate: inv.dueDate, daysOverdue, tone, draftedBy, ...draft },
    { origin: 'followup', summary: `Reminder #${inv.number} (${tone})` }
  );
}

/** Late-fee drafts for invoices overdue past the policy threshold (Settings → Late fees). */
export function draftLateFees(today = isoDate()) {
  if (!(config.lateFeePercent > 0)) return [];
  const decided = new Set(listActions({ type: 'add_late_fee' }).map((a) => a.payload.invoiceId));
  const out = [];
  for (const inv of listInvoices()) {
    if (!isOverdue(inv, today) || !inv.paypalId || notOnCurrentPaypal(inv) || hasLateFee(inv) || decided.has(inv.id)) continue;
    const daysOverdue = daysBetween(inv.dueDate, today);
    if (daysOverdue < config.lateFeeAfterDays) continue;
    const payload = lateFeeDraft(inv, { clientName: clientName(inv.clientId), daysOverdue });
    out.push(createAction('add_late_fee', payload, { origin: 'followup', summary: `Late fee #${inv.number} (${payload.percent}%)` }));
  }
  return out;
}
