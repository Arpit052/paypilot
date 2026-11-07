// Money brief: a systematic, numbers-first report (computed in code, always available)
// plus an AI-written headline and prioritised recommendations on top.
import { config, isoDate, daysBetween } from './config.js';
import { listInvoices, listClients, listSchedules } from './db.js';
import { complete, llmAvailable } from './llm.js';
import { forecastFromModel } from './budget.js';
import {
  earningsSummary,
  forecastCashflow,
  clientStats,
  clientName,
  isOverdue,
  isOpen,
  topCustomers,
  lifetimeStats,
} from './analytics.js';
import { listActions } from './actions.js';

const CACHE_MS = 10 * 60 * 1000;
let aiCache = null;

const cur = (map) => map?.[config.currency] ?? Object.values(map || {})[0] ?? 0;

function monthBounds(today) {
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const prevFirst = new Date(Date.UTC(y, m - 2, 1));
  const prevLast = new Date(Date.UTC(y, m - 1, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  const name = (d) => d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from: iso(first), label: name(first), prevFrom: iso(prevFirst), prevTo: iso(prevLast), prevLabel: name(prevFirst) };
}

/** All the numbers, grouped the way the brief presents them. */
export function briefFacts(today = isoDate()) {
  const mb = monthBounds(today);
  const thisMonth = earningsSummary({ from: mb.from, to: today }, today);
  const lastMonth = earningsSummary({ from: mb.prevFrom, to: mb.prevTo }, today);
  const earnedNow = cur(thisMonth.earned);
  const earnedPrev = cur(lastMonth.earned);

  // overdue grouped by customer
  const byClient = new Map();
  for (const i of listInvoices()) {
    if (!isOverdue(i, today)) continue;
    const r = byClient.get(i.clientId) || { client: clientName(i.clientId), amount: 0, invoices: [], maxDaysOverdue: 0, remindersSent: 0, currency: i.currency };
    r.amount = Math.round((r.amount + i.total) * 100) / 100;
    r.invoices.push(i.number);
    r.maxDaysOverdue = Math.max(r.maxDaysOverdue, daysBetween(i.dueDate, today));
    r.remindersSent += i.reminders.length;
    byClient.set(i.clientId, r);
  }
  const overdueByCustomer = [...byClient.values()].sort((a, b) => b.amount - a.amount);

  const fc = forecastFromModel(30, today);
  const watchList = listClients()
    .map((c) => ({ client: c.name, ...clientStats(c.id, today) }))
    .filter((c) => ['medium', 'high'].includes(c.riskLabel))
    .map((c) => ({ client: c.client, risk: c.riskLabel, avgDaysLate: c.avgDaysLate, outstanding: c.outstanding }));

  return {
    today,
    currency: config.currency,
    business: config.businessName,
    lifetime: lifetimeStats(today),
    thisMonth: {
      label: mb.label,
      earned: earnedNow,
      paidInvoices: thisMonth.paidInvoices,
      lastMonthLabel: mb.prevLabel,
      lastMonthEarned: earnedPrev,
      changePct: earnedPrev ? Math.round(((earnedNow - earnedPrev) / earnedPrev) * 100) : null,
    },
    topCustomers: topCustomers({ limit: 3 }),
    overdue: { total: cur(thisMonth.overdue), invoices: thisMonth.overdueInvoices, byCustomer: overdueByCustomer },
    outstanding: { total: cur(thisMonth.outstanding), invoices: listInvoices().filter(isOpen).length },
    next30Days: { expected: cur(fc.expected), bestCase: cur(fc.bestCase) },
    watchList,
    pendingApprovals: listActions({ status: 'pending' }).length,
    activeRecurring: listSchedules().filter((s) => s.active).length,
  };
}

async function aiRecommendations(facts) {
  const { content } = await complete({
    system:
      'You are a sharp, friendly CFO assistant for a small business owner. Plain US English. ' +
      'Use ONLY numbers from the JSON; never invent figures. Name clients and invoice numbers.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Data:\n${JSON.stringify(facts)}\n\n` +
              'Reply in exactly this format:\n' +
              'HEADLINE: <one sentence, max 20 words, the single most important takeaway>\n' +
              '- <recommended action 1, most urgent, specific>\n- <action 2>\n- <action 3>\n' +
              'Max 3-4 actions, each under 25 words. No other text.',
          },
        ],
      },
    ],
    maxTokens: 2000,
  });
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  const headline = /HEADLINE:\s*(.+)/i.exec(text)?.[1]?.trim() || null;
  const actions = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, ''));
  if (!headline && !actions.length) throw new Error('empty AI reply');
  return { headline, actions };
}

/** Full brief: computed sections + AI recommendations (cached 10 min; numbers always fresh). */
export async function moneyBrief({ refresh = false } = {}) {
  const facts = briefFacts();
  let ai = null;
  let aiError = null;
  let cached = false;
  if (!refresh && aiCache && Date.now() - aiCache.at < CACHE_MS) {
    ai = aiCache.ai;
    cached = true;
  } else if (llmAvailable()) {
    try {
      ai = await aiRecommendations(facts);
      aiCache = { at: Date.now(), ai };
    } catch (e) {
      aiError = e.message;
    }
  } else aiError = 'AI is not configured.';
  return { generatedAt: new Date().toISOString(), facts, ai, aiError, cached };
}
