# Submission kit

Copy and paste these into the hackathon submission form.

## Project name
PayPilot: an AI payments agent for freelancers

## Tagline
Describe the work. PayPilot invoices through PayPal, chases late payers, and forecasts your cash, and nothing goes out without your approval.

## Text description

**The problem.** Freelancers are bad at getting paid. Not because clients won't pay, but because invoicing is tedious, chasing late payments is awkward, and payment status is scattered across email, chat and spreadsheets.

**What PayPilot does.** It's an AI agent that sits on top of PayPal Invoicing:

- **Describe work → PayPal invoice.** Type "Bill Ryan for 3 logo concepts at $150 each, due in 10 days" or paste a screenshot of a client's email. The agent extracts the client, line items, rates and due date and drafts a PayPal invoice.
- **Human-in-the-loop by design.** The AI can only *propose*. Every invoice, reminder or cancellation appears as an editable slip, and only the user's Approve click calls PayPal. Even a prompt injection hidden in a screenshot can't move money.
- **Knows your clients.** It computes a risk score from each client's PayPal payment history and warns you before you invoice a habitual late payer, suggesting a shorter due date or an advance.
- **Protects cash flow automatically.** For clients who usually pay late, the agent adds a 50% upfront deposit using PayPal's partial-payment feature. It supports sales tax and recurring monthly or weekly invoices, and each recurring invoice still comes to you for approval.
- **Money brief.** A step-by-step report covering lifetime earnings, this month vs last, top customers, overdue amount by customer, and what's still to collect, followed by AI-written next steps. The numbers are computed in code, never guessed by the model.
- **New invoice form.** Bill any new or existing customer (company, multiple services, issue/due dates, tax, deposit, PO number) with a live invoice preview, then send through PayPal or save a draft.
- **Live payment notifications.** PayPal webhooks (plus a 2-minute safety-net check) mark invoices Paid in the database, and a notification pops up instantly in every open tab via Server-Sent Events.
- **Interactive dashboard.** Clickable summary cards and months, sortable and searchable invoices, a top-customers leaderboard and CSV export.
- **Chases late payments for you.** A scanner finds overdue invoices, and the AI writes reminders whose tone escalates from friendly to firm to final. Approve them, and they're sent through PayPal's remind endpoint. This can run on a schedule.
- **Live status and forecast.** PayPal webhooks mark invoices paid instantly. A cash-flow forecast weights each open invoice by that client's real payment behaviour.
- **Ask in plain English.** "Who owes me money?", "How much did I earn this month?" The agent answers from real PayPal data; the numbers are computed in code, never guessed by the model.

**How it's built.** It's a Node.js + Express 5 server with SQLite storage and a provider-neutral LLM tool-calling loop (Google Gemini through the official Gen AI SDK, Claude, or any OpenAI-compatible model, including vision). Seven typed tools are split into read tools and proposal tools. A pending-action queue gates every write, and a PayPal Invoicing v2 client handles create, send, remind, cancel and status, plus webhook signature verification. Everything runs against the PayPal sandbox.

## PayPal technologies used
- PayPal REST **Invoicing v2 API**: generate-next-invoice-number, create (with per-line sales tax and **partial payments / deposits**), send, get, remind, cancel. Every write is idempotent via `PayPal-Request-Id`.
- PayPal **Webhooks**: `INVOICING.INVOICE.PAID`/`CANCELLED`, verified with `verify-webhook-signature`
- PayPal **OAuth 2.0** client credentials
- PayPal **Sandbox** business and personal accounts for the end-to-end flow

## AI tools used and how
- **Google Gemini** through the official **Google Gen AI SDK** (`@google/genai`), the default model. It is swappable with **Claude** (Anthropic API) or any **OpenAI-compatible** model.
  - *Agentic tool calling:* the model chooses among 7 tools (list invoices, client insights, earnings summary, cash-flow forecast, propose invoice, propose reminder, propose cancel) over multiple steps.
  - *Vision:* extracts invoice details from screenshots of client emails and chats.
  - *Generation:* writes reminder emails tuned to how late the invoice is and the client's history.
- Risk scores and forecasts are computed **deterministically** in code and handed to the model as tool results, so the AI doesn't invent numbers.

## Links
- Repo: `https://github.com/<you>/paypilot`
- Hosted demo: `https://<app>.onrender.com`
- Video: `https://youtu.be/<id>`

---

## 3-minute video script

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Title, then Assistant page | "Freelancers hate chasing money. PayPilot is an AI agent on top of PayPal that does it for you, and nothing goes out without your approval." |
| 0:15–0:55 | Type the Ryan invoice prompt. The slip appears with the high-risk warning. Edit one rate. Click Approve. The SENT stamp lands. | "I describe the job in plain words. The agent checks Ryan's history, sees he usually pays 15 days late, and warns me. I tweak a rate and approve, and it's a real PayPal invoice now." |
| 0:55–1:15 | Sandbox personal account inbox or PayPal invoice page | "Here's what the client gets: PayPal's own invoice and payment page." |
| 1:15–1:35 | Attach a screenshot of a client email. A second slip appears. | "It also reads screenshots. This WhatsApp brief becomes an invoice draft." |
| 1:35–1:55 | Pay from the sandbox personal account, then the dashboard flips to Paid | "The client pays, a PayPal webhook arrives, and the dashboard updates instantly." |
| 1:55–2:30 | Follow-ups → Find overdue invoices. A firm reminder for Ryan and a friendly one for Hollis & Grant. Approve one. | "For late payers, the AI writes reminders that get firmer each time, and sends them through PayPal's remind API only when I approve." |
| 2:30–2:45 | Ask "How much did I earn this month?" and the forecast question | "And I can just ask questions in plain English." |
| 2:45–3:00 | Architecture diagram from the README | "Gemini tool-calling, PayPal Invoicing v2 and webhooks, and a human-approval gate on every write. That's PayPilot." |

Use royalty-free or no background music. Don't show PayPal logos beyond what appears naturally in the sandbox pages.
