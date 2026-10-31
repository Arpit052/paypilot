// PayPilot API + web server (Express 5).
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config, isoDate, envFile } from './src/config.js';
import { listInvoices, listClients, listActivity, getInvoiceByPaypalId, resetDb, listSchedules, getSchedule, updateSchedule, deleteSchedule, getClient, logActivity } from './src/db.js';
import { chat, resetSession } from './src/agent.js';
import { listActions, approveAction, rejectAction } from './src/actions.js';
import { earningsSummary, forecastCashflow, chartSeries, clientStats, clientName, isOverdue } from './src/analytics.js';
import { syncInvoices, applyWebhookEvent } from './src/sync.js';
import { scanFollowups } from './src/followups.js';
import { paypal, isMock } from './src/paypal.js';
import { llmAvailable } from './src/llm.js';
import { seedDemo } from './src/seed.js';
import { runRecurring } from './src/recurring.js';
import { moneyBrief } from './src/brief.js';
import { startScheduler, runJobs, lastRun } from './src/scheduler.js';
import { invoiceTotals, topCustomers, paymentsInMonth, invoicesCsv } from './src/analytics.js';
import { runningTimer, startTimer, stopTimer, addManualEntry, listEntries, removeEntry, unbilledTime, proposeInvoiceFromTime, rateFor } from './src/timetracking.js';
import { createAction } from './src/actions.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const startedAt = Date.now();

// ---------- passcode login (optional, APP_PASSWORD) ----------
const SESSION_COOKIE = 'pp_session';
const sessionToken = () => crypto.createHmac('sha256', config.appPassword).update('paypilot-session-v1').digest('hex');

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Routes that must work without a session: login itself, PayPal webhooks, cron, health.
const PUBLIC_PATHS = [/^\/login(\.html)?$/, /^\/app\.css$/, /^\/api\/login$/, /^\/api\/health$/, /^\/api\/webhooks\//, /^\/api\/cron\//];

function requireLogin(req, res, next) {
  if (!config.appPassword || PUBLIC_PATHS.some((re) => re.test(req.path))) return next();
  const tok = readCookie(req, SESSION_COOKIE);
  if (tok && safeEqual(tok, sessionToken())) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in.' });
  res.redirect(302, '/login.html');
}

// ---------- tiny in-memory rate limiter (per IP) ----------
function rateLimit({ perMinute, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'local';
    const recent = (hits.get(key) || []).filter((t) => now - t < 60000);
    if (recent.length >= perMinute) {
      res.set('Retry-After', String(Math.ceil((60000 - (now - recent[0])) / 1000)));
      return res.status(429).json({ error: message });
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  });
  next();
}

function invoiceRow(i, today) {
  return { ...i, client: clientName(i.clientId), displayStatus: isOverdue(i, today) ? 'OVERDUE' : i.status };
}

function aiLabel() {
  if (!llmAvailable()) return 'none';
  return config.llm.provider === 'gemini' ? `gemini (${config.llm.geminiModel})` : config.llm.provider;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // correct client IPs / https behind Render's proxy
  app.use(securityHeaders);
  app.use(express.json({ limit: '12mb' })); // screenshots arrive as base64
  app.use(requireLogin);

  const api = express.Router();

  api.get('/health', (req, res) =>
    res.json({
      ok: true,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      paypal: config.paypal.mode,
      ai: aiLabel(),
      scheduler: { everyMinutes: config.schedulerMinutes, lastRun: lastRun.at },
    })
  );

  api.post('/login', (req, res) => {
    if (!config.appPassword) return res.json({ ok: true });
    if (!safeEqual(String(req.body?.password || ''), config.appPassword)) throw httpError(401, 'Wrong passcode.');
    const secure = req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `${SESSION_COOKIE}=${sessionToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}${secure}`);
    res.json({ ok: true });
  });
  api.post('/logout', (req, res) => {
    res.set('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  api.get('/config', (req, res) =>
    res.json({
      businessName: config.businessName,
      currency: config.currency,
      paypalMode: config.paypal.mode,
      llmProvider: llmAvailable() ? config.llm.provider : 'none',
      llmLabel: aiLabel(),
      today: isoDate(),
      demoTimeOffsetDays: config.demoTimeOffsetDays,
      webhookConfigured: Boolean(config.paypal.webhookId),
      timezone: config.timezone,
      defaultTaxPercent: config.defaultTaxPercent,
      loginEnabled: Boolean(config.appPassword),
    })
  );

  // ---- assistant ----
  api.post('/chat', rateLimit({ perMinute: config.chatRateLimitPerMin, message: 'Too many messages in a minute. Please wait a moment.' }), async (req, res) => {
    const body = req.body || {};
    if (!llmAvailable()) throw httpError(503, 'No AI provider configured. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) to .env and restart.');
    const sessionId = String(body.sessionId || 'default').slice(0, 64);
    let image = null;
    if (body.image?.data) {
      const mediaType = String(body.image.mediaType || '');
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mediaType)) throw httpError(400, 'Unsupported image type');
      image = { mediaType, data: String(body.image.data).replace(/^data:[^,]+,/, '') };
    }
    if (!String(body.message || '').trim() && !image) throw httpError(400, 'Empty message');
    res.json(await chat(sessionId, { text: body.message, image }));
  });
  api.post('/chat/reset', (req, res) => {
    resetSession(String(req.body?.sessionId || 'default'));
    res.json({ ok: true });
  });

  // ---- approvals ----
  api.get('/actions', (req, res) => {
    const { status, origin, type } = req.query;
    res.json({ actions: listActions({ status, origin, type }).slice(0, 100) });
  });
  api.post('/actions/:id/approve', async (req, res) => res.json({ action: await approveAction(req.params.id, req.body?.edits) }));
  api.post('/actions/:id/reject', (req, res) => res.json({ action: rejectAction(req.params.id) }));

  // ---- invoices / dashboard / clients ----
  api.get('/invoices', (req, res) => {
    const today = isoDate();
    res.json({ invoices: listInvoices().map((i) => invoiceRow(i, today)) });
  });
  api.post('/sync', async (req, res) => res.json(await syncInvoices()));
  api.get('/dashboard', (req, res) => {
    const today = isoDate();
    res.json({
      today,
      summary: earningsSummary({}, today),
      forecast: forecastCashflow(30, today),
      chart: chartSeries(today),
      activity: listActivity(15),
      pendingApprovals: listActions({ status: 'pending' }).length,
    });
  });
  api.get('/clients', (req, res) => {
    const today = isoDate();
    res.json({
      clients: listClients()
        .map((c) => ({ ...c, ...clientStats(c.id, today) }))
        .sort((a, b) => b.riskScore - a.riskScore),
    });
  });

  // ---- insights ----
  api.get('/insights/top-customers', (req, res) => res.json({ customers: topCustomers({ limit: Math.min(Number(req.query.limit) || 5, 50) }) }));
  api.get('/payments', (req, res) => res.json(paymentsInMonth(String(req.query.month || isoDate().slice(0, 7)))));
  api.get('/invoices.csv', (req, res) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="paypilot-invoices-${isoDate()}.csv"`);
    res.send(invoicesCsv());
  });

  // ---- time tracking ----
  api.get('/time', (req, res) => res.json({ running: runningTimer(), entries: listEntries(50), unbilled: unbilledTime() }));
  api.get('/time/running', (req, res) => res.json({ running: runningTimer() }));
  api.get('/time/rate/:clientId', (req, res) => res.json({ hourlyRate: rateFor(req.params.clientId) }));
  api.post('/time/start', (req, res) => res.json(startTimer(req.body || {})));
  api.post('/time/stop', (req, res) => res.json({ stopped: stopTimer() }));
  api.post('/time/entries', (req, res) => res.json({ entry: addManualEntry(req.body || {}) }));
  api.post('/time/entries/:id/delete', (req, res) => res.json(removeEntry(req.params.id)));
  api.post('/time/invoice', (req, res) => {
    const r = proposeInvoiceFromTime({ clientId: req.body?.clientId, origin: 'chat' });
    res.json({ action: r.action, hours: r.hours, total: r.total });
  });

  // ---- AI money brief ----
  api.post('/brief', rateLimit({ perMinute: 4, message: 'Please wait a minute before refreshing the brief.' }), async (req, res) =>
    res.json(await moneyBrief({ refresh: Boolean(req.body?.refresh) }))
  );

  // ---- recurring invoices ----
  api.get('/schedules', (req, res) =>
    res.json({
      schedules: listSchedules().map((sc) => ({
        ...sc,
        client: getClient(sc.clientId)?.name || 'Unknown',
        total: invoiceTotals(sc.items, sc.taxPercent).total,
      })),
    })
  );
  api.post('/schedules/run', (req, res) => res.json({ created: runRecurring() }));
  // manual form: the user filled it in themselves, so it's approved on submit
  api.post('/schedules', async (req, res) => {
    const b = req.body || {};
    const a = createAction(
      'create_schedule',
      {
        clientName: b.clientName,
        clientEmail: b.clientEmail,
        items: [{ name: b.description, quantity: 1, unitPrice: Number(b.amount) }],
        frequency: b.frequency,
        startDate: b.startDate,
        dueInDays: b.dueInDays,
        taxPercent: b.taxPercent,
      },
      { origin: 'form', summary: 'Recurring invoice (form)' }
    );
    try {
      res.json({ action: await approveAction(a.id) });
    } catch (e) {
      rejectAction(a.id);
      throw e;
    }
  });
  api.post('/schedules/:id/:op', (req, res) => {
    const sc = getSchedule(req.params.id);
    if (!sc) throw httpError(404, 'Schedule not found');
    const client = getClient(sc.clientId)?.name || 'client';
    if (req.params.op === 'pause') {
      updateSchedule(sc.id, { active: false });
      logActivity('schedule_paused', `Paused recurring invoice for ${client}`);
    } else if (req.params.op === 'resume') {
      updateSchedule(sc.id, { active: true });
      logActivity('schedule_resumed', `Resumed recurring invoice for ${client}`);
    } else if (req.params.op === 'delete') {
      deleteSchedule(sc.id);
      logActivity('schedule_deleted', `Deleted recurring invoice for ${client}`);
      return res.json({ ok: true, deleted: true });
    } else throw httpError(400, 'Unknown operation');
    res.json({ schedule: getSchedule(sc.id) });
  });
  api.post('/jobs/run', async (req, res) => res.json(await runJobs()));

  // ---- follow-ups ----
  api.post('/followups/scan', async (req, res) => res.json({ created: await scanFollowups() }));
  // For a scheduled job (e.g. Render Cron): GET /api/cron/followups?key=CRON_SECRET
  api.get('/cron/followups', async (req, res) => {
    if (!config.cronSecret || req.query.key !== config.cronSecret) throw httpError(403, 'Forbidden');
    res.json({ created: (await scanFollowups()).length });
  });

  // ---- PayPal webhooks ----
  api.post('/webhooks/paypal', async (req, res) => {
    const event = req.body || {};
    if (!isMock) {
      if (!config.paypal.webhookId) throw httpError(503, 'PAYPAL_WEBHOOK_ID not configured');
      const ok = await paypal.verifyWebhook(req.headers, event);
      if (!ok) throw httpError(400, 'Webhook signature verification failed');
    }
    res.json(applyWebhookEvent(event));
  });

  // ---- mock-mode helpers ----
  api.post('/mock/pay/:paypalId', (req, res) => {
    if (!isMock) throw httpError(400, 'Only available in mock mode');
    paypal.simulatePayment(req.params.paypalId);
    // delivered the same way PayPal would: as a webhook event
    res.json(applyWebhookEvent({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: req.params.paypalId, status: 'PAID' } } }));
  });
  api.get('/mock/invoice/:paypalId', (req, res) => {
    const inv = getInvoiceByPaypalId(req.params.paypalId);
    if (!inv) throw httpError(404, 'Not found');
    res.json({ invoice: invoiceRow(inv, isoDate()), businessName: config.businessName });
  });

  // ---- demo data ----
  api.post('/demo/seed', (req, res) => {
    if (listInvoices().some((i) => i.source === 'seed')) return res.json({ ok: true, already: true });
    seedDemo();
    res.json({ ok: true });
  });
  api.post('/demo/reset', (req, res) => {
    resetDb();
    res.json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // one error handler for everything (Express 5 forwards async errors here)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(`  [${req.method} ${req.path}] ${err.message}`);
    res.status(status).json({ error: status === 400 && err.type === 'entity.parse.failed' ? 'Invalid JSON' : err.message });
  });
  return app;
}

export function start(port = config.port) {
  return new Promise((resolve, reject) => {
    const server = createApp().listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(config.root, 'server.js')) {
  process.on('unhandledRejection', (e) => console.error('  [unhandled]', e?.message || e));
  start()
    .then(() => {
      startScheduler();
      console.log(`\n  PayPilot running → http://localhost:${config.port}`);
      console.log(envFile ? `  Settings: read from "${envFile}"` : `  Settings: NO .env FILE FOUND in ${config.root}`);
      const keys = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'];
      console.log('  Keys found: ' + (keys.filter((k) => process.env[k]).join(', ') || 'none'));
      console.log(`  PayPal: ${config.paypal.mode}${isMock ? ' (offline simulation - add PayPal sandbox keys to .env for real invoices)' : ''}`);
      console.log(`  AI:     ${llmAvailable() ? aiLabel() : 'NOT CONFIGURED - set GEMINI_API_KEY in .env'}`);
      console.log(`  Dates:  ${config.timezone}${config.appPassword ? ' | Login: passcode required' : ''}${config.schedulerMinutes > 0 ? ` | Background jobs every ${config.schedulerMinutes} min` : ''}\n`);
    })
    .catch((e) => {
      if (e.code === 'EADDRINUSE') {
        console.log(`\n  Port ${config.port} is already in use (probably another PayPilot window).`);
        console.log('  Close all PayPilot windows and start it again.\n');
      } else console.error(e);
      process.exit(1);
    });
}
