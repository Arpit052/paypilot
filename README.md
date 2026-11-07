# PayPilot: an AI money agent for small businesses, built on PayPal

**Freelancers, clinics, tutors, tradespeople, consultants and small agencies all have the same problem: the work is done, but the money isn't in. PayPilot turns a plain-English description (or a screenshot) into a PayPal invoice, chases late payers with reminders whose tone escalates, tells you whether you can afford a purchase from how each client really pays, and spots clients who should be on a monthly retainer.** Nothing goes out without your approval.

Built for the *Build What's Next with PayPal and AI* hackathon.

![Assistant drafting a PayPal invoice](docs/screenshots/assistant.png)

---

## The problem

Getting paid is a small-business problem, not just a freelancer one:

- **56%** of US small businesses have unpaid invoices, owed **$17,500** on average, and **47%** have invoices more than 30 days overdue (Intuit QuickBooks Small Business Late Payments Report, 2025).
- In the UK, businesses hit by late payment spend about **86 staff hours a year** chasing it, and late payment is linked to about **14,000 business closures a year** (UK Office of the Small Business Commissioner research, July 2025).
- **52%** of small business owners simply write off late payments up to 10 times a year because chasing isn't worth the time (FSB / GoCardless Late Payments Report, 2025).
- The US alone has about **72.9 million** independent workers (MBO Partners, State of Independence 2025), on top of millions of small service businesses.

Behind those numbers are three everyday pains: invoicing gets put off, chasing is awkward so it doesn't happen, and nobody can say with confidence *"can I afford this next month?"* because it depends on when clients pay.

## Who it's for

PayPilot doesn't care what work you do, only how you get paid. Pick a **type of business** in Settings (Freelancer, Agency, Clinic, Tutoring, Trades and repair, Consulting) and it sets sensible payment terms, reminder style, the invoice note, one-click line items, and the words the AI uses (*patients*, *families*, *maintenance plan*, *advisory retainer*). The demo loads a different sample business for each type: a design studio, a physio clinic, a tutoring studio, a home-repair company or a consultancy.

## What PayPilot does

**Bill**

| Feature | How it works |
|---|---|
| **Text → invoice** | *"Bill Ryan (ryan@castillocoffee.co) for 3 bag label designs at $145 plus a $60 rush fee, due in 10 days."* The AI extracts client, line items, rates and due date and puts an editable **invoice slip** in the approval tray. |
| **Screenshot → invoice** | Paste a screenshot of a client's email or chat; a vision model reads it and drafts the invoice. |
| **Human-in-the-loop** | The AI can only *propose*. Nothing reaches PayPal or a client until you click **Approve & send via PayPal**, and you can edit any field first. |
| **Real PayPal invoices** | Approved drafts are created and sent with the **PayPal Invoicing v2 API**, with clean numbers (#1042), per-line sales tax, reference/PO and notes. The client gets PayPal's email and payment page. |
| **Deposits for risky clients** | If a client usually pays late, a **50% deposit** is added with PayPal's partial-payment option. Where PayPal doesn't offer split payments (e.g. India), the invoice still goes out and the deposit is requested in the note. |
| **New invoice form** | Bill without the chat, with a live paper-invoice preview. Defaults (currency, terms, tax, note) come from Settings. |
| **Retainers** | Bill a client the same amount every week or month. Each date drafts the invoice for your approval; cards show next date, billed so far and yearly value. |

**Get paid**

| Feature | How it works |
|---|---|
| **Autopilot** | Every unpaid invoice gets a follow-up plan: friendly heads-up before the due date, firm reminder after, final reminder (+ optional late fee) later. On each date the AI writes the email in your style and asks for approval. Tone never softens after a firmer reminder. Off = nothing is drafted unless you ask. |
| **Collections** | One list of every unpaid invoice with status, the three-step progress, and the next action; a "Next 14 days" rail shows what Autopilot will do. |
| **Late fees** | Suggested on very late invoices and added to the PayPal invoice (full update) only after you approve. |
| **Live payment status** | PayPal webhooks (signature-verified) plus an automatic check every 2 minutes flip invoices to **Paid** and push a notification to every open tab over Server-Sent Events. Invoices you create on paypal.com are imported automatically. |
| **Mark as paid** | Paid by bank transfer or cash? Record it (two clicks to confirm) and PayPilot records the payment on the PayPal invoice too. |
| **Copy pay link** | Copy PayPal's payment link to send by text or WhatsApp. |

**Earn more, spend safely**

| Feature | How it works |
|---|---|
| **Budget Estimator** | *"Can I buy a $2,000 laptop on Dec 5?"* PayPilot plays out 4,000 possible futures of who pays you and when, using each client's own payment history, and answers with the **chance** you can buy it and keep your safety buffer (with its error margin), the **likely and bad-case shortfall**, the **earliest date it becomes safe** (80% and 95%), and **which invoice decides it**. A second answer includes the new work your repeat clients usually send. Also in the Assistant. [How the model works](#how-the-budget-estimator-works) |
| **Suggested retainers** | Finds clients who already buy from you nearly every month, prices a monthly plan a little below a typical month with them, and shows both sides of the deal: what you gain a year, what they save, fewer invoices, and how fast your existing retainer clients pay compared with them. The AI writes the offer email in your style; when they say yes, one click creates the retainer. |

**Understand**

| Feature | How it works |
|---|---|
| **Dashboard** | Earned this month, waiting, overdue, 30-day forecast, clickable monthly chart, top customers, searchable invoice table with CSV export. |
| **Analytics** | Revenue trend with hover, KPIs vs the previous period (revenue, days to get paid, on-time rate, average invoice), when clients pay, unpaid by age, per-client behaviour with trends, best-earning work, and plain-English insights. |
| **Calendar** | Due dates, payments received, reminders sent and Autopilot's planned reminders on a month grid, with actions per day. |
| **Money brief** | A step-by-step report with AI recommendations; numbers are computed in code, the AI only writes the headline and actions. |
| **Client risk** | No risk / Low / Medium / High / New, from real payment history. The agent warns you before invoicing a risky client. |
| **Ask anything** | *"Who owes me money?"*, *"Who is my best customer?"*, *"Cancel Danielle's invoice."* Answers come from your data via tools, never from guesses. |

**Run it**

| Feature | How it works |
|---|---|
| **Search (Ctrl/⌘ K)** | Find any invoice, client, page or action, or send the query straight to the Assistant. |
| **Business types** | Freelancer, Agency, Clinic, Tutoring, Trades and repair, Consulting: presets for terms, reminder style, invoice note and line-item shortcuts, plus a matching sample business in the demo. |
| **Settings** | Business, invoice defaults, PayPal connection, Autopilot plan, late fees, notification types, AI writing style (warm / neutral / brief) with a live preview, data export/backup, security. |
| **Connect in the app** | First run asks for a business name and PayPal sandbox keys (checked with PayPal before saving), or opens demo mode. |
| **Passcode + sign out** | Lock PayPilot with a passcode (scrypt-hashed) and sign out from the sidebar. |

| Budget Estimator | Suggested retainers | Business types |
|---|---|---|
| ![](docs/screenshots/budget.png) | ![](docs/screenshots/retainers.png) | ![](docs/screenshots/business-type.png) |

| Collections + Autopilot | Analytics | Calendar |
|---|---|---|
| ![](docs/screenshots/collections.png) | ![](docs/screenshots/analytics.png) | ![](docs/screenshots/calendar.png) |

| Dashboard | Clients + retainers | Settings |
|---|---|---|
| ![](docs/screenshots/dashboard.png) | ![](docs/screenshots/clients.png) | ![](docs/screenshots/settings.png) |

---

## Architecture

```mermaid
flowchart LR
  U[Business owner<br/>text / screenshot] --> UI[Web UI<br/>chat + approval tray]
  UI -->|/api/chat| AG[AI agent<br/>tool-calling loop]
  AG <-->|tools| T{{list_invoices<br/>get_client_insights<br/>get_earnings_summary<br/>forecast_cashflow<br/>check_budget<br/>suggest_retainers<br/>propose_invoice<br/>propose_reminder<br/>propose_cancel}}
  AG <--> LLM[(Gemini via @google/genai<br/>or Claude / OpenAI-compatible)]
  T -->|propose_*| Q[Pending actions]
  Q -->|user approves| EX[Executor]
  EX -->|Invoicing v2: create, send, remind, cancel| PP[(PayPal REST API)]
  PP -->|Webhook: INVOICE.PAID| WH[/api/webhooks/paypal/]
  WH --> DB[(Invoice store)]
  EX --> DB
  CRON[Scheduler] -->|/api/cron/followups| FU[Follow-up scanner] -->|AI drafts reminder| Q
```

**Design.** A calm black interface with a left sidebar, invoices rendered as white paper slips, and charts drawn in plain SVG. The PayPilot logo and wordmark are original; fonts (Geist, Unbounded, Manrope; SIL Open Font License) are bundled so it looks right offline.

**Stack.** Node.js + **Express 5** API, **SQLite** (Node's built-in `node:sqlite`, with a transactional repository layer and automatic migrations), **Google Gen AI SDK** (`@google/genai`) for Gemini, PayPal REST APIs, and a vanilla-JS frontend.

**Reliability and security.**
- **Exactly-once payments:** approvals are claimed atomically (a double-click can't send twice), and every PayPal write carries a `PayPal-Request-Id` and a local checkpoint, so a retry after a network failure resumes instead of creating a duplicate invoice.
- **Resilient AI:** if the primary Gemini model is rate-limited or overloaded, PayPilot falls back to other Gemini models (each has its own quota) and handles thought signatures across models.
- **Background jobs:** a scheduler (default every 6 h) syncs payment status from PayPal, creates due recurring drafts, and drafts reminders for overdue invoices. Everything still waits for approval.
- **Optional passcode login** (`APP_PASSWORD`) with an HMAC-signed, HttpOnly session cookie. Webhooks, cron and `/api/health` stay public.
- Per-IP rate limiting on AI endpoints, a strict Content-Security-Policy and other security headers, verified PayPal webhooks, and dates computed in the business time zone (`APP_TIMEZONE`).

**Agent design.** The model gets **read tools** (invoices, client insights, earnings, forecast) and **proposal tools**. Proposal tools validate the draft (email format, positive amounts, due date not in the past) and create a *pending action*. They never call PayPal. Only the `/api/actions/:id/approve` endpoint, triggered by a human click, runs the PayPal calls. So even if the model gets confused or receives a prompt injection through a screenshot, it can't move money or message a client.

### PayPal APIs used

| API | Endpoint | Used for |
|---|---|---|
| OAuth 2.0 | `POST /v1/oauth2/token` | Client-credentials token (cached) |
| Invoicing v2 | `POST /v2/invoicing/generate-next-invoice-number` | Invoice numbering |
| Invoicing v2 | `POST /v2/invoicing/invoices` | Create draft invoice, with per-line **sales tax** and **partial payment** (deposit) configuration |
| Invoicing v2 | `POST /v2/invoicing/invoices/{id}/send` | Send to client (PayPal email and payment page) |
| Invoicing v2 | `GET /v2/invoicing/invoices/{id}` | Poll status and payments |
| Invoicing v2 | `POST /v2/invoicing/invoices/{id}/remind` | AI-drafted payment reminders |
| Invoicing v2 | `POST /v2/invoicing/invoices/{id}/cancel` | Cancel an invoice |
| Webhooks | `POST /v1/notifications/verify-webhook-signature` | Verify `INVOICING.INVOICE.*` events |

### AI tools used

- **LLM with tool calling.** Three adapters behind one interface: **Google Gemini** (official `@google/genai` SDK, with thought-signature round-tripping), **Claude** (Anthropic Messages API), and any **OpenAI-compatible** API (OpenAI, Groq, OpenRouter, local models).
  - **Agent loop** (`src/llm.js`, `src/agent.js`): multi-step tool calling over PayPal data, intent and entity extraction from free text, and multilingual replies.
  - **Vision** (`src/agent.js`): reads client emails and chat screenshots to draft invoices.
  - **Generation** (`src/followups.js`): writes reminder emails using the client's payment history and the escalation tone.
- **Deterministic analytics** (`src/analytics.js`): risk scoring and the probability-weighted forecast, so the numbers the AI reports come from data, not guesses.
- **Statistics** (`src/budget.js`, `src/offers.js`): a Monte Carlo cash model and a buying-pattern score. The AI calls them as tools (`check_budget`, `suggest_retainers`) and explains the result; it never makes the numbers up.

### How the Budget Estimator works

The money you'll have on a date is uncertain because you don't know when, or if, each client pays. So PayPilot simulates it:

1. **Each client's payment habit.** Every paid invoice tells us how many days after the due date the money arrived. A client with few payments is blended with everyone's history (empirical Bayes: their own data gets weight *n / (n + 3)*), and each draw gets ~1.5 days of noise (kernel smoothing) so the model doesn't only repeat the past.
2. **Conditioning on today.** An unpaid invoice hasn't been paid yet, so only futures where it arrives today or later are kept. If a client is later than ever before, the extra wait follows an exponential tail fitted to their late payments.
3. **Money that never comes.** Each invoice is paid at all with probability from a Beta(49, 1) prior (98%) updated with the client's paid invoices; once it's later than the client's slowest payment ever, that chance halves every 60 days.
4. **Retainers and new work.** Scheduled retainer invoices are included. Optionally, repeat clients send new work as a Poisson process with their own rate and amounts.
5. **4,000 futures.** Costs come off day by day. The answer is the share of futures where you can pay for the item and keep your buffer (± the 95% Monte Carlo error), the P10 / P50 / P90 range, the average gap when it falls short, the first date the chance reaches 80% and 95%, and each invoice's *swing*: P(yes | it arrives in time) − P(yes | it doesn't).

Results are seeded, so the same inputs always give the same answer, and the page explains the method in plain English.

### How retainer suggestions work

For each client over the last 180 days PayPilot measures how many months they bought in (*coverage*), how regular the gaps are (1 − coefficient of variation), and how much they spend in an average month and in a typical month they do buy. Only clients who buy at least every ~40 days, in 75%+ of months, and aren't high-risk payers are suggested. The price is a typical month's spend minus 3–10% (smaller when they already buy every month), rounded the way people price things. The card shows the yearly change for you, the monthly saving for them, and how quickly your current retainer clients pay compared with this client.

---

## Run it locally (about 5 minutes)

**You need:** Node.js 22.13 or newer (uses Node's built-in SQLite).

```bash
git clone <this-repo> paypilot && cd paypilot
npm install
cp .env.example .env        # then fill in the keys below
npm start                   # → http://localhost:3000
```
On Windows you can just double-click **`start-windows.bat`**. To check your AI setup, double-click **`check-ai.bat`**. It tests your key against Gemini and writes a working model and setting into `.env`.

### 1. PayPal sandbox keys
1. Sign in at [developer.paypal.com](https://developer.paypal.com) and open **Apps & Credentials** with **Sandbox** selected.
2. Create an app (type *Merchant*) and copy the **Client ID** and **Secret** into `.env`.
3. Under **Testing tools → Sandbox accounts** you'll find a *Business* account (that's you, the invoicer) and a *Personal* account (use it as the client and to pay invoices).

### 2. AI key
Set **one** of:
- `GEMINI_API_KEY`: free key from [Google AI Studio](https://aistudio.google.com) (uses Gemini's native API, model `gemini-3.6-flash` by default)
- `ANTHROPIC_API_KEY`: Claude
- `OPENAI_API_KEY`: OpenAI, or any OpenAI-compatible provider via `OPENAI_BASE_URL` and `OPENAI_MODEL`

### 3. (Optional) Demo history
```bash
npm run seed      # adds a few months of paid invoices so risk scores and charts have data
```
Seeded history is labelled **demo** in the UI. It is local only and never sent to PayPal.

### 4. (Optional) Webhooks for instant "Paid" updates
Expose your local server (e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`). In your sandbox app, add a webhook to `https://<your-url>/api/webhooks/paypal` for **Invoicing** events, then put the **Webhook ID** in `PAYPAL_WEBHOOK_ID`. Without webhooks, the dashboard's **Check PayPal for payments** button polls PayPal instead.

### No keys? Try mock mode
With no PayPal keys (or `PAYPAL_MODE=mock`), PayPilot simulates PayPal in-process and adds a **Simulate payment** button. Use this to explore the UI offline. An AI key is still needed for the assistant. Without one, follow-ups use template reminders.

---

## Try this flow (what the demo video shows)

1. **Assistant:** *"Bill Ryan Castillo (your-sandbox-personal-email) for 3 logo concepts at $150 each and an urgent revision for $60, due in 10 days."* An invoice slip appears with a risk warning if Ryan pays late.
2. Edit a rate and click **Approve & send via PayPal**. The slip is stamped **SENT**. Open the sandbox personal account to see the invoice.
3. Pay it from the sandbox personal account. The dashboard flips to **Paid** through the webhook.
4. **Follow-ups → Find overdue invoices.** The AI drafts tone-matched reminders. Approve one, and PayPal sends the reminder.
5. **Budget:** ask *"Can I afford a $2,000 laptop next month?"* in the Assistant, or open **Budget** and try a price and date. Watch which invoice decides it.
6. **Clients → Suggested retainers:** open Danielle's card, write the offer, then click *Danielle said yes* to create the retainer. Run the budget again: it now counts her monthly payment.

> **Tip for demos:** set `DEMO_TIME_OFFSET_DAYS=15` and restart to fast-forward the app's clock, so invoices you just sent become overdue and the follow-up flow runs against real sandbox invoices.

---

## Deploy (hosted demo)

**Render:** New → Blueprint → select this repo (`render.yaml` is included). Add your keys in the dashboard. Scheduled follow-ups: create a Render Cron Job (or any cron service) that calls `GET https://<app>/api/cron/followups?key=<CRON_SECRET>` daily.

Data is stored in SQLite at `data/paypilot.db`. On free hosting the disk is temporary, which is fine for a demo; set `DATA_DIR` to a persistent disk for real use.

## Tests

```bash
npm test
```
These are end-to-end tests with mock PayPal and a scripted model. They cover the propose → approve → PayPal flow, user edits, validation, webhook payment, follow-up escalation and de-duplication, the dashboard maths, request mapping for the LLM providers, the PayPal invoice payload, and the Budget Estimator's statistics (ordered percentiles, repeatable results, more cash never lowers the chance, overdue invoices never "paid in the past"), retainer suggestions, and every business type's sample data.

## Project layout

```
server.js            Express app + API routes
src/agent.js         System prompt, tool schemas + handlers, chat sessions
src/llm.js           Gemini (official @google/genai SDK), Anthropic + OpenAI-compatible adapters, tool-calling loop
src/paypal.js        PayPal Invoicing v2 client (sandbox/live) + mock
src/db.js            SQLite schema + repository (clients, invoices, actions, activity)
src/actions.js       Pending actions, approval, execution against PayPal
src/followups.js     Overdue scanner + AI reminder drafting
src/analytics.js     Risk score, earnings, cash-flow forecast
src/sync.js          Polling + webhook status updates
src/recurring.js     Recurring schedules → invoice drafts
src/scheduler.js     Background jobs (PayPal sync, overdue scan, recurring)
src/brief.js         Money brief: computed sections + AI recommendations
src/notify.js        Notifications: stored + pushed live over Server-Sent Events
src/budget.js        Budget Estimator: Monte Carlo cash model
src/offers.js        Retainer suggestions: buying-pattern scoring + AI offer emails
src/business.js      Business types and their presets
src/personas.js      Sample businesses for the demo (clinic, tutoring, trades, consulting)
public/              UI (vanilla JS): dashboard, assistant, collections, calendar, analytics, budget, clients, settings
test/                End-to-end tests
```

## Configuration (optional `.env` settings)
| Variable | Default | What it does |
|---|---|---|
| `APP_PASSWORD` | – | Require a passcode to open the app (recommended for a public demo URL) |
| `APP_TIMEZONE` | system time zone | Time zone for "today" and due dates, e.g. `America/New_York` |
| `DEFAULT_TAX_PERCENT` | `0` | Sales tax applied when none is specified |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite` | Models to try when the main one is busy |
| `SCHEDULER_INTERVAL_MIN` | `360` | Background job interval in minutes (`0` = off) |
| `CHAT_RATE_LIMIT_PER_MIN` | `15` | Assistant messages per minute per IP |
| `PAYPAL_SYNC_SECONDS` | `120` | How often to check PayPal for new payments (real mode; webhooks are instant) |

## Security notes
- The AI cannot execute payments, reminders or cancellations. A human approves every action, including each recurring invoice.
- Webhook signatures are verified with PayPal before any state changes (sandbox/live).
- Keys live only in `.env` (git-ignored). Uploaded screenshots are sent to the model for that turn only and are not kept in chat history.

## Sources for the numbers above
- [Intuit QuickBooks, Small Business Late Payments Report 2025](https://agiled.app/statistics/late-payment-statistics) (summary)
- [UK Office of the Small Business Commissioner late-payments research, July 2025](https://stealthagents.com/research/small-business-overdue-invoice-statistics-2026) (summary)
- [FSB / GoCardless Late Payments Report 2025](https://blog-j3o.pages.dev/late-payment-statistics-uk.html) (summary)
- [MBO Partners State of Independence 2025](https://www.makerstations.io/?p=11005) (summary)

## License
[MIT](LICENSE)
