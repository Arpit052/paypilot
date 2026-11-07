// PayPilot API + web server (Express 5).
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config, isoDate, addDays, addMonths, envFile, daysBetween } from './src/config.js';
import { listInvoices, listClients, listActivity, getInvoiceByPaypalId, resetDb, listSchedules, getSchedule, updateSchedule, deleteSchedule, getClient, logActivity } from './src/db.js';
import { chatWithTranscript, getTranscript, resetSession } from './src/agent.js';
import { listActions, approveAction, rejectAction, normaliseInvoiceDraft, dropStaleActions, markPaid } from './src/actions.js';
import { earningsSummary, forecastCashflow, chartSeries, clientStats, clientName, isOverdue } from './src/analytics.js';
import { syncInvoices, applyWebhookEvent, importFromPaypal, syncState } from './src/sync.js';
import { scanFollowups, composeReminder } from './src/followups.js';
import { collections, draftFor } from './src/collections.js';
import { noteDueDates } from './src/alerts.js';
import { calendarMonth } from './src/calendar.js';
import { analytics } from './src/insights.js';
import { runAutopilot, saveAutopilotSettings, autopilotSettings, comingUp } from './src/autopilot.js';
import { paypal, isMock } from './src/paypal.js';
import { llmAvailable } from './src/llm.js';
import { seedDemo } from './src/seed.js';
import { seedSample, sampleInfo, removeSample } from './src/sample.js';
import { runRecurring } from './src/recurring.js';
import { moneyBrief } from './src/brief.js';
import { startScheduler, runJobs, lastRun } from './src/scheduler.js';
import { invoiceTotals, topCustomers, paymentsInMonth, invoicesCsv } from './src/analytics.js';
import { createAction } from './src/actions.js';
import { eventStream } from './src/notify.js';
import { listNotifications, unreadNotificationCount, markNotificationsRead, deleteInvoice, deleteClient, kvGet, kvSet, kvDel } from './src/db.js';
import { applySettings, setupDone, publicSettings, connectPaypal, useDemoMode, disconnectPaypal, saveBusinessSettings } from './src/settings.js';
import { verifyCredentials } from './src/paypal.js';
import { isOpen } from './src/analytics.js';
import { estimateBudget, budgetProfile, expectedPayments, forecastFromModel, receivedSinceSaved } from './src/budget.js';
import { retainerOffers, draftOffer, markOffered, dismissOffer, acceptPayload, markAccepted } from './src/offers.js';
import { taxReport, taxCsv, taxYears } from './src/tax.js';
import { getDelivery, attachDelivery, removeDelivery, deliveryView, noteOrigin, isLocalBase } from './src/delivery.js';
import { getEarlyPay, suggestEarlyPay, settleEarlyPay } from './src/earlypay.js';
import { growthReport, growthReportLive, growthPlan, INDUSTRIES } from './src/growth.js';
import { markIndustryByOwner } from './src/labels.js';
import { setClientIndustry } from './src/db.js';
import { receiptPathFor, listReceipts, markReceiptSent, receiptView, documentFor, ensureReceipt } from './src/receipts.js';
import { businessTypeList, typeOf, BUSINESS_TYPES, normalType, professionLabel } from './src/business.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const startedAt = Date.now();

// ---------- passcode login (optional, APP_PASSWORD) ----------
const SESSION_COOKIE = 'pp_session';
// Passcode: from APP_PASSWORD in .env, or set by the user in the app (stored as a scrypt hash).
const security = () => kvGet('settings:security') || null;
const loginEnabled = () => Boolean(config.appPassword || security()?.hash);
const sessionToken = () => {
  const key = config.appPassword || security()?.secret || 'none';
  return crypto.createHmac('sha256', key).update(`paypilot-session-v1:${security()?.updatedAt || ''}`).digest('hex');
};
function checkPasscode(pw) {
  if (config.appPassword) return safeEqual(String(pw || ''), config.appPassword);
  const s = security();
  if (!s?.hash) return true;
  const h = crypto.scryptSync(String(pw || ''), Buffer.from(s.salt, 'hex'), 32).toString('hex');
  return safeEqual(h, s.hash);
}
function setPasscode(pw) {
  const salt = crypto.randomBytes(16);
  kvSet('settings:security', { salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 32).toString('hex'), secret: crypto.randomBytes(32).toString('hex'), updatedAt: new Date().toISOString() });
}
const sessionCookie = (req) => `${SESSION_COOKIE}=${sessionToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}${req.secure ? '; Secure' : ''}`;

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
const PUBLIC_PATHS = [/^\/$/, /^\/landing\.(css|js)$/, /^\/landing\//, /^\/app$/, /^\/r\/[A-Za-z0-9_-]+$/, /^\/api\/r\/[A-Za-z0-9_-]+$/, /^\/d\/[A-Za-z0-9_-]+$/, /^\/api\/d\/[A-Za-z0-9_-]+$/, /^\/login(\.html)?$/, /^\/app\.css$/, /^\/common\.js$/, /^\/favicon\.svg$/, /^\/fonts\//, /^\/api\/login$/, /^\/api\/health$/, /^\/api\/webhooks\//, /^\/api\/cron\//];

function requireLogin(req, res, next) {
  if (!loginEnabled() || PUBLIC_PATHS.some((re) => re.test(req.path))) return next();
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
const WELCOME_FREE = /^\/((welcome|login|mock-pay)(\.html)?|d\/[A-Za-z0-9_-]+|r\/[A-Za-z0-9_-]+|app)?$/;
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

function invoiceRow(i, today, expected) {
  return {
    ...i,
    client: clientName(i.clientId),
    clientEmail: getClient(i.clientId)?.email || '',
    displayStatus: isOverdue(i, today) ? 'OVERDUE' : i.status,
    // paid: how many days after the due date (negative = early); unpaid: when it's likely to arrive
    paidLateDays: i.paidDate ? daysBetween(i.dueDate, i.paidDate) : null,
    delivery: getDelivery(i.id),
    earlyPay: getEarlyPay(i.id),
    expected: (({ within, ...e }) => e)(expected?.get(i.id) || {}),
  };
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
  // request id + timing: every response carries X-Request-Id, slow or failed API calls are logged
  app.use((req, res, next) => {
    const id = String(req.get('x-request-id') || crypto.randomBytes(6).toString('hex')).slice(0, 64);
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      if (!req.path.startsWith('/api/') || req.path === '/api/events') return;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (res.statusCode >= 500 || ms > 1500 || process.env.LOG_REQUESTS) console.log(`  [${id}] ${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms`);
    });
    next();
  });
  app.use(express.json({ limit: '12mb' })); // screenshots arrive as base64
  app.use((req, res, next) => {
    noteOrigin(`${req.protocol}://${req.get('host')}`);
    next();
  });
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
    if (!loginEnabled()) return res.json({ ok: true });
    if (!checkPasscode(req.body?.password)) throw httpError(401, 'That passcode is not right.');
    res.set('Set-Cookie', sessionCookie(req));
    res.json({ ok: true });
  });
  api.post('/logout', (req, res) => {
    res.set('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
  // No passcode: "sign out" means leaving this PayPal account and going back to the start
  // screen (for example to let someone else connect theirs). Invoices and settings stay.
  api.post('/session/end', (req, res) => {
    if (loginEnabled()) throw httpError(400, 'Use sign out: this PayPilot has a passcode.');
    kvDel('settings:paypal'); // the PayPal keys are forgotten too
    applySettings();
    logActivity('session_end', 'Signed out: PayPal disconnected, back to the start screen');
    res.json({ ok: true, welcome: !setupDone() });
  });

  api.get('/config', (req, res) =>
    res.json({
      businessName: config.businessName,
      accountType: config.accountType || 'freelancer',
      currency: config.currency,
      paypalMode: config.paypal.mode,
      llmProvider: llmAvailable() ? config.llm.provider : 'none',
      llmLabel: aiLabel(),
      today: isoDate(),
      demoTimeOffsetDays: config.demoTimeOffsetDays,
      webhookConfigured: Boolean(config.paypal.webhookId),
      timezone: config.timezone,
      defaultTaxPercent: config.defaultTaxPercent,
      defaultTermsDays: config.defaultTermsDays ?? 7,
      defaultNote: config.defaultNote || '',
      ownerName: config.ownerName || '',
      loginEnabled: loginEnabled(),
      passcodeFromEnv: Boolean(config.appPassword),
      paypalSource: publicSettings().paypal.source,
      autopilot: (() => {
        const ap = autopilotSettings();
        const next = ap.enabled ? comingUp(30).find((x) => x.state !== 'waiting') || null : null;
        return { enabled: ap.enabled, next: next && { label: next.label, client: next.client, date: next.date } };
      })(),
      lateFeePercent: config.lateFeePercent,
      lateFeeAfterDays: config.lateFeeAfterDays,
      businessType: normalType(config.businessType),
      businessTypeLabel: professionLabel(config.businessType, config.businessTypeOther),
      typeItems: typeOf(config.businessType).items.map(([name, price]) => ({ name, price })),
      retainerWord: typeOf(config.businessType).retainer,
      demoPersona: kvGet('demo:persona') || null,
    })
  );
  api.get('/business-types', (req, res) => res.json({ types: businessTypeList(), current: normalType(config.businessType), other: config.businessTypeOther || '' }));

  // ---- settings: PayPal connection + business details ----
  api.get('/settings', (req, res) => res.json(publicSettings()));
  api.post('/settings/paypal/connect', rateLimit({ perMinute: 6, message: 'Too many attempts. Please wait a minute.' }), async (req, res) => {
    const clientId = String(req.body?.clientId || '').trim();
    const clientSecret = String(req.body?.clientSecret || '').trim();
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(clientId)) throw httpError(400, 'That Client ID looks incomplete. Copy it again from developer.paypal.com.');
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(clientSecret)) throw httpError(400, 'That Secret looks incomplete. Click "Show" next to Secret on developer.paypal.com and copy it again.');
    const bizName = String(req.body?.businessName || '').trim();
    if (!bizName && !config.businessName) throw httpError(400, 'Add your business name first. It appears on your invoices.');
    const check = await verifyCredentials(clientId, clientSecret);
    if (!check.ok) throw httpError(400, check.error);
    connectPaypal({ clientId, clientSecret });
    if (bizName) saveBusinessSettings({ businessName: bizName });
    if (BUSINESS_TYPES[req.body?.businessType]) saveBusinessSettings({ businessType: req.body.businessType, businessTypeOther: req.body.businessTypeOther || '', applyPreset: true, ...(['freelancer', 'business'].includes(req.body?.accountType) ? { accountType: req.body.accountType, teamSize: req.body.teamSize || '' } : {}) });
    if (!config.appPassword && !security()?.hash && String(req.body?.passcode || '').length >= 4) {
      setPasscode(String(req.body.passcode));
      res.set('Set-Cookie', sessionCookie(req));
    }
    // demo invoices that were never on PayPal can't be chased on the real account
    let removed = 0;
    for (const inv of listInvoices()) {
      if (String(inv.paypalId || '').startsWith('INV2-MOCK-') && isOpen(inv)) {
        deleteInvoice(inv.id);
        removed++;
      }
    }
    dropStaleActions();
    const imp = await importFromPaypal().catch(() => ({ imported: 0 }));
    // a real account starts empty: demo data from before is wiped, unless the owner asks for
    // a few sample invoices to try things (tracked, so they can be removed later)
    if (req.body?.sampleHistory === true) {
      if (!sampleInfo().count) seedSample();
    } else if (sampleInfo().count || listInvoices().some((i) => i.source === 'seed')) {
      removeSample();
    }
    noteDueDates();
    logActivity('paypal_connected', 'Connected to PayPal sandbox');
    res.json({ ok: true, removedDemoInvoices: removed, imported: imp.imported, settings: publicSettings() });
  });
  api.post('/settings/paypal/demo', (req, res) => {
    const bizName = String(req.body?.businessName || '').trim();
    if (bizName) saveBusinessSettings({ businessName: bizName });
    if (BUSINESS_TYPES[req.body?.businessType]) saveBusinessSettings({ businessType: req.body.businessType, businessTypeOther: req.body.businessTypeOther || '', applyPreset: true, ...(['freelancer', 'business'].includes(req.body?.accountType) ? { accountType: req.body.accountType, teamSize: req.body.teamSize || '' } : {}) });
    if (!config.appPassword && !security()?.hash && String(req.body?.passcode || '').length >= 4) {
      setPasscode(String(req.body.passcode));
      res.set('Set-Cookie', sessionCookie(req));
    }
    useDemoMode();
    if (!listInvoices().length) seedSample();
    noteDueDates();
    res.json({ ok: true, settings: publicSettings() });
  });
  api.post('/settings/paypal/disconnect', (req, res) => {
    disconnectPaypal();
    logActivity('paypal_disconnected', 'Disconnected PayPal - now in demo mode');
    res.json({ ok: true, settings: publicSettings() });
  });
  // passcode set/change/remove (when it isn't fixed by APP_PASSWORD in .env)
  api.post('/settings/passcode', rateLimit({ perMinute: 8, message: 'Too many attempts. Please wait a minute.' }), (req, res) => {
    if (config.appPassword) throw httpError(400, 'The passcode is set by APP_PASSWORD in the .env file.');
    const { current, passcode, remove } = req.body || {};
    if (security()?.hash && !checkPasscode(current)) throw httpError(401, 'Your current passcode is not right.');
    if (remove) {
      kvSet('settings:security', null);
      res.set('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return res.json({ ok: true, loginEnabled: false });
    }
    if (String(passcode || '').length < 4) throw httpError(400, 'Use at least 4 characters.');
    setPasscode(String(passcode));
    res.set('Set-Cookie', sessionCookie(req)); // stay signed in on this device
    res.json({ ok: true, loginEnabled: true });
  });
  api.post('/settings/business', (req, res) => res.json({ business: saveBusinessSettings(req.body || {}) }));
  // try the current writing style on a real open invoice (nothing is saved or sent)
  api.post('/settings/preview-reminder', async (req, res) => {
    const today = isoDate();
    const open = listInvoices().filter((i) => isOpen(i)).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
    const inv = open[0];
    if (!inv) throw httpError(400, 'Send an invoice first. The preview uses one of your unpaid invoices.');
    const tone = ['friendly', 'firm', 'final'].includes(req.body?.tone) ? req.body.tone : null;
    const r = await composeReminder(inv, today, tone);
    res.json({ number: inv.number, client: getClient(inv.clientId)?.name || '', tone: r.tone, draftedBy: r.draftedBy, ...r.draft });
  });
  api.post('/settings/hidden/clear', (req, res) => {
    const n = (kvGet('hidden:emails') || []).length;
    kvSet('hidden:emails', []);
    res.json({ restored: n });
  });
  api.get('/export.json', (req, res) => {
    res.set('Content-Disposition', `attachment; filename="paypilot-backup-${isoDate()}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      app: 'PayPilot',
      settings: { ...publicSettings(), autopilot: autopilotSettings() },
      clients: listClients(),
      invoices: listInvoices(),
      schedules: listSchedules(),
      actions: listActions({}).slice(0, 1000),
      activity: listActivity(500),
    });
  });

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
    if (getTranscript(sessionId).pending) throw httpError(409, "I'm still working on your last message. One moment.");
    res.json(await chatWithTranscript(sessionId, { text: body.message, image }));
  });
  // The Assistant page reloads its conversation from here (tab switches, refreshes).
  api.get('/chat/history', (req, res) => {
    const t = getTranscript(String(req.query.sessionId || 'default').slice(0, 64));
    res.json({ messages: t.messages, pending: Boolean(t.pending) });
  });
  api.post('/chat/reset', (req, res) => {
    resetSession(String(req.body?.sessionId || 'default'));
    res.json({ ok: true });
  });

  // ---- approvals ----
  api.get('/actions', (req, res) => {
    dropStaleActions();
    const { status, origin, type } = req.query;
    res.json({ actions: listActions({ status, origin, type }).slice(0, 100) });
  });
  api.post('/actions/:id/approve', async (req, res) => res.json({ action: await approveAction(req.params.id, req.body?.edits) }));
  api.post('/actions/:id/reject', (req, res) => res.json({ action: rejectAction(req.params.id) }));

  // ---- invoices / dashboard / clients ----
  api.get('/invoices', (req, res) => {
    const today = isoDate();
    const all = listInvoices();
    const expected = expectedPayments(all, today);
    res.json({ invoices: all.map((i) => invoiceRow(i, today, expected)) });
  });
  api.post('/sync', async (req, res) => {
    const imp = await importFromPaypal().catch((e) => ({ imported: 0, errors: [e.message] }));
    const r = await syncInvoices({ all: true });
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
      earlyPayPercent: b.earlyPayPercent,
      deliveryUrl: b.deliveryUrl,
      reference: b.reference,
      note: b.note,
    });
    const a = createAction('create_invoice', draft, { origin: 'form', summary: `Invoice ${draft.clientName} · ${draft.currency} ${draft.total}` });
    if (!b.sendNow) return res.json({ action: a, sent: false });
    res.json({ action: await approveAction(a.id), sent: true });
  });
  api.post('/invoices/:id/mark-paid', async (req, res) => {
    try {
      res.json(await markPaid(req.params.id, req.body || {}));
    } catch (e) {
      throw Object.assign(e, { status: e.status || 502 });
    }
  });
  api.get('/dashboard', (req, res) => {
    const today = isoDate();
    res.json({
      today,
      summary: earningsSummary({}, today),
      forecast: forecastFromModel(30, today),
      chart: chartSeries(today),
      activity: listActivity(15),
      pendingApprovals: listActions({ status: 'pending' }).length,
      sync: { live: !isMock(), lastAt: syncState.lastAt, everySeconds: Number(process.env.PAYPAL_SYNC_SECONDS ?? 120) },
    });
  });
  api.get('/clients', (req, res) => {
    const today = isoDate();
    const scheduled = new Set(listSchedules().map((s) => s.clientId));
    // only people you've actually billed (cancelled-only test entries are left out)
    const billed = new Set(listInvoices().filter((i) => i.status !== 'CANCELLED').map((i) => i.clientId));
    res.json({
      clients: listClients()
        .filter((c) => billed.has(c.id) || scheduled.has(c.id))
        .map((c) => ({ ...c, ...clientStats(c.id, today) }))
        .sort((a, b) => b.riskScore - a.riskScore),
    });
  });

  // Remove from PayPilot only. Their invoices stay on PayPal and won't be imported again.
  api.delete('/clients/:id', (req, res) => {
    const c = getClient(req.params.id);
    if (!c) throw httpError(404, 'Client not found');
    const hidden = new Set(kvGet('hidden:emails') || []);
    hidden.add(c.email.toLowerCase());
    kvSet('hidden:emails', [...hidden]);
    deleteClient(c.id);
    dropStaleActions();
    logActivity('client_removed', `Removed ${c.name} from PayPilot`);
    res.json({ ok: true });
  });

  // ---- notifications (live via Server-Sent Events) ----
  api.get('/events', eventStream);
  api.get('/notifications', (req, res) => {
    const today = isoDate();
    const weekAgo = addDays(today, -6);
    const paidWeek = {};
    for (const i of listInvoices()) if (['PAID', 'MARKED_AS_PAID'].includes(i.status) && i.paidDate >= weekAgo && i.paidDate <= today) paidWeek[i.currency] = Math.round(((paidWeek[i.currency] || 0) + i.total) * 100) / 100;
    const open = listInvoices().filter((i) => isOpen(i));
    res.json({
      unread: unreadNotificationCount(),
      notifications: listNotifications(40),
      summary: { paidThisWeek: paidWeek, waiting: listActions({ status: 'pending' }).length, overdue: open.filter((i) => isOverdue(i, today)).length },
    });
  });
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
      schedules: listSchedules().map((sc) => {
        const total = invoiceTotals(sc.items, sc.taxPercent).total;
        const made = listActions({ type: 'create_invoice' }).filter((a) => a.payload?.scheduleId === sc.id);
        const sent = made.filter((a) => a.status === 'approved');
        const c = getClient(sc.clientId);
        const upcoming = [];
        for (let d = sc.nextRun, n = 0; n < 3 && d; n++) {
          upcoming.push(d);
          d = sc.frequency === 'weekly' ? addDays(d, 7) : addMonths(d, 1);
        }
        return {
          ...sc,
          client: c?.name || 'Unknown',
          company: c?.company || '',
          email: c?.email || '',
          total,
          perYear: Math.round(total * (sc.frequency === 'weekly' ? 52 : 12) * 100) / 100,
          invoicesSent: sent.length,
          billedSoFar: Math.round(sent.reduce((t, a) => t + (a.payload?.total || 0), 0) * 100) / 100,
          draftWaiting: made.some((a) => a.status === 'pending'),
          upcoming,
        };
      }),
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
  // Collections board
  api.get('/collections', (req, res) => {
    dropStaleActions();
    res.json(collections());
  });
  api.get('/analytics', (req, res) => res.json(analytics({ months: req.query.months })));
  api.get('/growth', async (req, res) => res.json({ ...(req.query.fast ? growthReport() : await growthReportLive()), industryOptions: INDUSTRIES, accountType: config.accountType || 'freelancer' }));
  api.post('/growth/plan', async (req, res) => res.json(await growthPlan({ refresh: !!req.body?.refresh })));
  api.post('/clients/:id/industry', (req, res) => {
    if (!getClient(req.params.id)) return res.status(404).json({ error: 'Client not found' });
    const industry = String(req.body?.industry || '').trim().slice(0, 60);
    markIndustryByOwner(req.params.id);
    res.json({ client: setClientIndustry(req.params.id, industry) });
  });
  api.get('/calendar', (req, res) => res.json(calendarMonth(String(req.query.month || ''))));
  api.get('/autopilot', (req, res) => res.json({ autopilot: autopilotSettings(), lateFeePercent: config.lateFeePercent }));
  api.post('/autopilot', (req, res) => res.json({ autopilot: saveAutopilotSettings(req.body || {}) }));
  api.post('/autopilot/run', async (req, res) => res.json({ created: await runAutopilot() }));
  api.post('/followups/draft', async (req, res) => {
    const kind = req.body?.kind === 'late_fee' ? 'late_fee' : 'reminder';
    res.json({ action: await draftFor(String(req.body?.invoiceId || ''), kind) });
  });
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
      syncState.lastWebhookAt = Date.now();
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
    const ep = getEarlyPay(inv.id);
    res.json({ invoice: invoiceRow(inv, isoDate()), businessName: config.businessName, receipt: receiptPathFor(inv), earlyPay: ep && ep.status === 'active' ? ep : null, delivery: getDelivery(inv.id) ? { link: getDelivery(inv.id).link } : null });
  });

  // ---- demo data ----
  api.get('/sample', (req, res) => res.json(sampleInfo()));
  api.post('/sample/remove', (req, res) => res.json(removeSample()));
  api.post('/demo/seed', (req, res) => {
    if (sampleInfo().count || listInvoices().some((i) => i.source === 'seed')) return res.json({ ok: true, already: true });
    seedSample();
    res.json({ ok: true });
  });
  api.post('/demo/reset', (req, res) => {
    resetDb();
    res.json({ ok: true });
  });

  // ---- pay to unlock ----
  api.post('/invoices/:id/delivery', (req, res) => {
    const inv = listInvoices().find((i) => i.id === req.params.id);
    if (!inv) throw httpError(404, 'Invoice not found');
    if (inv.status === 'CANCELLED') throw httpError(400, 'This invoice is cancelled');
    res.json({ delivery: attachDelivery(inv.id, { url: req.body?.url, label: req.body?.label }), local: isLocalBase() });
  });
  api.delete('/invoices/:id/delivery', (req, res) => {
    removeDelivery(req.params.id);
    res.json({ ok: true });
  });
  // public, token-protected: what the client's unlock page polls
  api.get('/d/:token', (req, res) => {
    const v = deliveryView(req.params.token);
    if (!v) throw httpError(404, 'This link is not valid any more');
    res.json(v);
  });

  // ---- receipts ----
  api.get('/receipts', (req, res) => res.json(listReceipts({ year: req.query.year })));
  api.post('/receipts/:invoiceId/sent', (req, res) => res.json({ receipt: markReceiptSent(req.params.invoiceId, req.body?.via) }));
  // public, token-protected receipt page data
  api.get('/r/:token', (req, res) => {
    const v = receiptView(req.params.token, { owner: req.query.preview === '1' });
    if (!v) throw httpError(404, 'This receipt link is not valid');
    res.json(v);
  });

  // ---- how the client sees an invoice: email, payment page, receipt, files ----
  api.get('/invoices/:id/client-view', (req, res) => {
    const inv = listInvoices().find((i) => i.id === req.params.id);
    if (!inv) throw httpError(404, 'Invoice not found');
    const c = getClient(inv.clientId);
    const rec = ensureReceipt(inv);
    res.json({
      document: documentFor(inv, rec?.number),
      status: inv.status,
      payerUrl: inv.payerUrl,
      demo: isMock(),
      email: {
        from: `${config.businessName || 'Your business'} via PayPal`,
        to: c?.email || '',
        subject: `${config.businessName || 'Your business'} sent you an invoice: #${inv.number}`,
      },
      receiptLink: rec ? `/r/${rec.token}?preview=1` : null,
      delivery: getDelivery(inv.id),
      earlyPay: getEarlyPay(inv.id),
    });
  });

  // ---- early-pay discount ----
  api.get('/earlypay/suggest', (req, res) => {
    const c = req.query.email ? listClients().find((x) => x.email.toLowerCase() === String(req.query.email).toLowerCase()) : null;
    res.json({ ...suggestEarlyPay(c?.id, Number(req.query.total) || 0), hours: 48 });
  });
  api.post('/earlypay/settle', async (req, res) => res.json({ settled: await settleEarlyPay() }));

  // ---- tax summary ----
  api.get('/tax', (req, res) => res.json({ ...taxReport(req.query.year || isoDate().slice(0, 4)), years: taxYears() }));
  api.get('/tax.csv', (req, res) => {
    const year = Number(req.query.year || isoDate().slice(0, 4));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="paypilot-tax-summary-${year}.csv"`);
    res.send(taxCsv(year));
  });

  // ---- Budget Estimator ----
  api.get('/budget/profile', async (req, res) => {
    let balance = null;
    if (req.query.balance && !isMock()) balance = await paypal.getBalance(config.currency).catch(() => null);
    const upcoming = forecastFromModel(45).invoices.filter((r) => r.currency === config.currency).map((r) => ({ date: r.expectedDate, range: r.range, due: r.dueDate, overdue: r.daysOverdue, habit: r.habit, basedOn: r.basedOn, client: r.client, invoice: r.invoice, amount: r.amount, probability: r.probability }));
    res.json({ profile: budgetProfile(), receivedSince: receivedSinceSaved(), currency: config.currency, paypalBalance: balance, demo: isMock(), upcoming });
  });
  api.post('/budget/estimate', (req, res) => res.json(estimateBudget(req.body || {})));

  // ---- retainer offers ----
  api.get('/offers', (req, res) => res.json({ offers: retainerOffers(), word: typeOf(config.businessType).retainer }));
  api.post('/offers/:clientId/draft', async (req, res) => res.json({ draft: await draftOffer(req.params.clientId, { refresh: Boolean(req.body?.refresh) }) }));
  api.post('/offers/:clientId/offered', (req, res) => {
    markOffered(req.params.clientId);
    logActivity('offer_sent', `Retainer offer sent to ${getClient(req.params.clientId)?.name || 'client'}`);
    res.json({ ok: true });
  });
  api.post('/offers/:clientId/dismiss', (req, res) => {
    dismissOffer(req.params.clientId);
    res.json({ ok: true });
  });
  // the client said yes: create the retainer (each invoice still waits for approval)
  api.post('/offers/:clientId/accept', async (req, res) => {
    const { offer, payload } = acceptPayload(req.params.clientId, req.body || {});
    const a = createAction('create_schedule', payload, { origin: 'offer', summary: `Retainer for ${offer.client}` });
    try {
      const done = await approveAction(a.id);
      markAccepted(req.params.clientId, payload.items[0].unitPrice);
      logActivity('offer_accepted', `${offer.client} accepted a ${offer.offer.word} at ${offer.currency} ${payload.items[0].unitPrice} a month`);
      res.json({ action: done });
    } catch (e) {
      rejectAction(a.id);
      throw e;
    }
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // Dashboard is the home page; the Assistant lives at /assistant
  const page = (f) => (req, res) => res.sendFile(path.join(config.root, 'public', f));
  // public landing page; the app itself lives under /dashboard
  app.get('/', page('landing.html'));
  // "Log in" on the landing page: set up first, then sign in, then the dashboard
  app.get('/app', (req, res) => {
    if (!setupDone()) return res.redirect(302, '/welcome');
    if (loginEnabled() && !safeEqual(readCookie(req, SESSION_COOKIE) || '', sessionToken())) return res.redirect(302, '/login.html');
    res.redirect(302, '/dashboard');
  });
  app.get(['/invoices', '/collections'], page('followups.html'));
  app.get(['/dashboard', '/dashboard.html'], page('dashboard.html'));
  app.get(['/assistant', '/assistant.html'], page('index.html'));
  app.get(['/calendar', '/calendar.html'], page('calendar.html'));
  app.get(['/analytics', '/analytics.html'], page('analytics.html'));
  app.get(['/budget', '/budget.html'], page('budget.html'));
  app.get(['/tax', '/tax.html'], page('tax.html'));
  app.get('/d/:token', page('unlock.html'));
  app.get('/r/:token', page('receipt.html'));
  app.get(['/receipts', '/receipts.html'], page('receipts.html'));
  app.get(['/client-view', '/client-view.html'], page('client-view.html'));
  app.get(['/growth', '/growth.html'], page('growth.html'));
  app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'], index: false }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // one error handler for everything (Express 5 forwards async errors here)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(`  [${req.id || '-'}] ${req.method} ${req.path} ${err.message}`);
    res.status(status).json({ error: status === 400 && err.type === 'entity.parse.failed' ? 'Invalid JSON' : err.message, requestId: req.id });
  });
  return app;
}

export function start(port = config.port) {
  return new Promise((resolve, reject) => {
    const server = createApp().listen(port, config.host, () => resolve(server));
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
