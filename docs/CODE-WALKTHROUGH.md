# Code walkthrough

This page explains the code by following real things through it: an invoice from a sentence to "Paid", a reminder, and a budget question. If you need to explain the project in an interview or change it later, start here. [ARCHITECTURE.md](ARCHITECTURE.md) explains the design decisions in more depth.

## The big picture

PayPilot is a single Node.js program. There is no build step and no framework on the front end.

- `server.js` creates the web server (Express 5), defines every URL, and serves the pages in `public/`.
- `src/` holds everything behind those URLs, one file per feature.
- `public/` holds the pages. Each page is an `.html` file plus a `.js` file with the same name. They call the server with `fetch('/api/...')` and draw the result.
- Data is stored in one SQLite file (`data/paypilot.db`), created automatically on first start.

```
browser ──fetch──► server.js ──► src/<feature>.js ──► src/db.js (SQLite)
                                       │
                                       ├──► src/paypal.js (PayPal REST API)
                                       └──► src/llm.js (Gemini / Claude / OpenAI)
```

## Follow one invoice

**1. You type a sentence.** On the Assistant page (`public/chat.js`) you type *"Bill Marcus Vance for 3 logo concepts at $150, due in 10 days"*. The page sends it to `POST /api/chat`.

**2. The AI agent reads it.** `server.js` passes the text to `chat()` in `src/agent.js`. That file holds:
- the system prompt: who the AI is, today's date, and the rules;
- the list of tools the AI may call, each with a JSON schema;
- the handlers that run when the AI calls a tool.

`runToolLoop()` in `src/llm.js` sends the conversation to the model. When the model asks for a tool (for example `get_client_insights` to check Marcus's payment history), the loop runs the handler, sends the result back, and repeats until the model answers in plain text. `src/llm.js` has one adapter each for Gemini, Claude and OpenAI-compatible APIs, so the rest of the code doesn't care which one is used.

**3. The AI can only propose.** To create the invoice the model calls `propose_invoice`. That handler doesn't touch PayPal. It validates the draft and calls `createAction()` in `src/actions.js`, which saves a row in the `actions` table with status `pending`. The draft appears in the approval tray.

**4. You approve.** Clicking **Approve** calls `POST /api/actions/:id/approve`, which runs `approveAction()` in `src/actions.js`:
- `transitionAction(id, 'pending', 'executing')` is an `UPDATE ... WHERE status = 'pending'`. Only one request can win it, so a double click can't send twice.
- Your edits are merged in and validated again on the server (`normaliseInvoiceDraft`). The browser is never trusted.
- The `create_invoice` executor calls `paypal.createAndSendInvoice()`.

**5. PayPal.** `src/paypal.js` gets an OAuth token, asks PayPal for the next invoice number, creates the invoice and sends it. Every write has a `PayPal-Request-Id` header built from the action id, so PayPal ignores a repeated request. Each step is checkpointed, so a retry after a failure carries on where it stopped. Failed calls are retried only when that is safe: reads on 429/5xx, and writes only on 429/503. Every call times out after 20 seconds. When PayPilot runs without keys, the same file contains a mock that behaves like PayPal, which is what demo mode and the tests use.

**6. The client pays.** PayPal tells us in one of two ways:
- a **webhook** to `POST /api/webhooks/paypal`, whose signature is verified with PayPal first;
- a **check every 2 minutes** from `src/scheduler.js`, which calls `syncInvoices()` in `src/sync.js`.

Both end in `applyStatus()` in `src/sync.js`. That function re-reads the invoice from the database first, so a poll and a webhook arriving together can't both notify you. It refuses to move a paid or cancelled invoice back to unpaid, which matters because PayPal can deliver events out of order. When an invoice becomes paid, it records the date, unlocks any attached files (`src/delivery.js`), settles an early-pay discount (`src/earlypay.js`) and calls `notify()`.

**7. You're told.** `src/notify.js` stores the notification and pushes it to every open tab over Server-Sent Events (`GET /api/events`). `public/common.js` listens and shows the toast and the bell count.

## Follow one reminder

- `src/autopilot.js` gives each unpaid invoice a plan of three steps (friendly, firm, final) with dates. `runAutopilot()` runs from the scheduler and, when a step is due, asks for a draft.
- `composeReminder()` in `src/followups.js` writes the email. It gives the AI the invoice, the client's payment habit and the tone. A good client gets a warm voice; a repeat late payer gets the terms and dates. If there's no AI, a template is used. `withPayLink()` then puts the PayPal pay link into the message.
- The reminder becomes a pending action like any other, and is sent only after approval, with `POST /v2/invoicing/invoices/{id}/remind`.

## Follow one budget question

*"Can I spend $1,800 on the 21st?"* goes to `estimateBudget()` in `src/budget.js`.

1. For each client it builds a list of how many days late they paid in the past. A client with only a few invoices is blended with everyone's average, so one late payment doesn't make them look terrible.
2. For each unpaid invoice it draws a payment date from that client's history. An invoice that is already 10 days late can only be paid from today onwards.
3. It does this 4,000 times. Each run takes off PayPal's fee and your tax share, and takes out your bills on their dates.
4. A run counts as "yes" if, after the purchase, your balance stays above your cushion for the next 30 days.
5. The answer is the share of "yes" runs. "Which invoice decides it" compares the chance when that invoice arrives in time with the chance when it doesn't.

The random numbers are seeded from your book only, not from the numbers you typed. So the same question always gives the same answer, and raising the price can never raise the chance.

## Where each feature lives

| File | What it does |
|---|---|
| `server.js` | All routes, plus security middleware: sign-in, same-origin check, headers, visitor workspaces |
| `src/config.js` | Reads `.env`; the live settings object; date helpers; `cents()` for exact rounding |
| `src/db.js` | SQLite tables and every query (clients, invoices, actions, notifications, key-value store) |
| `src/settings.js` | Settings saved from the app: business details, PayPal keys, preferences |
| `src/agent.js` | AI system prompt, tools and chat sessions |
| `src/llm.js` | Gemini / Claude / OpenAI adapters, retries and model fallback |
| `src/actions.js` | Pending actions, approval, and the code that runs each action against PayPal |
| `src/paypal.js` | PayPal API client (real and mock), retries, friendly error messages |
| `src/sync.js` | Payment status from webhooks and polling |
| `src/scheduler.js` | Background jobs: payment checks, reminders, retainers, due-date alerts |
| `src/autopilot.js` | The 3-step reminder plan for each invoice |
| `src/followups.js` | Writing reminder emails |
| `src/analytics.js` | Totals, client risk score, 30-day forecast, CSV export |
| `src/insights.js` | The Analytics page figures |
| `src/budget.js` | The Budget Estimator (Monte Carlo model) |
| `src/offers.js` | Suggested retainers |
| `src/growth.js` | Growth page: segments, industries, work areas, concentration, DSO, opportunities, 90-day plan |
| `src/labels.js` | Guessing each client's industry and grouping invoice lines (rules first, AI for the rest) |
| `src/bizprofile.js` | Turning a business's own description into its profile |
| `src/receipts.js` | Numbered receipts and their public pages |
| `src/delivery.js` | Pay to unlock |
| `src/earlypay.js` | Early-pay discounts |
| `src/tax.js` | Tax summary and 1099 hints |
| `src/brief.js` | The Money brief |
| `src/business.js`, `src/personas.js`, `src/seed.js`, `src/sample.js` | Professions and sample data |
| `src/context.js`, `src/workspace.js` | Private workspaces for visitors of the public demo |
| `src/notify.js` | Notifications and live updates |

## How the public demo keeps visitors apart

When `VISITOR_WORKSPACES=1`, each visitor gets a cookie with a random 128-bit id and their own database file at `data/spaces/<id>/paypilot.db`. The middleware `visitorSpace` in `server.js` reads the cookie and runs the rest of the request inside that workspace, using Node's `AsyncLocalStorage` (`src/context.js`). Because of this:
- `sql()` in `src/db.js` opens the visitor's own database;
- `config` (`src/config.js`) keeps settings and PayPal keys per visitor;
- caches and live notifications are per visitor (`perSpace()`);
- the rest of the code didn't need to change.

A new workspace starts empty on the setup screen, where the visitor picks the demo or connects their own sandbox. The server's own `.env` PayPal keys are never used inside a workspace. Workspaces nobody has opened for 3 days are deleted.

## Tests

`npm test` runs everything in `test/` with Node's built-in test runner. Each test file starts the real server on a random port, with mock PayPal and a scripted AI, and calls it over HTTP like a browser would. Some files worth knowing:

- `e2e.test.js`: the full chat → approve → PayPal → paid flow.
- `sync.test.js`: duplicate, racing and out-of-order webhooks.
- `paypal-errors.test.js`: a fake PayPal that returns 429/500 or never answers.
- `budget-property.test.js`: nudging one input only moves the answer the right way.
- `golden.test.js`: aging, DSO and concentration checked against numbers worked out by hand.
- `workspaces.test.js`: two visitors never see each other's data.

## Questions you might be asked

**Why can't the AI send an invoice by itself?**
Because it only has propose tools. Sending happens in `approveAction()`, which only a click reaches. This also limits prompt injection to creating a wrong draft.

**How do you avoid duplicate invoices?**
Three layers. First, an atomic status change on approval. Second, a `PayPal-Request-Id` on every write, which PayPal de-duplicates. Third, local checkpoints for each step.

**Why SQLite?**
It's one file, needs no setup, ships with Node 22, and is more than fast enough. With 1,000 invoices and 200 clients, every API call answers in under a second.

**Where do the numbers come from: the AI or the code?**
The code. The AI explains results and writes emails. Every AI feature has a non-AI fallback.

**What happens if PayPal is slow or down?**
Calls time out after 20 seconds. Reads are retried. Writes are retried only when PayPal certainly didn't process them. The user sees a plain sentence instead of an API error.
