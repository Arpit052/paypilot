// PayPilot API + web server (Express 5).
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config, isoDate, envFile } from './src/config.js';
import { listInvoices, listClients, listActivity, getInvoiceByPaypalId, resetDb, listSchedules, getSchedule, updateSchedule, deleteSchedule, getClient, logActivity } from './src/db.js';
import { chat, resetSession } from './src/agent.js';
import { listActions, approveAction, rejectAction, normaliseInvoiceDraft } from './src/actions.js';
import { earningsSummary, forecastCashflow, chartSeries, clientStats, clientName, isOverdue } from './src/analytics.js';
import { syncInvoices, applyWebhookEvent, importFromPaypal } from './src/sync.js';
import { scanFollowups } from './src/followups.js';
import { paypal, isMock } from './src/paypal.js';
import { llmAvailable } from './src/llm.js';
import { seedDemo } from './src/seed.js';
import { runRecurring } from './src/recurring.js';
import { moneyBrief } from './src/brief.js';
import { startScheduler, runJobs, lastRun } from './src/scheduler.js';
import { invoiceTotals, topCustomers, paymentsInMonth, invoicesCsv } from './src/analytics.js';
import { createAction } from './src/actions.js';
import { eventStream } from './src/notify.js';
import { listNotifications, unreadNotificationCount, markNotificationsRead, deleteInvoice } from './src/db.js';
import { applySettings, setupDone, publicSettings, connectPaypal, useDemoMode, disconnectPaypal, saveBusinessSettings } from './src/settings.js';
import { verifyCredentials } from './src/paypal.js';
import { isOpen } from './src/analytics.js';

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
const PUBLIC_PATHS = [/^\/login(\.html)?$/, /^\/app\.css$/, /^\/common\.js$/, /^\/favicon\.svg$/, /^\/fonts\//, /^\/api\/login$/, /^\/api\/health$/, /^\/api\/webhooks\//, /^\/api\/cron\//];

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

// First run: send people to the "Connect PayPal / Try demo" screen before any page.
const WELCOME_FREE = /^\/(welcome|login|mock-pay)(\.html)?$/;
function welcomeGate(req, res, next) {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || WELCOME_FREE.test(req.path)) return next();
  const isPage = req.path === '/' || req.path.endsWith('.html') || !path.extname(req.path);
  if (isPage && !setupDone()) return res.redirect(302, '/welcome');
  next();
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  });
  next();
}

function invoiceRow(i, today) {
  return { ...i, client: clientName(i.clientId), clientEmail: getClient(i.clientId)?.email || '', displayStatus: isOverdue(i, today) ? 'OVERDUE' : i.status };
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
  applySettings();
  app.use(welcomeGate);

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
      paypalSource: publicSettings().paypal.source,
      lateFeePercent: config.lateFeePercent,
      lateFeeAfterDays: config.lateFeeAfterDays,
    })
  );

  // ---- settings: PayPal connection + business details ----
  api.get('/settings', (req, res) => res.json(publicSettings()));
  api.post('/settings/paypal/connect', rateLimit({ perMinute: 6, message: 'Too many attempts. Please wait a minute.' }), async (req, res) => {
    const clientId = String(req.body?.clientId || '').trim();
    const clientSecret = String(req.body?.clientSecret || '').trim();
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(clientId)) throw httpError(400, 'That Client ID looks incomplete. Copy it again from developer.paypal.com.');
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(clientSecret)) throw httpError(400, 'That Secret looks incomplete. Click "Show" next to Secret on developer.paypal.com and copy it again.');
    const check = await verifyCredentials(clientId, clientSecret);
    if (!check.ok) throw httpError(400, check.error);
    connectPaypal({ clientId, clientSecret });
    // demo invoices that were never on PayPal can't be chased on the real account
    let removed = 0;
    for (const inv of listInvoices()) {
      if (String(inv.paypalId || '').startsWith('INV2-MOCK-') && isOpen(inv)) {
        deleteInvoice(inv.id);
        removed++;
      }
    }
    const imp = await importFromPaypal().catch(() => ({ imported: 0 }));
    if (req.body?.sampleHistory !== false && !listInvoices().some((i) => i.source === 'seed')) seedDemo();
    logActivity('paypal_connected', 'Connected to PayPal sandbox');
    res.json({ ok: true, removedDemoInvoices: removed, imported: imp.imported, settings: publicSettings() });
  });
  api.post('/settings/paypal/demo', (req, res) => {
    useDemoMode();
    if (!listInvoices().length) seedDemo();
    res.json({ ok: true, settings: publicSettings() });
  });
  api.post('/settings/paypal/disconnect', (req, res) => {
    disconnectPaypal();
    logActivity('paypal_disconnected', 'Disconnected PayPal - now in demo mode');
    res.json({ ok: true, settings: publicSettings() });
  });
  api.post('/settings/business', (req, res) => res.json({ business: saveBusinessSettings(req.body || {}) }));

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
  api.post('/sync', async (req, res) => {
    const imp = await importFromPaypal().catch((e) => ({ imported: 0, errors: [e.message] }));
    const r = await syncInvoices();
    res.json({ ...r, imported: imp.imported, errors: [...(imp.errors || []), ...r.errors] });
  });
  // New invoice form: the user filled it in themselves. sendNow=true sends right away,
  // otherwise it's saved as a draft in the approval tray.
  api.post('/invoices', async (req, res) => {
    const b = req.body || {};
    const draft = normaliseInvoiceDraft({
      clientName: b.clientName,
      clientEmail: b.clientEmail,
      company: b.company,
      items: b.items,
      currency: b.currency,
      issueDate: b.issueDate,
      dueDate: b.dueDate,
      taxPercent: b.taxPercent,
      depositAmount: b.depositAmount,
      reference: b.reference,
      note: b.note,
    });
    const a = createAction('create_invoice', draft, { origin: 'form', summary: `Invoice ${draft.clientName} · ${draft.currency} ${draft.total}` });
    if (!b.sendNow) return res.json({ action: a, sent: false });
    res.json({ action: await approveAction(a.id), sent: true });
  });
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

  // ---- notifications (live via Server-Sent Events) ----
  api.get('/events', eventStream);
  api.get('/notifications', (req, res) => res.json({ unread: unreadNotificationCount(), notifications: listNotifications(30) }));
  api.post('/notifications/read', (req, res) => {
    markNotificationsRead(req.body?.id ? Number(req.body.id) : null);
    res.json({ unread: unreadNotificationCount() });
  });

  // ---- insights ----
  api.get('/insights/top-customers', (req, res) => res.json({ customers: topCustomers({ limit: Math.min(Number(req.query.limit) || 5, 50) }) }));
  api.get('/payments', (req, res) => res.json(paymentsInMonth(String(req.query.month || isoDate().slice(0, 7)))));
  api.get('/invoices.csv', (req, res) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="paypilot-invoices-${isoDate()}.csv"`);
    res.send(invoicesCsv());
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
    if (!isMock()) {
      if (!config.paypal.webhookId) throw httpError(503, 'PAYPAL_WEBHOOK_ID not configured');
      const ok = await paypal.verifyWebhook(req.headers, event);
      if (!ok) throw httpError(400, 'Webhook signature verification failed');
    }
    res.json(applyWebhookEvent(event));
  });

  // ---- mock-mode helpers ----
  api.post('/mock/pay/:paypalId', (req, res) => {
    if (!isMock()) throw httpError(400, 'Only available in mock mode');
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
      console.log(`  PayPal: ${config.paypal.mode}${isMock() ? ' (demo mode - connect PayPal in Settings for real invoices)' : ''}`);
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
