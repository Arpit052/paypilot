# Testing

## Automated tests

```bash
npm test
```

There are 128 tests in `test/`, run with Node's built-in test runner. Each file starts the real server on a random port and calls it over HTTP. PayPal runs as a local twin of the Invoicing API, and the AI is a scripted stub, so the suite needs no keys or network. GitHub Actions runs it on Node 22 and 24 on every push.

| File | What it checks |
|---|---|
| `e2e.test.js` | Chat → draft → edit → approve → PayPal → paid; validation; follow-ups and their tone; dashboard maths |
| `features.test.js`, `business.test.js`, `learning.test.js` | Budget, retainers, receipts, pay to unlock, early-pay, client view, growth, professions, account types |
| `money.test.js`, `budget-property.test.js` | The budget model: repeatable, ordered percentiles, and every input moves the answer the right way |
| `golden.test.js` | Aging buckets at their exact edges, DSO and concentration against hand-worked numbers |
| `approval.test.js` | Prompt injection, four approvals at once, edits re-checked on the server, exact cents, AI outages |
| `sync.test.js` | Webhooks arriving twice, late, or at the same time as a poll |
| `paypal-errors.test.js` | A fake PayPal returning 401/422/429/500 or hanging: retries, timeouts, readable errors |
| `security.test.js`, `auth.test.js` | Passcode limits, same-origin writes, sign-in, sample data, pay-to-unlock |
| `exports.test.js` | CSV exports can't run spreadsheet formulas |
| `hosted.test.js`, `workspaces.test.js` | The public demo: locked shared mode, private workspaces, no key leaks between visitors |
| `bizprofile.test.js` | A business's own description read into a profile, with and without AI |

## Live sandbox check

```bash
npm run sandbox-check
```

This runs against the real PayPal sandbox with your keys. It checks the Invoicing permission, the total of a draft to the cent, `PayPal-Request-Id` de-duplication, and that a forged webhook is rejected. It cleans up after itself.

## Manual testing

Before submission the app was tested end to end, phase by phase:
1. setup and first run
2. PayPal integration and errors
3. the approval rule
4. AI tools
5. numbers
6. budget and tax
7. exports and pay-to-unlock
8. every page at 1440, 768 and 375 px
9. performance with 1,000 invoices and 200 clients
10. security and accessibility

Every bug got a failing test first, then the fix, then a full run of the suite.

## Checks run

| ID | Phase | Feature | Steps | Expected | Actual | Result | Sev | Evidence |
|---|---|---|---|---|---|---|---|---|
| T01 | 0 | Fresh clone | `git clone`, `npm ci`, `npm start` with no .env | starts, clear log | starts in 1.5 s; log says no .env | PASS | – | manual run |
| T02 | 0 | Secrets | scan git history and .gitignore | no keys committed | clean; .env, data/ and *.db ignored | PASS | – | `git log -p` scan |
| T03 | 0 | Bad keys | connect with fake or swapped keys | rejected, nothing saved | PayPal rejects them; clear message | PASS | – | manual run |
| T04 | 0 | One-click demo | welcome → Try demo with no business name | opens | blocked by a "business name" error | FAIL→FIXED | P2 | security.test B4 |
| T05 | 0 | Seed script | `npm run seed`, then Remove sample data | samples removable | samples were untracked | FAIL→FIXED | P2 | security.test B2 |
| T06 | 1 | Login | 12 wrong passcodes in a minute | blocked | unlimited guesses | FAIL→FIXED | P1 | security.test B1 |
| T07 | 1 | CSRF | POST /api/invoices with Origin evil.example | 403 | accepted | FAIL→FIXED | P1 | security.test B8 |
| T08 | 1 | Hosted demo | a visitor clicks Disconnect / Reset / Remove | blocked for everyone | anyone could wipe the shared copy | FAIL→FIXED | P1 | hosted.test B5 |
| T09 | 1 | Hosted restart | Render free tier restarts (disk wiped) | sample book is back | empty app | FAIL→FIXED | P1 | hosted.test B5 |
| T10 | 1 | Mock endpoints | /api/mock/* on a real account | 400 | /mock/invoice answered | FAIL→FIXED | P2 | hosted.test B3 |
| T11 | 1 | XSS | `<img onerror>` in business, client and item names; open every page | no script runs | no script ran on any of 14 pages | PASS | – | Playwright run |
| T12 | 2 | Duplicate webhook | PAID event sent twice | 1 notification | 1 | PASS | – | sync.test |
| T13 | 2 | Poll + webhook race | poll reads invoice, webhook pays it, poll applies | 1 notification | 2 notifications | FAIL→FIXED | P1 | sync.test |
| T14 | 2 | Out-of-order event | UPDATED/SENT arrives after PAID | stays PAID | went back to SENT | FAIL→FIXED | P1 | sync.test |
| T15 | 2 | Cancelled reopened | SENT after CANCELLED | stays CANCELLED | reopened | FAIL→FIXED | P1 | sync.test |
| T16 | 2 | Refund after paid | REFUNDED after PAID | recorded | recorded | PASS | – | sync.test |
| T17 | 2 | Forged webhook | unsigned PAID event on a real account | refused | refused (≥400) | PASS | – | hosted.test |
| T18 | 3 | PayPal 429/503 on read | fake PayPal returns 429, 503, then 200 | retried, succeeds | no retry | FAIL→FIXED | P2 | paypal-errors.test |
| T19 | 3 | PayPal hangs | fake PayPal never answers | times out, clear message | hung forever | FAIL→FIXED | P1 | paypal-errors.test |
| T20 | 3 | Expired token | 401 mid-session | new token, retried once | failed | FAIL→FIXED | P2 | paypal-errors.test |
| T21 | 3 | Write retry rules | reminder gets 429, then 500 | 429 retried with the same request id; 500 not retried | – | PASS (after fix) | – | paypal-errors.test |
| T22 | 3 | Error wording | 400/401/403/404/422/429/500/503 | plain sentence, no API path | raw "PayPal POST /v2/..." | FAIL→FIXED | P2 | paypal-errors.test |
| T23 | 3 | Prompt injection | model told to send and cancel without asking | drafts only | drafts only | PASS | – | approval.test |
| T24 | 3 | Double approve | 4 approvals at the same time | sent once, three 409s | once | PASS | – | approval.test |
| T25 | 3 | Edits re-checked | approve with −50, 0, Infinity, 1e400, bad email, 400% tax, XYZ | 400, draft stays | Infinity and 1e400 accepted | FAIL→FIXED | P2 | approval.test |
| T26 | 3 | Cents | 0.1+0.2, $0.01, $999,999.99, 1.005, 8.875% tax | exact | 1.005 became 1.00 | FAIL→FIXED | P2 | approval.test |
| T27 | 4 | AI provider down | 429 / network / 500 from the model | plain message; chat not stuck | raw RESOURCE_EXHAUSTED | FAIL→FIXED | P2 | approval.test |
| T28 | 5 | Aging edges | open invoices 0/1/30/31/60/61/90/91 days late | right buckets | right | PASS | – | golden.test |
| T29 | 5 | DSO | hand-computed 800/600×90 | 120 | 120 | PASS | – | golden.test |
| T30 | 5 | HHI | $3k / $1k clients | 6,250, concentrated | 6,250 | PASS | – | golden.test |
| T31 | 5 | Empty book | growth report with no data | no NaN, DSO "—" | ok | PASS | – | golden.test |
| T32 | 6 | Budget monotonic | price in $250 steps, cash, tax, fees, buffer, spending | chance only moves the right way | fees once raised the chance | FAIL→FIXED | P2 | budget-property.test |
| T33 | 6 | Budget repeatable | same inputs twice | same answer | same | PASS | – | money.test |
| T34 | 6 | Tax rules | 1099-K, 1099-NEC, SS wage base 2026 | match IRS/SSA | match; sources now cited | PASS | – | web check + tax page |
| T35 | 7 | CSV injection | client named `=HYPERLINK(...)`, export | stays text | formula | FAIL→FIXED | P2 | exports.test |
| T36 | 7 | Pay-to-unlock | read the unlock page and practice checkout before paying | no work link | checkout leaked it | FAIL→FIXED | P2 | security.test B17 |
| T37 | 7 | Unlock after pay | pay, then reopen the unlock page | link shown | shown | PASS | – | security.test B17 |
| T38 | 8 | Click-through | 16 pages × 3 widths, demo and empty account | 0 errors, 0 5xx | /client-view called /api/invoices/null | FAIL→FIXED | P3 | Playwright run |
| T39 | 8 | Phone layout | 375 px, measure horizontal overflow | 0 px | dashboard 89, tax 107, client view 89 | FAIL→FIXED | P2 | Playwright run |
| T40 | 8 | Phone KPI | "Expected in 30 days" at 375 px | one line | last digit wrapped | FAIL→FIXED | P3 | screenshot |
| T41 | 8 | Empty states | new account: Growth and Dashboard | honest "—" | "Spread out", "Best month $0 Jun" | FAIL→FIXED | P3 | screenshot |
| T42 | 9 | Performance | 1,000 invoices, 200 clients | APIs < 1 s, pages < 2 s | APIs ≤ 0.86 s, pages ≤ 1.29 s | PASS | – | curl and Playwright timings |
| T43 | 9 | Headers | CSP, nosniff, frame, referrer, HSTS on https | present | HSTS was missing | FIXED | P3 | curl -I |
| T44 | 9 | Dependencies | `npm audit` | 0 | 0 | PASS | – | npm audit |
| T45 | 10 | Contrast | muted text against panels | ≥ 4.5:1 | 3.84:1 | FAIL→FIXED | P2 | contrast calc |
| T46 | 10 | Landing stats | every number has a checkable source | sourced | "52% write it off" unverifiable | FAIL→FIXED | P2 | web check |

---


## Bugs found and fixed

| # | Sev | Bug | Root cause | Fix | Commit |
|---|---|---|---|---|---|
| B1 | P1 | Passcode could be brute-forced | no limit on /api/login | 10 failures/min per IP → 429 + Retry-After | af5f138 |
| B5 | P1 | Any visitor could disconnect or wipe the shared copy; a restart emptied it | no shared-demo mode; disk is ephemeral | `HOSTED_DEMO=1` locks 7 actions; `SEED_SAMPLE_ON_BOOT=1` | af5f138 |
| B8 | P1 | Cross-site forms could create invoices | no Origin check on writes | refuse writes whose Origin host ≠ Host | af5f138 |
| B9 | P1 | "Payment received" shown twice | the poll used an invoice object read before its await | applyStatus re-reads from the DB | 14e7c41 |
| B10 | P1 | Paid or cancelled invoice reopened by a late event | any status change was accepted | transition rules: only refunds move a settled invoice | 14e7c41 |
| B11 | P1 | A hung PayPal hung the page and the scheduler | fetch had no deadline | 20 s timeout on token and API calls | 14e7c41 |
| B2 | P2 | Seed-script samples couldn't be removed | `seedDemo()` doesn't record ids | the script uses `seedSample()` | af5f138 |
| B3 | P2 | Mock invoice endpoint live on real accounts | missing `isMock()` guard | guard added | af5f138 |
| B4 | P2 | Demo needed a business name | server and UI required it | default name | af5f138 |
| B12 | P2 | No retry on 429/503 or an expired token | single-shot API call | reads retry; writes retry only with a request id; 401 → new token | 14e7c41 |
| B13 | P2 | Budget chance could move the wrong way | the RNG seed included the user's inputs | common random numbers (seed from the book only) | 14e7c41 |
| B14 | P2 | 1.005 rounded to 1.00 | `Math.round(x*100)/100` | `cents()`: half away from zero with precision fix | 14e7c41 |
| B15 | P2 | Infinity / 1e400 accepted | `> 0` check passes Infinity | `Number.isFinite` + per-line cap | 14e7c41 |
| B16 | P2 | CSV formula injection | cells not neutralised | prefix `'` on `= + - @` text cells | bb72cf7 |
| B17 | P2 | Work link reached the checkout before payment | invoiceRow included delivery.url | stripped from the client-facing payload | bb72cf7 |
| B18 | P2 | Raw AI errors shown to users | message passed through | `friendlyAiError()` + right status | bb72cf7 |
| B19 | P2 | Pages scrolled sideways on phones | tables and grids with fixed min widths | tables scroll inside their box; `min(…,100%)` | 447f1ca |
| B24 | P2 | Muted text below AA contrast | #71717a on near-black | #8a8a93 (5.7:1) | a0a0047 |
| B23 | P2 | Unverifiable landing statistic | no primary source | replaced with QuickBooks 47%; every stat linked | 7fb688f |
| B6/B7 | P3 | Render needed a Node version; README steps were outdated | – | NODE_VERSION, .node-version, health check, README rewrite | af5f138 |
| B20 | P3 | KPI digit wrapped on phones | fixed 27 px font | clamp() + nowrap | 447f1ca |
| B21 | P3 | /client-view fetched invoice "null" | redirect didn't stop the script | stop after replace() | 447f1ca |
| B22 | P3 | Empty book said "Spread out", "Best month $0" | labels computed from zero data | show "—" and the reason | 447f1ca |

---


## Performance

With 1,000 invoices and 200 clients, every API answers in under 0.9 s and every page loads in under 1.3 s.

## Known limits

- The payment-date range ("likely between Nov 12 and 18") isn't yet backtested against held-out payments.
- Receivables aging uses each invoice's full total; partial payments aren't subtracted.
- Webhooks need a public URL and `PAYPAL_WEBHOOK_ID`. Without them, payments show up within 2 minutes through polling.
