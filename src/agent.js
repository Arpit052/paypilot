// The PayPilot agent: system prompt, tool definitions and handlers.
import { config, isoDate, daysBetween } from './config.js';
import { listInvoices, findClient, findInvoice } from './db.js';
import { runToolLoop } from './llm.js';
import { createAction, normaliseInvoiceDraft, normaliseScheduleDraft } from './actions.js';
import { clientStats, earningsSummary, forecastCashflow, isOpen, isOverdue, clientName, topCustomers } from './analytics.js';
import { isMock } from './paypal.js';

function systemPrompt() {
  const today = isoDate();
  return `You are PayPilot, an AI payments assistant for a freelancer whose business is "${config.businessName}".
You help them get paid through PayPal: create and send invoices, chase late payments, cancel invoices, and answer questions about their earnings and clients.

Today is ${today}. Default currency: ${config.currency}. PayPal environment: ${isMock ? 'mock (offline simulation)' : config.paypal.mode}.

How you work:
- You can read data with list_invoices, get_client_insights, get_earnings_summary and forecast_cashflow. Use them instead of guessing numbers.
- You NEVER send, remind or cancel directly. You call propose_invoice / propose_reminder / propose_cancel, which put an approval card in the user's UI. Nothing reaches PayPal or the client until the user clicks Approve. After proposing, tell the user briefly what you prepared and ask them to review the approval slip on the right. Never claim an invoice "was sent" unless the user has approved it.
- When the user describes work done (in text, or in a screenshot of a chat/email/brief), extract client name, client email, line items (name, quantity, unit price), currency and due date. Convert phrases like "in 2 weeks" to due_in_days. If the client email is missing and the client isn't already known, ask for it instead of inventing one. Never invent prices.
- To create an invoice, call propose_invoice directly. It already looks up the client (email and payment risk), so do NOT call list_invoices or get_client_insights first. If a known client's email is missing, you may pass just client_name. For high-risk clients the system automatically adds a suggested 50% deposit (paid upfront through PayPal's partial-payment option) unless the user specified one; tell the user, and say they can remove it on the slip. For medium risk, suggest a shorter due date.
- Sales tax: only add tax_percent if the user mentions tax (e.g. "add 8% sales tax"). Default tax: ${config.defaultTaxPercent}%.
- "Best customer?" -> get_top_customers.
- Recurring work ("every month", "weekly retainer"): use propose_recurring. Explain that each period a new draft will appear for approval; nothing is sent automatically.
- For reminders, write the subject and message yourself. Match tone to how late it is: friendly (first nudge), firm (second), final (repeated/very late). Be professional and human, never rude. Sign off as ${config.businessName}.
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
        currency: { type: 'string', description: `ISO code, default ${config.currency}` },
        due_in_days: { type: 'number', description: 'Days until due (default 7)' },
        due_date: { type: 'string', description: 'YYYY-MM-DD (overrides due_in_days)' },
        note: { type: 'string', description: 'Optional friendly note shown on the invoice' },
        tax_percent: { type: 'number', description: 'Sales tax percent, only if the user asked for tax' },
        deposit_percent: { type: 'number', description: 'Upfront deposit as % of total (PayPal partial payment). 0 = no deposit.' },
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
        due_in_days: { type: 'number', description: 'Payment terms for each invoice (default 7)' },
        currency: { type: 'string' },
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
      return { known: true, name: c.name, email: c.email, ...clientStats(c.id, today) };
    },

    get_earnings_summary({ from, to }) {
      return earningsSummary({ from, to }, today);
    },

    forecast_cashflow({ days = 30 }) {
      return forecastCashflow(Math.min(Math.max(Number(days) || 30, 1), 180), today);
    },

    propose_invoice(input) {
      const known = findClient(input.client_email) || findClient(input.client_name);
      const risk = known ? clientStats(known.id, today) : null;
      // Risk-based deposit: if the client usually pays late and no deposit was specified,
      // suggest collecting 50% upfront (PayPal partial payment).
      const autoDeposit = input.deposit_percent === undefined && risk?.riskLabel === 'high';
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
      });
      draft.risk = risk ? { label: risk.riskLabel, avgDaysLate: risk.avgDaysLate, overdueCount: risk.overdueCount } : null;
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
      const a = createAction(
        'send_reminder',
        { invoiceId: inv.id, number: inv.number, client: clientName(inv.clientId), amount: inv.total, currency: inv.currency, dueDate: inv.dueDate, tone, subject, message },
        { summary: `Reminder #${inv.number} (${tone})` }
      );
      created.push(a);
      return { status: 'awaiting_user_approval', action_id: a.id };
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

export function resetSession(id) {
  sessions.delete(id);
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
