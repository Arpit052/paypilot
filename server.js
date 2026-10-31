// PayPilot API + web server (Express 5).
import path from 'node:path';
import express from 'express';
import { config, isoDate, envFile } from './src/config.js';
import { listInvoices, listClients, listActivity, getInvoiceByPaypalId, resetDb } from './src/db.js';
import { chat, resetSession } from './src/agent.js';
import { listActions, approveAction, rejectAction } from './src/actions.js';
import { earningsSummary, forecastCashflow, chartSeries, clientStats, clientName, isOverdue } from './src/analytics.js';
import { syncInvoices, applyWebhookEvent } from './src/sync.js';
import { scanFollowups } from './src/followups.js';
import { paypal, isMock } from './src/paypal.js';
import { llmAvailable } from './src/llm.js';
import { seedDemo } from './src/seed.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

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
  app.use(express.json({ limit: '12mb' })); // screenshots arrive as base64

  const api = express.Router();

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
    })
  );

  // ---- assistant ----
  api.post('/chat', async (req, res) => {
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
  start()
    .then(() => {
      console.log(`\n  PayPilot running → http://localhost:${config.port}`);
      console.log(envFile ? `  Settings: read from "${envFile}"` : `  Settings: NO .env FILE FOUND in ${config.root}`);
      const keys = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'];
      console.log('  Keys found: ' + (keys.filter((k) => process.env[k]).join(', ') || 'none'));
      console.log(`  PayPal: ${config.paypal.mode}${isMock ? ' (offline simulation - add PayPal sandbox keys to .env for real invoices)' : ''}`);
      console.log(`  AI:     ${llmAvailable() ? aiLabel() : 'NOT CONFIGURED - set GEMINI_API_KEY in .env'}\n`);
    })
    .catch((e) => {
      if (e.code === 'EADDRINUSE') {
        console.log(`\n  Port ${config.port} pe pehle se kuch chal raha hai (shayad purana PayPilot).`);
        console.log('  Saari PayPilot windows band karke dobara chalao.\n');
      } else console.error(e);
      process.exit(1);
    });
}
