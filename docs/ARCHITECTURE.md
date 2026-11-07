# PayPilot architecture

PayPilot is one Node.js process: an Express 5 API, a SQLite database (Node's built-in `node:sqlite`), a scheduler, and a vanilla-JS frontend served from `public/`. There is no build step. This page explains how the parts fit and why they are built that way.

```
 Browser (landing, app pages, public client pages)
     │  fetch /api/*            ▲ Server-Sent Events (/api/events)
     ▼                          │
 Express 5  ── request id, security headers, sign-in gate, setup gate
     │
     ├── Agent (src/agent.js) ── LLM client (src/llm.js: Gemini / Claude / OpenAI-compatible)
     │        read tools ─────────► analytics, budget, growth, offers
     │        propose tools ──────► pending-action queue (src/actions.js)   ◄── human clicks Approve
     │                                                    │
     │                                                    ▼
     ├── PayPal client (src/paypal.js) ── Invoicing v2, OAuth, webhook verification, mock twin
     ├── Sync (src/sync.js) ── webhooks + 2-minute polling → status, unlocks, receipts, notifications
     ├── Scheduler (src/scheduler.js) ── Autopilot, retainers, early-pay expiry, due-date alerts
     └── SQLite (src/db.js) ── invoices, clients, actions, schedules, activity, notifications, kv
```

## The one rule: the AI proposes, a person approves

The model never calls PayPal. Its tools come in two kinds:

- **Read tools** (`list_invoices`, `get_client_insights`, `get_earnings_summary`, `forecast_cashflow`, `get_top_customers`, `check_budget`, `suggest_retainers`, `get_growth_insights`) return computed facts.
- **Propose tools** (`propose_invoice`, `propose_recurring`, `propose_reminder`, `propose_late_fee`, `propose_cancel`) validate a draft and insert a *pending action*.

Only `POST /api/actions/:id/approve`, triggered by a click, runs the PayPal calls. An action moves from `pending` to `executing` with a compare-and-set update (`UPDATE … WHERE status = 'pending'`), so a double click or two tabs cannot send twice, and every PayPal write carries a `PayPal-Request-Id` derived from the action id, so a retried request is idempotent on PayPal's side too. A prompt injection hidden in a screenshot can, at worst, put a wrong draft in the tray.

## Numbers are computed; the AI writes words

Every figure on screen comes from code. The AI is used to turn sentences and screenshots into drafts, to write reminder and offer emails, and to phrase the Money brief and the Growth plan from a JSON of facts it is told not to go beyond. Each AI feature has a deterministic fallback (template emails, rule-based brief and plan), so the app works with no AI key at all.

## Payment model (src/budget.js)

Each client gets a lateness distribution learned from their paid invoices, shrunk towards the business-wide average with empirical Bayes (few invoices → closer to the average), plus kernel noise. An overdue invoice is sampled *conditionally* on how late it already is, so it is never "predicted" to have been paid in the past. A small Beta(49,1) prior covers the chance an invoice is never paid. On top, regular clients' new work arrives as a Poisson process. A seeded random generator (mulberry32) makes every answer repeatable.

The Budget Estimator simulates 4,000 futures with this model, subtracting PayPal's fee (3.49% + $0.49) and the tax share from every payment and taking bills out on their dates, and calls a purchase safe only if the balance stays above the cushion for the 30 days after (a sliding-window minimum). The dashboard's "Expected in 30 days" and every "expected on" date use the same model.

## Growth (src/growth.js)

The Growth page reads the last 12 months of invoices and reports:

- **Segments.** For each client: median gap between invoices (their cadence), days since the last one, yearly value, and average days late. Rules turn these into Champions, Loyal, Valuable but slow, Slipping away (quiet for more than half a cycle past their usual cadence), New, One-off and Gone quiet.
- **Client map.** Yearly value against average days late, split at the median value and at 7 days late (the same line the segments use).
- **Industries.** Clients carry an `industry` field. Per sector: billed, value per client, on-time rate, days to pay, and a trend over the last 3 full calendar months against the 3 before. The score is 60% value per client and 40% on-time rate, so it can be explained in one sentence.
- **Work areas.** Line items are grouped by profession-specific keyword rules (a web developer's "Integrations and APIs" or a designer's "Print and packaging"), with a general list as fallback. Retainers are labelled "On a plan" rather than trending, because they move with the plan, not with demand.
- **Concentration and DSO.** Herfindahl index over client shares (bands from US merger guidelines: under 1,500 spread out, over 2,500 concentrated), and days sales outstanding now and 90 days ago, rebuilt from invoice and payment dates.
- **Learning labels** (`src/labels.js`). Clients without an industry are labelled from the company name, the email domain (including run-together words like *kumarexports*) and the work billed; anything still unclear goes to the AI in one batch, which picks from the standard list or names a new sector. Line items the work-area rules can't place are grouped the same way. Labels are saved, marked as automatic, and never override one the owner set. A failed AI call backs off for 15 minutes.
- **Up-front payers.** A client whose median payment is a week or more before the due date is marked as paying up front and is never counted as slow.
- **Receivables aging and cohorts** (for businesses): money owed in 0 / 1–30 / 31–60 / 61–90 / 90+ day buckets, new customers per month and how many came back, and the share of billing from repeat customers.
- **Opportunities.** Ranked by the money at stake. Each card states its basis. An amount appears only when it follows from the book (a retainer's yearly gain, last year's billing from a slipping client, 10% of a work area's billing). Nothing is estimated from outside data.

The 90-day plan is cached against a fingerprint of the book (every invoice's status, amount and paid date, and every client's industry), so any change produces a new plan, and it is told to start from the biggest thing in the data.

## Accounts and sample data

`accountType` (freelancer or business) keeps every feature and every name the same; it changes the order of the menu, the dashboard's first block (freelancer: what to collect and from whom; business: receivables aging, DSO, repeat customers, where to grow) and the default terms. The data model is the same. Sample data is loaded through `src/sample.js`, which records the exact invoices, clients and schedules it created, so **Remove sample data** deletes only those (a sample client you have since billed for real is kept). A PayPal-connected account starts empty unless the owner asks for samples.

## Reminders

Every reminder, AI-written or templated, gets the invoice's pay link inserted before the sign-off. After a reminder goes out, the next planned step is pushed back by the cooldown (`REMINDER_COOLDOWN_DAYS`, default 3), so the Invoices page never asks for another reminder the day after one was sent.

## Public pages for the client

Three pages need no sign-in and are reached only through unguessable tokens:

| Page | What it shows |
|---|---|
| `/d/:token` | Pay to unlock: locked until PayPal reports the invoice paid, then reveals the final-files link. |
| `/r/:token` | A numbered, printable receipt (`R-<invoice number>`). Views are counted, except the owner's preview (`?preview=1`). |
| PayPal's own invoice page | Payment happens on PayPal; PayPilot never sees card data. In demo mode a practice checkout (`/mock-pay.html`) stands in for it, clearly labelled, and ends on the receipt. |

Inside the app, **Your client's view** (`/client-view?inv=…`) previews all of it step by step: the invoice email, the payment page, the receipt and the files.

## Receipts (src/receipts.js)

PayPal emails its own receipt when a client pays through PayPal. Bank transfers and cash, recorded with **Mark paid**, get none, and companies often need one for their books. Every paid invoice gets a receipt record in the key-value store (`receipt:<invoice id>` with number, token, sent and viewed times). The Receipts page lists what still needs sending, emails it (mailto, then marks it sent) and shows when the client opened it.

## Live updates

PayPal webhooks (signature verified with PayPal's verify API) and a 2-minute poll both feed `applyStatus` in `src/sync.js`. A status change updates the invoice, unlocks delivery pages, settles early-pay discounts, and pushes a notification over Server-Sent Events to every open tab. The poll checks up to 25 open invoices per run in turn (so large books are fully covered without bursts of API calls) and drops to every 10 minutes while verified webhooks are arriving.

## Data and migrations

SQLite tables are created on start and extended with additive migrations (`ALTER TABLE … ADD COLUMN`), so an old database keeps working after an update. Small settings and per-feature state live in a `kv` table. Seeding and multi-row writes run in transactions.

## Security

- Optional passcode: scrypt hash, HMAC-signed session cookie, timing-safe comparison, rotating the secret signs everyone out.
- Security headers (Content-Security-Policy, same-origin framing, no sniffing), JSON body limit, `X-Request-Id` on every response and in error logs.
- Secrets come from `.env` or the Settings page and are never sent to the browser.

## Tests

`npm test` runs the Node test runner over the whole stack: PayPal in mock mode (an in-process twin of the Invoicing API) and the AI through a scripted stub, so CI needs no secrets. The suite covers approval idempotency, webhooks, the budget model's sanity, retainers, receipts, client view, growth and routing.
