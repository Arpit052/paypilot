// Autonomous follow-ups: find overdue invoices and have the AI draft a reminder
// whose tone escalates with lateness. Drafts land in the Follow-ups inbox for approval.
import { config, isoDate, daysBetween } from './config.js';
import { listInvoices } from './db.js';
import { complete, llmAvailable } from './llm.js';
import { createAction, listActions, lateFeeDraft, hasLateFee, cleanText } from './actions.js';
import { notOnCurrentPaypal } from './paypal.js';
import { isOverdue, clientStats, clientName } from './analytics.js';
import { syncInvoices } from './sync.js';

export const TONES = ['friendly', 'firm', 'final'];
const rank = (t) => Math.max(0, TONES.indexOf(t));
/** The firmest tone already used on this invoice (null if no reminder yet). */
export const lastTone = (inv) => (inv.reminders || []).reduce((best, r) => (best === null || rank(r.tone) > rank(best) ? r.tone || 'friendly' : best), null);

/** Tone escalates with lateness and reminders sent, and never drops below the last one used. */
export function toneFor(inv, daysOverdue, wanted = null) {
  const sent = (inv.reminders || []).length;
  let t = sent >= 2 || daysOverdue > 30 ? 'final' : sent === 1 || daysOverdue > 10 ? 'firm' : 'friendly';
  if (daysOverdue <= 0 && !sent) t = 'friendly';
  for (const other of [lastTone(inv), wanted]) if (other && rank(other) > rank(t)) t = other;
  return t;
}

function templateReminder(inv, tone, daysOverdue) {
  const name = clientName(inv.clientId).split(' ')[0];
  const amt = new Intl.NumberFormat('en-US', { style: 'currency', currency: inv.currency }).format(inv.total);
  const due = new Date(`${inv.dueDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const who = config.signOff || [config.ownerName, config.businessName].filter(Boolean).join('\n');
  const sign = who ? `\n${who}` : '';
  const body = {
    friendly: `Hi ${name},\n\nHope you're doing well! Just a quick nudge that invoice #${inv.number} for ${amt} ${inv.dueDate >= isoDate() ? 'is due on' : 'was due on'} ${due}. You can pay it securely with the PayPal link in this email.\n\nThanks so much!${sign}`,
    firm: `Hi ${name},\n\nInvoice #${inv.number} for ${amt} ${daysOverdue > 0 ? `is now ${daysOverdue} days past its due date (${due})` : `is due on ${due}`}. Could you please arrange payment this week, or let me know if anything is holding it up?\n\nThank you,${sign}`,
    final: `Hi ${name},\n\nThis is a final reminder that invoice #${inv.number} for ${amt} ${daysOverdue > 0 ? `is ${daysOverdue} days overdue` : `is due on ${due}`}. Please settle it within 3 business days. If there's an issue with the invoice, reply and I'll be glad to help resolve it.\n\nRegards,${sign}`,
  }[tone];
  const subject = { friendly: 'Friendly reminder', firm: daysOverdue > 0 ? 'Payment overdue' : 'Payment reminder', final: 'Final reminder' }[tone] + `: invoice #${inv.number}`;
  return { subject, message: body };
}

async function aiReminder(inv, tone, daysOverdue) {
  const st = clientStats(inv.clientId);
  const prompt = `Draft a ${tone} payment reminder email.
Freelancer business: ${config.businessName || '(not set - sign off without a business name)'}
Client: ${clientName(inv.clientId)}
Invoice #${inv.number}: ${inv.currency} ${inv.total} for ${inv.items.map((i) => i.name).join(', ')}
Due date: ${inv.dueDate} (${inv.dueDate >= isoDate() ? 'not overdue yet - write a light, friendly heads-up before the due date' : `${daysOverdue} days overdue`}). Reminders already sent: ${inv.reminders.length}${lastTone(inv) ? ` (the last one was ${lastTone(inv)}, so don't sound softer than that)` : ''}.
Client history: ${st.paidCount} paid invoices, average ${st.avgDaysLate ?? 'n/a'} days late, risk ${st.riskLabel}.
Mention that they can pay via the PayPal link in the email. ${{ warm: 'Warm, friendly and professional. Max 90 words.', neutral: 'Neutral, matter-of-fact and polite. Max 80 words.', brief: 'Very short and to the point: 2-3 sentences, max 45 words.' }[config.reminderStyle || 'warm']} Never threatening.
Sign off as: ${config.signOff || [config.ownerName, config.businessName].filter(Boolean).join(', ') || 'no name'}.${config.businessEmail ? ` Questions can go to ${config.businessEmail}.` : ''}${config.aiInstructions ? `\nThe owner's own instructions: ${config.aiInstructions}` : ''}
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
/** Write a reminder (AI first, template if the AI is unavailable) without saving anything. */
export async function composeReminder(inv, today = isoDate(), wanted = null) {
  const daysOverdue = Math.max(0, daysBetween(inv.dueDate, today));
  const tone = toneFor(inv, daysOverdue, wanted);
  try {
    if (!llmAvailable()) throw new Error('no llm');
    return { tone, daysOverdue, draft: await aiReminder(inv, tone, daysOverdue), draftedBy: 'ai' };
  } catch {
    return { tone, daysOverdue, draft: templateReminder(inv, tone, daysOverdue), draftedBy: 'template' };
  }
}

export async function draftReminder(inv, today = isoDate(), { tone: wanted = null, origin = 'followup' } = {}) {
  const { tone, daysOverdue, draft, draftedBy } = await composeReminder(inv, today, wanted);
  return createAction(
    'send_reminder',
    { invoiceId: inv.id, number: inv.number, client: clientName(inv.clientId), amount: inv.total, currency: inv.currency, dueDate: inv.dueDate, daysOverdue, tone, draftedBy, ...draft },
    { origin, summary: `Reminder #${inv.number} (${tone})` }
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
