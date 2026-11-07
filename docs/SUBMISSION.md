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
- **Pay to unlock.** Attach the final files to an invoice. The client gets a private page that stays locked until PayPal reports the payment, then unlocks by itself. This answers freelancers' biggest fear: handing over the work and never getting paid.
- **Early-pay discount.** "Pay within 48 hours, get 2% off" as a real PayPal invoice-level discount. PayPilot removes it on PayPal automatically if the window passes. The suggested percentage comes from the client's history, and is zero for clients who already pay on time.
- **Autopilot reminders.** Every unpaid invoice gets a plan: a friendly heads-up, then a firm reminder, then a final one with an optional late fee. On each date the AI writes the email in the owner's style, with the pay link inside, and waits for approval; a reminder just sent pauses the next one. The tone never softens after a firmer reminder, and the voice follows the client: a warm check-in for a good client, a formal note with terms, days overdue and the late-fee date for a repeat late payer.
- **Budget Estimator.** "Can I buy a $2,000 laptop on Dec 5?" PayPilot simulates 4,000 possible futures of who pays and when, learned from each client's own payment history: empirical-Bayes blending, conditioning on how late an invoice already is, a Beta prior for non-payment, and Poisson new work. It counts the money that really reaches a freelancer: PayPal's 3.49% + $0.49 fee and the tax set-aside come off every payment, and bills leave on their day of the month. A purchase counts as safe only if the balance stays above the owner's cushion for the 30 days after, so next month's rent is covered too. It answers with:
  - the chance, with its error margin
  - the most they can safely spend that day
  - the lowest their balance gets
  - the earliest safe date, and what happens if they wait a week or a month
  - the one invoice that decides it ("#1041 from Marcus reaches you in time in 62% of futures")

  Owners can split the purchase into instalments, or untick an invoice to ask "what if this client never pays?".
- **Suggested retainers.** It finds clients who already buy almost every month and prices a monthly plan a little below a typical month with them. It shows both sides: the yearly gain for the business, the client's saving, and how much faster existing retainer clients pay. The AI writes the offer email, and one click creates the retainer when the client says yes. This doesn't just collect money; it helps owners earn more of it, more predictably.
- **Receipts, tracked like a business would.** Every paid invoice gets a numbered receipt. PayPal sends its own for PayPal payments; for bank transfers and cash, PayPilot shows which receipts still need sending, emails them, and shows when the client opened one. Each has a private, printable page.
- **See it from the client's side.** One click on any invoice walks through what the client gets: PayPal's invoice email, the payment page, the receipt and the locked or unlocked files.
- **Grow from your own history.** The Growth page segments clients (Champions, Valuable but slow, Slipping away...), ranks industries by value per client and on-time payment, shows which kinds of work are rising or stopped (grouped for your profession), measures income concentration and days sales outstanding, and lists opportunities, each with its basis and an amount only when the amount follows from the book. The AI writes a 90-day plan from those figures.
- **A front door.** A landing page shows each job with a small worked example and leads into setup, where the owner picks **freelancer** or **registered business**. The two get a slightly different app: billing first for freelancers; receivables aging, repeat customers and growth first for businesses.
- **Learns from real data.** A connected account starts empty (samples are optional and removable in one click). New clients are put in an industry automatically from their company, email and work, with AI for unclear cases; unusual line items get their own work areas; clients who pay up front are recognised; and the growth plan is rewritten whenever the invoices change, leading with the biggest thing in the data.
- **Works for any profession.** The first screen asks what you do: Web Developer, Graphic Designer, Content Writer, Digital Marketer, Video Editor, Consultant, Photographer, Virtual Assistant, or Other in your own words. That sets payment terms, reminder style, invoice notes, one-click line items and the AI's vocabulary. The demo ships matching work for each, sold to the same six realistic clients.
- **Knows your clients.** Risk labels come from real payment history. Habitual late payers get a 50% deposit via PayPal partial payments, or a deposit note where PayPal doesn't offer split payments.
- **Know when money lands.** Every invoice shows when it was paid, or when it's likely to be paid, with a range from that client's history. The 30-day forecast has a popover with the exact sum (amount × chance, per invoice).
- **Tax-ready year end.** A summary for an accountant: gross income, PayPal fees (deductible), net, IRS estimated-tax quarters with due dates, rough self-employment tax, and which 1099 forms to expect under the 2026 thresholds. Exports to PDF and CSV.
- **See the business.** A dashboard, one Invoices page (needs you, awaiting payment, upcoming, paid), a calendar of due dates and planned reminders, and analytics on days to get paid, on-time rate and best-earning work. Every number is computed in code, never guessed by the model.
- **Real-world details.**
  - Mark as paid for bank transfers, recorded on PayPal too
  - Copy pay link for WhatsApp or SMS
  - Imports invoices created on paypal.com
  - Live payment notifications
  - Ctrl+K search, CSV and JSON export, and a passcode lock

**How it's built.** The server is Node.js with Express 5 and SQLite storage. The LLM tool-calling loop is provider-neutral: Google Gemini through the official Gen AI SDK, Claude, or any OpenAI-compatible model, including vision. It has 13 typed tools, split into read tools (including the Budget Estimator, the retainer finder and growth insights) and proposal tools, and a pending-action queue gates every write. A PayPal Invoicing v2 client handles create, send, remind, late-fee update, record payment, cancel, list and import, with webhook signature verification and idempotent writes. Every response carries a request id for tracing. Everything runs against the PayPal sandbox, with 77 end-to-end tests that run in GitHub Actions with no secrets, and a Dockerfile for deployment.

## PayPal technologies used
- PayPal REST **Invoicing v2 API**:
  - **create**, with per-line sales tax, **partial payments / deposits**, reference and notes
  - send, get, list (import)
  - full update (late fees, removing an expired early-pay discount)
  - invoice-level discount (early-pay offers)
  - remind, cancel
  - **record payment** (mark as paid)

  Every write is idempotent via `PayPal-Request-Id`.
- PayPal **Webhooks**: `INVOICING.INVOICE.PAID` and `CANCELLED`, verified with `verify-webhook-signature`.
- PayPal **Reporting API** balance, when the app has access: pre-fills "money you have now" in the Budget Estimator.
- PayPal **OAuth 2.0** client credentials.
- PayPal **Sandbox** business and personal accounts for the end-to-end flow.

## AI tools used and how
- **Google Gemini** through the official **Google Gen AI SDK** (`@google/genai`) is the default model. It can be swapped for **Claude** (Anthropic API) or any **OpenAI-compatible** model.
  - *Agentic tool calling:* the model chooses among 13 tools over multiple steps. Read tools: list invoices, client insights, earnings, cash-flow forecast, top customers, check budget, suggest retainers, growth insights. Proposal tools: propose invoice, recurring invoice, reminder, late fee and cancel.
  - *Vision:* extracts invoice details from screenshots of client emails and chats.
  - *Planning:* writes the Money brief and a 90-day growth plan from computed facts only, with rule-based fallbacks.
  - *Generation:* writes reminder emails tuned to how late the invoice is, and retainer offers tuned to the client's buying history, in the owner's chosen style.
- **Statistics, not guesses:** risk scores, the Monte Carlo Budget Estimator, retainer scoring and growth analysis are computed in code and given to the model as tool results. The AI explains the numbers; it never invents them.

## Links
- Repo: `https://github.com/<you>/paypilot`
- Hosted demo: `https://<app>.onrender.com`
- Video: `https://youtu.be/<id>`

---

## 3-minute video script

Before recording:
- Connect PayPal on the welcome screen with "Add a few sample invoices" ticked, and make one invoice with an issue date last month so something is overdue.
- Keep a second browser profile in demo mode with **Video Editor** chosen, for the "any profession" moment.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:12 | Landing page: scroll the hero and the sticky story, click **Log in** | "More than half of small businesses are waiting on unpaid invoices, about $17,000 each. PayPilot is an AI money agent on PayPal, and nothing goes out without your approval." |
| 0:12–0:40 | Assistant: type the Marcus prompt. The slip shows High risk and a 50% deposit. Approve. | "I describe the job. It sees Marcus pays two weeks late and adds a deposit. I approve, and it's a real PayPal invoice." |
| 0:40–0:58 | On that invoice: **How your client sees it** (email, payment page), then the locked files page; pay as the sandbox buyer and it unlocks | "This is what Marcus sees. The final files stay locked until PayPal says he paid. Then they open by themselves." |
| 0:58–1:18 | Invoices → Needs you: Marcus's formal reminder with terms and the late-fee date, then a good client's warm check-in | "Late invoices get Autopilot, and the AI knows who it's writing to: formal with the repeat late payer, warm with a good client." |
| 1:18–1:30 | Receipts: William's bank payment needs a receipt; Email, then it shows Sent | "Companies paying by bank transfer still need a receipt. PayPilot numbers them, sends them and shows when they're opened." |
| 1:30–2:05 | Budget page: add Rent on the 1st and 25% tax, then Estimate. Show the gauge, "Most you can safely spend", "If you wait", and "What decides it". | "Can I buy this laptop? PayPilot simulates 4,000 futures from how each client really pays, after PayPal fees, tax and rent. It tells me the most I can safely spend, the safe date, and which invoice decides it." |
| 2:05–2:40 | Growth: plan, industries (Software & SaaS = Focus here), the client map, Sofia slipping away, a retainer opportunity | "And it learns from my history. My best sector is software: they're worth the most and pay on time. Sofia usually sends work every five weeks and has gone quiet, and Rachel should be on a retainer, worth $788 more a year. Every number says where it came from." |
| 2:40–2:50 | Switch to the Video Editor profile: same clients, editing work and work areas | "It works for any profession, with its own terms, language and kinds of work." |
| 2:50–3:00 | docs/ARCHITECTURE.md diagram | "Gemini tool calling across 13 tools, PayPal Invoicing and webhooks, real statistics, and a human approval on every write. That's PayPilot." |

Replace the numbers in the script with the ones on your screen. Use royalty-free music or none. Don't show PayPal logos beyond what appears naturally in the sandbox pages.
