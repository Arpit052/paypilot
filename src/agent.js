// The PayPilot agent: system prompt, tool definitions and handlers.
import { config, isoDate, daysBetween } from './config.js';
import { listInvoices, findClient, findInvoice, getClient, kvGet, kvSet } from './db.js';
import { runToolLoop } from './llm.js';
import { createAction, normaliseInvoiceDraft, normaliseScheduleDraft, lateFeeDraft, hasLateFee, cleanText } from './actions.js';
import { clientStats, earningsSummary, forecastCashflow, isOpen, isOverdue, clientName, topCustomers } from './analytics.js';
import { isMock } from './paypal.js';
import { toneFor, lastTone, relationshipOf } from './followups.js';
import { estimateBudget, budgetProfile, forecastFromModel } from './budget.js';
import { retainerOffers } from './offers.js';
import { growthSummary } from './growth.js';
import { suggestEarlyPay } from './earlypay.js';
import { typeOf, professionLabel } from './business.js';

function systemPrompt() {
  const today = isoDate();
  const bt = typeOf(config.businessType);
  const prof = professionLabel(config.businessType, config.businessTypeOther);
  return `You are PayPilot, an AI payments assistant for an independent professional or small business (${prof.toLowerCase()}${config.businessType === 'other' ? '' : `: ${bt.blurb.toLowerCase()}`})${config.businessName ? ` called "${config.businessName}"` : ''}. A fixed monthly plan for a client is called a "${bt.retainer}".
You help them get paid through PayPal: create and send invoices, chase late payments, cancel invoices, answer questions about their earnings and clients, tell them whether they can afford a purchase, and spot clients who should be offered a ${bt.retainer}.

Today is ${today}. Default currency: ${config.currency}. PayPal environment: ${isMock() ? 'mock (offline simulation)' : config.paypal.mode}.

How you work:
- You can read data with list_invoices, get_client_insights, get_earnings_summary and forecast_cashflow. Use them instead of guessing numbers.
- You NEVER send, remind or cancel directly. You call propose_invoice / propose_reminder / propose_late_fee / propose_cancel, which put an approval card in the user's UI. Nothing reaches PayPal or the client until the user clicks Approve. After proposing, tell the user briefly what you prepared and ask them to review the approval slip on the right. Never claim an invoice "was sent" unless the user has approved it.
- When the user describes work done (in text, or in a screenshot of a chat/email/brief), extract client name, client email, line items (name, quantity, unit price), currency and due date. Convert phrases like "in 2 weeks" to due_in_days. PayPal invoices only support these currencies: ${config.paypalCurrencies.join(', ')}. If the user gives amounts in another currency (e.g. rupees/INR), don't convert or guess: tell them PayPal can't invoice in that currency and ask which supported currency to use (suggest USD). If the client email is missing and the client isn't already known, ask for it instead of inventing one. Never invent prices. The business's usual payment terms are ${config.defaultTermsDays ?? 7} days.${config.aiInstructions ? ` Their own instructions: ${config.aiInstructions}` : ''}
- To create an invoice, call propose_invoice directly. It already looks up the client (email and payment risk), so do NOT call list_invoices or get_client_insights first. If a known client's email is missing, you may pass just client_name. For high-risk clients the system automatically adds a suggested 50% deposit (paid upfront through PayPal's partial-payment option) unless the user specified one; tell the user, and say they can remove it on the slip. For medium risk, suggest a shorter due date. If the user asks for an early-pay discount, pass early_pay_percent (the slip shows a suggested % from the client's history: 3% for late payers, 2% for medium or new clients, none for on-time clients). If they mention a link to the final files (Figma, Drive, Dropbox), pass delivery_url: the client gets a page that unlocks the files only after paying.
- Sales tax: only add tax_percent if the user mentions tax (e.g. "add 8% sales tax"). Default tax: ${config.defaultTaxPercent}%.
- "Best customer?" -> get_top_customers.
- "Can I afford X?", "Can I buy a $2,000 laptop next month?", "Is it safe to spend Y on Z?" -> check_budget. Pass price and date (convert "next month" to a concrete date; if no date is given use today + 14 days). If the user tells you how much money they have now, their monthly costs or a buffer, pass those; otherwise the saved values are used, and if cash_now is unknown (saved value 0) say the answer assumes they have nothing saved and invite them to tell you. Answer with the verdict first, then the chance, the most they can safely spend on that date (maxSafe.p80), the likely shortfall (if any), the earliest safe date and the invoice to watch. The check already counts their bills, tax set-aside and PayPal fees from the Budget page, and requires the 30 days after buying to stay above their buffer. Mention it's a simulation of thousands of possible futures based on how each client has paid before. Never promise certainty.
- "Who should I offer a retainer?", "How can I earn more from my clients?" -> suggest_retainers. Explain the offer in money terms for both sides (what the client saves, what the business gains a year, how many fewer invoices). The user sends the offer themselves from the Clients page; you can't email clients.
- "Where should I focus?", "Which clients or industries are best?", "How do I grow?", "What work should I push?" -> get_growth_insights. Name the industry and work area, back every claim with its number (billed, % on time, days to pay, trend vs the 3 months before), and give 2-3 concrete next steps from its opportunities. Point to the Growth page for the full picture.
- Recurring work ("every month", "weekly retainer"): use propose_recurring. Explain that each period a new draft will appear for approval; nothing is sent automatically.
- For reminders, write the subject and message yourself. Match tone to how late it is: friendly (first nudge), firm (second), final (repeated/very late). Match the *voice* to the client's history (call get_client_insights first): a good client who pays on time gets a warm, personal check-in ("Hope all is well! Just floating invoice #…"); a repeat late payer gets a formal, specific note with the invoice number, days overdue, the payment terms (e.g. Net 15), a pay-by date, and the late-fee date if late fees are on (${config.lateFeePercent > 0 ? `${config.lateFeePercent}% after ${config.lateFeeAfterDays} days overdue` : 'late fees are off, so don\'t mention one'}). Be professional and human, never rude. Sign off as ${config.businessName}.
- Late fees: policy is ${config.lateFeePercent}% once an invoice is ${config.lateFeeAfterDays}+ days overdue. Use propose_late_fee when the user asks to add one (or suggest it for very late invoices). Only one late fee per invoice; it's added as a separate, untaxed line on the PayPal invoice after approval.
- Risk labels are none (reliable payer), low, medium or high. Days late are whole days.
- Reply in clear, friendly English (US business tone). Keep replies short and skimmable; use **bold** for key amounts.`;
}

const invoiceRef = { type: 'string', description: 'Invoice number (e.g. "0012") or id' };

export const tools = [
  {
    name: 'list_invoices',
    description: 'List invoices, optionally filtered by status and/or client.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'open', 'overdue', 'paid', 'cancelled'], description: 'Default: all' },
        client: { type: 'string', description: 'Client name or email (partial match ok)' },
      },
    },
  },
  {
    name: 'get_client_insights',
    description: 'Payment history and risk profile for one client: totals, outstanding, average days late, risk score.',
    parameters: {
      type: 'object',
      properties: { client: { type: 'string', description: 'Client name or email' } },
      required: ['client'],
    },
  },
  {
    name: 'get_earnings_summary',
    description: 'Earned (paid), billed, outstanding and overdue totals for a date range. Defaults to the current month.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
  },
  {
    name: 'forecast_cashflow',
    description: 'Expected incoming payments over the next N days, weighted by each client\'s payment behaviour.',
    parameters: { type: 'object', properties: { days: { type: 'number', description: 'Default 30' } } },
  },
  {
    name: 'get_top_customers',
    description: 'Clients ranked by total money actually paid (best customers first).',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Default 5' } } },
  },
  {
    name: 'check_budget',
    description: 'Budget Estimator: probability the user can afford a purchase of `price` on `date`, from a Monte Carlo simulation of when each client will pay. Returns chance, likely shortfall, earliest safe dates and the invoices that decide it.',
    parameters: {
      type: 'object',
      properties: {
        price: { type: 'number', description: 'Cost of the thing they want to buy, in the main currency' },
        date: { type: 'string', description: 'YYYY-MM-DD when they want to buy it' },
        item: { type: 'string', description: 'What it is, e.g. "laptop"' },
        cash_now: { type: 'number', description: 'Money they have right now, if they said so' },
        monthly_costs: { type: 'number', description: 'Their everyday monthly spending, if they said so' },
        tax_pct: { type: 'number', description: 'Percent of income they set aside for tax, if they said so' },
        instalments: { type: 'number', description: 'Number of monthly instalments if they would pay in parts (1 = all at once)' },
        buffer: { type: 'number', description: 'Money they want to keep untouched, if they said so' },
      },
      required: ['price', 'date'],
    },
  },
  {
    name: 'suggest_retainers',
    description: 'Clients who buy almost every month and would suit a fixed monthly plan, with a suggested price, discount and the yearly gain for the business.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_growth_insights',
    description: 'What the last 12 months of invoices say about growth: client segments (champions, slipping away...), industries ranked by value and payment speed, work areas with their 3-month trend, income concentration, days sales outstanding, and concrete opportunities.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_invoice',
    description: 'Prepare a PayPal invoice for the user to review and approve. Does NOT send it.',
    parameters: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        client_email: { type: 'string', description: 'Required for new clients; optional for known ones' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short description of the work' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
            },
            required: ['name', 'quantity', 'unit_price'],
          },
        },
        currency: { type: 'string', enum: config.paypalCurrencies, description: `ISO code, default ${config.currency}` },
        due_in_days: { type: 'number', description: 'Days until due (default: the payment terms in Settings)' },
        due_date: { type: 'string', description: 'YYYY-MM-DD (overrides due_in_days)' },
        note: { type: 'string', description: 'Optional friendly note shown on the invoice' },
        tax_percent: { type: 'number', description: 'Sales tax percent, only if the user asked for tax' },
        deposit_percent: { type: 'number', description: 'Upfront deposit as % of total (PayPal partial payment). 0 = no deposit.' },
        early_pay_percent: { type: 'number', description: 'Discount % (1-10) if the client pays within 48 hours. Only if the user asks for an early-pay discount.' },
        delivery_url: { type: 'string', description: 'Link to the final work (Figma, Drive, Dropbox). The client only sees it after paying ("pay to unlock").' },
      },
      required: ['client_name', 'items'],
    },
  },
  {
    name: 'propose_recurring',
    description: 'Prepare a recurring invoice schedule (weekly or monthly) for approval. Each period creates a new draft for the user to approve.',
    parameters: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        client_email: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, quantity: { type: 'number' }, unit_price: { type: 'number' } },
            required: ['name', 'quantity', 'unit_price'],
          },
        },
        frequency: { type: 'string', enum: ['weekly', 'monthly'] },
        start_date: { type: 'string', description: 'YYYY-MM-DD of the first invoice (default today)' },
        due_in_days: { type: 'number', description: 'Payment terms for each invoice (default: the payment terms in Settings)' },
        currency: { type: 'string', enum: config.paypalCurrencies },
        tax_percent: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['client_name', 'client_email', 'items', 'frequency'],
    },
  },
  {
    name: 'propose_reminder',
    description: 'Prepare a payment reminder for an open invoice, for the user to approve. Does NOT send it.',
    parameters: {
      type: 'object',
      properties: {
        invoice: invoiceRef,
        tone: { type: 'string', enum: ['friendly', 'firm', 'final'] },
        subject: { type: 'string' },
        message: { type: 'string', description: 'The reminder text the client will receive' },
      },
      required: ['invoice', 'tone', 'subject', 'message'],
    },
  },
  {
    name: 'propose_late_fee',
    description: 'Prepare a late fee for an overdue invoice, for the user to approve. On approval it is added as a line on the PayPal invoice and the client is re-notified.',
    parameters: {
      type: 'object',
      properties: {
        invoice: invoiceRef,
        percent: { type: 'number', description: 'Percent of the invoice total. Omit to use the business policy.' },
      },
      required: ['invoice'],
    },
  },
  {
    name: 'propose_cancel',
    description: 'Prepare cancellation of an open invoice, for the user to approve.',
    parameters: {
      type: 'object',
      properties: { invoice: invoiceRef, reason: { type: 'string' } },
      required: ['invoice'],
    },
  },
];

function invoiceView(i, today) {
  return {
    number: i.number,
    client: clientName(i.clientId),
    company: getClient(i.clientId)?.company || undefined,
    total: i.total,
    currency: i.currency,
    status: isOverdue(i, today) ? 'OVERDUE' : i.status,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    paidDate: i.paidDate || undefined,
    daysOverdue: isOverdue(i, today) ? daysBetween(i.dueDate, today) : undefined,
    remindersSent: i.reminders?.length || 0,
    items: i.items.map((it) => `${it.quantity} × ${it.name} @ ${it.unitPrice}`),
  };
}

/** Build tool handlers bound to a list that collects actions created this turn. */
function makeHandlers(created) {
  const today = isoDate();
  return {
    list_invoices({ status = 'all', client }) {
      let invs = listInvoices();
      if (client) {
        const c = findClient(client);
        if (!c) return { error: `No client matching "${client}"` };
        invs = invs.filter((i) => i.clientId === c.id);
      }
      const f = {
        all: () => true,
        open: isOpen,
        overdue: (i) => isOverdue(i, today),
        paid: (i) => ['PAID', 'MARKED_AS_PAID'].includes(i.status),
        cancelled: (i) => i.status === 'CANCELLED',
      }[status] || (() => true);
      const list = invs.filter(f);
      return { count: list.length, invoices: list.slice(0, 30).map((i) => invoiceView(i, today)) };
    },

    get_client_insights({ client }) {
      const c = findClient(client);
      if (!c) return { known: false, message: `"${client}" is a new client - no history yet.` };
      return { known: true, name: c.name, company: c.company || undefined, email: c.email, ...clientStats(c.id, today) };
    },

    get_earnings_summary({ from, to }) {
      return earningsSummary({ from, to }, today);
    },

    forecast_cashflow({ days = 30 }) {
      return forecastFromModel(Math.min(Math.max(Number(days) || 30, 1), 180), today);
    },

    propose_invoice(input) {
      const known = findClient(input.client_email) || findClient(input.client_name);
      const risk = known ? clientStats(known.id, today) : null;
      // Risk-based deposit: if the client usually pays late and no deposit was specified,
      // suggest collecting 50% upfront (PayPal partial payment).
      const autoDeposit = input.deposit_percent === undefined && !(input.early_pay_percent > 0) && risk?.riskLabel === 'high';
      const draft = normaliseInvoiceDraft({
        clientName: input.client_name || known?.name,
        clientEmail: input.client_email || known?.email,
        items: input.items,
        currency: input.currency,
        dueInDays: input.due_in_days,
        dueDate: input.due_date,
        note: input.note,
        taxPercent: input.tax_percent,
        depositPercent: autoDeposit ? 50 : input.deposit_percent,
        depositSuggested: autoDeposit,
        earlyPayPercent: input.early_pay_percent,
        deliveryUrl: input.delivery_url,
      });
      draft.risk = risk ? { label: risk.riskLabel, avgDaysLate: risk.avgDaysLate, overdueCount: risk.overdueCount } : null;
      draft.earlyPaySuggested = suggestEarlyPay(known?.id, draft.subtotal);
      const a = createAction('create_invoice', draft, {
        summary: `Invoice ${draft.clientName} · ${draft.currency} ${draft.total}`,
      });
      created.push(a);
      return {
        status: 'awaiting_user_approval',
        action_id: a.id,
        subtotal: draft.subtotal,
        tax: draft.tax,
        total: draft.total,
        currency: draft.currency,
        dueDate: draft.dueDate,
        deposit: draft.depositAmount ? { amount: draft.depositAmount, autoSuggested: draft.depositSuggested } : null,
        clientRisk: draft.risk,
        earlyPay: draft.earlyPayPercent ? { percent: draft.earlyPayPercent, discount: draft.earlyPayAmount, windowHours: 48 } : null,
        earlyPaySuggestion: draft.earlyPaySuggested,
        payToUnlock: Boolean(draft.deliveryUrl),
      };
    },

    check_budget({ price, date, item, cash_now, monthly_costs, buffer, tax_pct, instalments }) {
      const prof = budgetProfile();
      const r = estimateBudget({ price, date, item, cashNow: cash_now, everyday: monthly_costs, buffer, taxPct: tax_pct, instalments, save: false }, today);
      const { timeline, balance, drivers, ...rest } = r;
      return {
        ...rest,
        cashNowWasSaved: cash_now === undefined,
        cashNowUnknown: cash_now === undefined && !prof.cashNow,
        drivers: drivers.slice(0, 5),
        page: '/budget',
      };
    },

    get_growth_insights() {
      return { ...growthSummary(today), page: '/growth' };
    },

    suggest_retainers() {
      const offers = retainerOffers(today);
      if (!offers.length) return { offers: [], message: 'No client buys regularly enough right now for a retainer to make sense.' };
      return {
        offers: offers.map((o) => ({
          client: o.client,
          company: o.company || undefined,
          monthsActive: `${o.pattern.activeMonths} of the last ${o.pattern.months} months`,
          usualWork: o.pattern.usual,
          averagePerMonthNow: o.pattern.perMonth,
          typicalMonthWhenTheyBuy: o.pattern.perActiveMonth,
          suggestedPrice: o.offer.price,
          discountPercent: o.offer.discount,
          clientSavesPerMonth: o.offer.clientSaves,
          yearlyNow: o.offer.yearNow,
          yearlyOnPlan: o.offer.yearPlan,
          yearlyChange: o.offer.yearChange,
          invoicesPerYearNow: o.offer.invoicesNow,
          clientAvgDaysLate: o.offer.payment.client,
          retainerClientsAvgDaysLate: o.offer.payment.retainerClients,
          currency: o.currency,
        })),
        where: 'Clients page, "Suggested retainers"',
      };
    },

    get_top_customers({ limit = 5 }) {
      return { customers: topCustomers({ limit: Math.min(Math.max(Number(limit) || 5, 1), 20) }) };
    },

    propose_recurring(input) {
      const known = findClient(input.client_email) || findClient(input.client_name);
      const d = normaliseScheduleDraft({
        clientName: input.client_name || known?.name,
        clientEmail: input.client_email || known?.email,
        items: input.items,
        currency: input.currency,
        taxPercent: input.tax_percent,
        frequency: input.frequency,
        startDate: input.start_date,
        dueInDays: input.due_in_days,
        note: input.note,
      });
      const a = createAction('create_schedule', d, { summary: `Recurring ${d.frequency} · ${d.clientName} · ${d.currency} ${d.total}` });
      created.push(a);
      return { status: 'awaiting_user_approval', action_id: a.id, frequency: d.frequency, firstDraftOn: d.startDate, totalPerInvoice: d.total };
    },

    propose_reminder({ invoice, tone = 'friendly', subject, message }) {
      const inv = findInvoice(invoice);
      if (!inv) return { error: `Invoice "${invoice}" not found` };
      if (!isOpen(inv)) return { error: `Invoice #${inv.number} is ${inv.status}; no reminder needed` };
      const asked = tone;
      tone = toneFor(inv, Math.max(0, daysBetween(inv.dueDate, today)), asked);
      if (tone !== asked) return { error: `A ${lastTone(inv) || tone} reminder was already sent for #${inv.number}, so the next one can't be softer. Rewrite it with tone "${tone}" and call propose_reminder again.` };
      const rel = relationshipOf(inv.clientId, today);
      const a = createAction(
        'send_reminder',
        { invoiceId: inv.id, number: inv.number, client: clientName(inv.clientId), amount: inv.total, currency: inv.currency, dueDate: inv.dueDate, tone, voice: rel.key, voiceLabel: rel.label, subject: cleanText(subject), message: cleanText(message) },
        { summary: `Reminder #${inv.number} (${tone})` }
      );
      created.push(a);
      return { status: 'awaiting_user_approval', action_id: a.id };
    },

    propose_late_fee({ invoice, percent }) {
      const inv = findInvoice(invoice);
      if (!inv) return { error: `Invoice "${invoice}" not found` };
      if (!isOpen(inv)) return { error: `Invoice #${inv.number} is ${inv.status}; no late fee needed` };
      if (hasLateFee(inv)) return { error: `Invoice #${inv.number} already has a late fee` };
      let payload;
      try {
        payload = lateFeeDraft(inv, {
          percent: percent ?? config.lateFeePercent,
          clientName: clientName(inv.clientId),
          daysOverdue: isOverdue(inv, today) ? daysBetween(inv.dueDate, today) : 0,
        });
      } catch (e) {
        return { error: e.message };
      }
      const a = createAction('add_late_fee', payload, { summary: `Late fee #${inv.number} (${payload.percent}%)` });
      created.push(a);
      return { status: 'awaiting_user_approval', action_id: a.id, fee: payload.fee, new_total: payload.newTotal };
    },

    propose_cancel({ invoice, reason }) {
      const inv = findInvoice(invoice);
      if (!inv) return { error: `Invoice "${invoice}" not found` };
      if (!isOpen(inv)) return { error: `Invoice #${inv.number} is ${inv.status}; cannot cancel` };
      const a = createAction(
        'cancel_invoice',
        { invoiceId: inv.id, number: inv.number, client: clientName(inv.clientId), amount: inv.total, currency: inv.currency, reason: reason || '' },
        { summary: `Cancel #${inv.number}` }
      );
      created.push(a);
      return { status: 'awaiting_user_approval', action_id: a.id };
    },
  };
}

// ---------- sessions (in-memory chat history) ----------
const sessions = new Map();
const MAX_TURNS = 12;

function stripImages(messages) {
  return messages.map((m) =>
    m.role !== 'user'
      ? m
      : { ...m, content: m.content.map((c) => (c.type === 'image' ? { type: 'text', text: '[image shared earlier]' } : c)) }
  );
}

// ---------- transcript (what the Assistant page shows) ----------
// Kept in the database so the conversation survives switching tabs, reloading the
// page, or leaving while the AI is still thinking: the reply is saved when it's ready.
const TRANSCRIPT_MAX = 80;
const tKey = (id) => `chat:${id}`;

export function getTranscript(id) {
  const t = kvGet(tKey(id)) || { messages: [], pending: null };
  // a reply that never came back (e.g. the app was restarted mid-answer)
  if (t.pending && Date.now() - Date.parse(t.pending.since) > 3 * 60 * 1000) {
    t.pending = null;
    t.messages.push({ role: 'err', text: "That answer didn't finish. Please send your message again.", at: new Date().toISOString() });
    kvSet(tKey(id), t);
  }
  return t;
}
function saveTranscript(id, t) {
  kvSet(tKey(id), { ...t, messages: t.messages.slice(-TRANSCRIPT_MAX) });
}

export function resetSession(id) {
  sessions.delete(id);
  kvSet(tKey(id), { messages: [], pending: null });
}

/** Like chat(), but records the exchange in the transcript (used by the web app). */
export async function chatWithTranscript(sessionId, input) {
  const t = getTranscript(sessionId);
  const at = new Date().toISOString();
  t.messages.push({ role: 'user', text: String(input.text || '').slice(0, 4000), image: Boolean(input.image), at });
  t.pending = { since: at };
  saveTranscript(sessionId, t);
  try {
    const r = await chat(sessionId, input);
    const done = getTranscript(sessionId);
    done.messages.push({ role: 'bot', text: r.reply || 'Done.', tools: [...new Set(r.tools)], at: new Date().toISOString() });
    done.pending = null;
    saveTranscript(sessionId, done);
    return r;
  } catch (e) {
    const failed = getTranscript(sessionId);
    failed.messages.push({ role: 'err', text: e.message, at: new Date().toISOString() });
    failed.pending = null;
    saveTranscript(sessionId, failed);
    throw e;
  }
}

/**
 * Handle one chat turn.
 * @param {string} sessionId
 * @param {{text?: string, image?: {mediaType: string, data: string}}} input
 */
export async function chat(sessionId, { text, image }) {
  const turns = sessions.get(sessionId) || [];
  const userContent = [];
  if (image) userContent.push({ type: 'image', mediaType: image.mediaType, data: image.data });
  userContent.push({ type: 'text', text: text?.trim() || 'Please create an invoice from this screenshot.' });

  const history = turns.flat();
  const created = [];
  const toolLog = [];
  const { text: reply, messages } = await runToolLoop({
    system: systemPrompt(),
    messages: [...history, { role: 'user', content: userContent }],
    tools,
    handlers: makeHandlers(created),
    onToolCall: (call) => toolLog.push(call.name),
  });

  // store this turn (everything after the old history), with images stripped
  turns.push(stripImages(messages.slice(history.length)));
  sessions.set(sessionId, turns.slice(-MAX_TURNS));
  return { reply, actions: created, tools: toolLog };
}
