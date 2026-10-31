// AI money brief: one model call that turns the computed numbers into a short,
// prioritised summary. The model never invents figures - it only sees what we computed.
import { config, isoDate, daysBetween } from './config.js';
import { listInvoices, listClients, listSchedules } from './db.js';
import { complete, llmAvailable, LlmError } from './llm.js';
import { earningsSummary, forecastCashflow, clientStats, clientName, isOverdue } from './analytics.js';
import { listActions } from './actions.js';

const CACHE_MS = 10 * 60 * 1000;
let cache = null;

export function briefFacts(today = isoDate()) {
  const overdue = listInvoices()
    .filter((i) => isOverdue(i, today))
    .map((i) => ({
      invoice: i.number,
      client: clientName(i.clientId),
      amount: i.total,
      currency: i.currency,
      daysOverdue: daysBetween(i.dueDate, today),
      remindersSent: i.reminders.length,
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  const risky = listClients()
    .map((c) => ({ client: c.name, ...clientStats(c.id, today) }))
    .filter((c) => c.riskLabel !== 'low')
    .map((c) => ({ client: c.client, risk: c.riskLabel, avgDaysLate: c.avgDaysLate, outstanding: c.outstanding }));
  return {
    today,
    business: config.businessName,
    thisMonth: earningsSummary({}, today),
    next30Days: (({ expected, bestCase }) => ({ expected, bestCase }))(forecastCashflow(30, today)),
    overdue,
    riskyClients: risky,
    pendingApprovals: listActions({ status: 'pending' }).length,
    activeRecurringInvoices: listSchedules().filter((s) => s.active).length,
  };
}

export async function moneyBrief({ refresh = false } = {}) {
  if (!llmAvailable()) throw Object.assign(new LlmError('AI is not configured.'), { status: 503 });
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return { ...cache.brief, cached: true };
  const facts = briefFacts();
  const { content } = await complete({
    system:
      'You are a sharp, friendly CFO assistant for a freelancer. Write in plain US English. ' +
      'Use ONLY the numbers in the JSON you are given; never invent figures. Be specific: name clients and invoice numbers.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Here is today's data:\n${JSON.stringify(facts)}\n\n` +
              'Write a money brief in exactly this format (max 110 words total):\n' +
              '**Where you stand**\n- 2-3 short bullets\n**Do next**\n- 2-3 short, specific actions, most urgent first',
          },
        ],
      },
    ],
    maxTokens: 700,
  });
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  if (!text) throw new LlmError('The AI returned an empty brief. Try again in a moment.');
  const brief = { text, generatedAt: new Date().toISOString() };
  cache = { at: Date.now(), brief };
  return brief;
}
