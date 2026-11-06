# Submission kit

Copy and paste these into the hackathon submission form.

## Project name
PayPilot: an AI payments agent for freelancers

## Tagline
Describe the work. PayPilot invoices through PayPal, chases late payers, and forecasts your cash, and nothing goes out without your approval.

## Text description

**The problem.** Freelancers are bad at getting paid. Not because clients won't pay, but because invoicing is tedious, chasing late payments is awkward, and payment status is scattered across email, chat and spreadsheets.

**What PayPilot does.** It's an AI agent that sits on top of PayPal Invoicing and runs the whole "getting paid" loop, with a human approval on every write:

- **Describe work → PayPal invoice.** Type "Bill Ryan for 3 bag label designs at $145 each plus a $60 rush fee" or paste a screenshot of a client's message. The agent extracts client, line items, rates and due date and drafts a real PayPal invoice.
- **Human-in-the-loop by design.** The AI can only *propose*. Every invoice, reminder, late fee or cancellation is an editable slip; only the user's Approve click calls PayPal. A prompt injection hidden in a screenshot can't move money.
- **Autopilot for follow-ups.** Every unpaid invoice gets a plan: a friendly heads-up before the due date, a firm reminder after, and a final reminder with an optional late fee. On each date the AI writes the email in the user's chosen style and waits for approval. Tone never softens once a firmer reminder has gone out. Turn it off and nothing is drafted unless asked.
- **Knows your clients.** Risk labels come from real payment history. Habitual late payers automatically get a 50% deposit via PayPal partial payments (or a deposit note where PayPal doesn't offer split payments).
- **Collections, Calendar and Analytics.** One list of everything unpaid with next steps; a calendar of due dates, payments and planned reminders; analytics on revenue trend, days to get paid, on-time rate, who pays late, and which work earns most, with plain-English insights. Every number is computed in code, never guessed by the model.
- **Real-world details.** Retainers that draft themselves, Mark as paid for bank transfers (recorded on the PayPal invoice too), Copy pay link for WhatsApp/SMS, imports of invoices created on paypal.com, live payment notifications over SSE, Ctrl+K search, CSV and JSON export, and a passcode lock.

**How it's built.** It's a Node.js + Express 5 server with SQLite storage and a provider-neutral LLM tool-calling loop (Google Gemini through the official Gen AI SDK, Claude, or any OpenAI-compatible model, including vision). Seven typed tools are split into read tools and proposal tools. A pending-action queue gates every write, and a PayPal Invoicing v2 client handles create, send, remind, cancel and status, plus webhook signature verification. Everything runs against the PayPal sandbox.

## PayPal technologies used
- PayPal REST **Invoicing v2 API**: create (per-line sales tax, **partial payments / deposits**, reference, notes), send, get, list (import), full update (late fees), remind, cancel, and **record payment** (mark as paid). Every write is idempotent via `PayPal-Request-Id`.
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

Before recording: connect PayPal on the welcome screen with sample history on, and make one invoice with an issue date last month so something is overdue.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Dashboard | "Freelancers lose weeks of cash to invoicing and awkward follow-ups. PayPilot is an AI agent on PayPal that runs that loop, and nothing goes out without your approval." |
| 0:15–0:50 | Assistant: type the Ryan prompt. The slip shows High risk and a 50% deposit. Edit a rate, Approve. | "I describe the job in plain words. It checks Ryan's history, sees he pays 14 days late, and adds a deposit. I approve, and it's a real PayPal invoice." |
| 0:50–1:05 | Paste a screenshot of a client message; a second slip appears | "It reads screenshots too. This chat becomes an invoice." |
| 1:05–1:25 | Sandbox buyer pays; the bell pops "Payment received" and the invoice flips to Paid | "The client pays on PayPal and PayPilot knows instantly." |
| 1:25–2:00 | Collections: the late invoices, three-step progress, Next 14 days. Review the firm reminder in the drawer, Approve. | "Late invoices get Autopilot: friendly, then firm, then final, written by the AI on the right day. I just approve." |
| 2:00–2:20 | Settings → AI writing: switch to Brief, Preview a reminder | "It writes the way I want." |
| 2:20–2:45 | Analytics hover, then Calendar | "And I finally see my business: how fast I get paid, who pays late, and what's coming this month." |
| 2:45–3:00 | Architecture diagram from the README | "Gemini tool calling, PayPal Invoicing and webhooks, and a human approval on every write. That's PayPilot." |

Use royalty-free or no background music. Don't show PayPal logos beyond what appears naturally in the sandbox pages.
