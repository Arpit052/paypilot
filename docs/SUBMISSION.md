# Submission kit

Copy and paste these into the hackathon submission form.

## Project name
PayPilot: an AI money agent for freelancers and small businesses on PayPal

## Tagline
Describe the work. PayPilot invoices through PayPal, chases late payers, tells you whether you can afford that purchase, and finds clients who should be on a retainer. Nothing goes out without your approval.

## Text description

**The problem.** Getting paid is one of the biggest everyday problems for small businesses. 56% of US small businesses have unpaid invoices, owed $17,500 on average, and 47% have invoices more than 30 days late (QuickBooks, 2025). In the UK, affected businesses spend about 86 hours a year chasing late payments, and late payment is linked to about 14,000 closures a year. Half of owners simply write some of it off because chasing isn't worth the time. Web developers, designers, writers, marketers, video editors, consultants, photographers and virtual assistants all have the same problem. The work is done, but the money isn't in, and nobody can say whether they can afford something next month.

**What PayPilot does.** It's an AI agent on top of PayPal Invoicing that runs the whole money loop for a small business. The AI proposes; the owner approves every write.

- **Describe work, get a PayPal invoice.** "Bill Marcus for 3 ad creatives at $145 plus a $60 rush fee", or a screenshot of a client's message, becomes a real PayPal invoice slip to review and approve.
- **Autopilot collections.** Every unpaid invoice gets a plan: a friendly heads-up, then a firm reminder, then a final one with an optional late fee. On each date the AI writes the email in the owner's style and waits for approval. The tone never softens after a firmer reminder.
- **Budget Estimator.** "Can I buy a $2,000 laptop on Dec 5?" PayPilot simulates 4,000 possible futures of who pays and when, learned from each client's own payment history: empirical-Bayes blending, conditioning on how late an invoice already is, a Beta prior for non-payment, and Poisson new work. It counts the money that really reaches a freelancer: PayPal's 3.49% + $0.49 fee and the tax set-aside come off every payment, and bills leave on their day of the month. A purchase counts as safe only if the balance stays above the owner's cushion for the 30 days after, so next month's rent is covered too. It answers with:
  - the chance, with its error margin
  - the most they can safely spend that day
  - the lowest their balance gets
  - the earliest safe date, and what happens if they wait a week or a month
  - the one invoice that decides it ("#1041 from Marcus reaches you in time in 62% of futures")

  Owners can split the purchase into instalments, or untick an invoice to ask "what if this client never pays?".
- **Suggested retainers.** It finds clients who already buy almost every month and prices a monthly plan a little below a typical month with them. It shows both sides: the yearly gain for the business, the client's saving, and how much faster existing retainer clients pay. The AI writes the offer email, and one click creates the retainer when the client says yes. This doesn't just collect money; it helps owners earn more of it, more predictably.
- **Works for any profession.** The first screen asks what you do: Web Developer, Graphic Designer, Content Writer, Digital Marketer, Video Editor, Consultant, Photographer, Virtual Assistant, or Other in your own words. That sets payment terms, reminder style, invoice notes, one-click line items and the AI's vocabulary. The demo ships matching work for each, sold to the same six realistic clients.
- **Knows your clients.** Risk labels come from real payment history. Habitual late payers get a 50% deposit via PayPal partial payments, or a deposit note where PayPal doesn't offer split payments.
- **See the business.** A dashboard, Collections, a calendar of due dates and planned reminders, and analytics on days to get paid, on-time rate and best-earning work. Every number is computed in code, never guessed by the model.
- **Real-world details.**
  - Mark as paid for bank transfers, recorded on PayPal too
  - Copy pay link for WhatsApp or SMS
  - Imports invoices created on paypal.com
  - Live payment notifications
  - Ctrl+K search, CSV and JSON export, and a passcode lock

**How it's built.** The server is Node.js with Express 5 and SQLite storage. The LLM tool-calling loop is provider-neutral: Google Gemini through the official Gen AI SDK, Claude, or any OpenAI-compatible model, including vision. It has nine typed tools, split into read tools (including the Budget Estimator and retainer finder) and proposal tools, and a pending-action queue gates every write. A PayPal Invoicing v2 client handles create, send, remind, late-fee update, record payment, cancel, list and import, with webhook signature verification and idempotent writes. Everything runs against the PayPal sandbox, with automated end-to-end tests.

## PayPal technologies used
- PayPal REST **Invoicing v2 API**:
  - **create**, with per-line sales tax, **partial payments / deposits**, reference and notes
  - send, get, list (import)
  - full update (late fees)
  - remind, cancel
  - **record payment** (mark as paid)

  Every write is idempotent via `PayPal-Request-Id`.
- PayPal **Webhooks**: `INVOICING.INVOICE.PAID` and `CANCELLED`, verified with `verify-webhook-signature`.
- PayPal **Reporting API** balance, when the app has access: pre-fills "money you have now" in the Budget Estimator.
- PayPal **OAuth 2.0** client credentials.
- PayPal **Sandbox** business and personal accounts for the end-to-end flow.

## AI tools used and how
- **Google Gemini** through the official **Google Gen AI SDK** (`@google/genai`) is the default model. It can be swapped for **Claude** (Anthropic API) or any **OpenAI-compatible** model.
  - *Agentic tool calling:* the model chooses among 9 tools over multiple steps. Read tools: list invoices, client insights, earnings, cash-flow forecast, check budget, suggest retainers. Proposal tools: propose invoice, propose reminder, propose cancel.
  - *Vision:* extracts invoice details from screenshots of client emails and chats.
  - *Generation:* writes reminder emails tuned to how late the invoice is, and retainer offers tuned to the client's buying history, in the owner's chosen style.
- **Statistics, not guesses:** risk scores, the Monte Carlo Budget Estimator and retainer scoring are computed in code and given to the model as tool results. The AI explains the numbers; it never invents them.

## Links
- Repo: `https://github.com/<you>/paypilot`
- Hosted demo: `https://<app>.onrender.com`
- Video: `https://youtu.be/<id>`

---

## 3-minute video script

Before recording:
- Connect PayPal on the welcome screen with sample history on, and make one invoice with an issue date last month so something is overdue.
- Keep a second browser profile in demo mode with **Video Editor** chosen, for the "any profession" moment.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Dashboard | "More than half of small businesses are waiting on unpaid invoices, about $17,000 each. PayPilot is an AI money agent on PayPal, and nothing goes out without your approval." |
| 0:15–0:45 | Assistant: type the Marcus prompt. The slip shows High risk and a 50% deposit. Approve. | "I describe the job. It sees Marcus pays two weeks late and adds a deposit. I approve, and it's a real PayPal invoice." |
| 0:45–1:00 | Sandbox buyer pays; the bell shows "Payment received" | "The client pays on PayPal and PayPilot knows right away." |
| 1:00–1:25 | Collections: firm reminder in the drawer, Approve | "Late invoices get Autopilot: friendly, firm, final. The AI writes each one on the right day." |
| 1:25–2:05 | Budget page: add Rent on the 1st and 25% tax, then Estimate. Show the gauge, "Most you can safely spend", "If you wait", and "What decides it"; untick Marcus's invoice. | "Now the question every freelancer has: can I buy this laptop? PayPilot simulates 4,000 futures from how each client really pays, after PayPal fees, tax and my rent on the 1st. Today it's unlikely, but I can safely spend about $1,100, it's safe from the 12th, and Marcus's invoice decides it. If he never pays, here's what happens." |
| 2:05–2:30 | Clients → Suggested retainers → Rachel: Write offer, then "Rachel said yes" | "It also helps me earn more. Rachel books almost every month, so PayPilot suggests a retainer: she pays less than a typical month, I earn more a year and get paid on a fixed date. One click and it's set up." |
| 2:30–2:45 | Switch to the Video Editor profile: same clients, editing work, "monthly editing package" | "And it isn't just for designers. A web developer, a writer, a video editor or a VA gets the same agent, with their own terms and language." |
| 2:45–3:00 | Architecture diagram from the README | "Gemini tool calling, PayPal Invoicing and webhooks, real statistics, and a human approval on every write. That's PayPilot." |

Replace the numbers in the script with the ones on your screen. Use royalty-free music or none. Don't show PayPal logos beyond what appears naturally in the sandbox pages.
