// PayPilot HTTP server - zero dependencies (Node >= 20.12).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, isoDate } from './src/config.js';
import { db, resetDb } from './src/db.js';
import { chat, resetSession } from './src/agent.js';
import { listActions, approveAction, rejectAction } from './src/actions.js';
import { earningsSummary, forecastCashflow, chartSeries, clientStats, clientName, isOverdue } from './src/analytics.js';
import { syncInvoices, applyWebhookEvent } from './src/sync.js';
import { scanFollowups } from './src/followups.js';
import { paypal, isMock } from './src/paypal.js';
import { llmAvailable } from './src/llm.js';
import { seedDemo } from './src/seed.js';

const PUBLIC = path.join(config.root, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const MAX_BODY = 12 * 1024 * 1024; // screenshots as base64

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function json(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function invoiceRow(i, today) {
  return {
    ...i,
    client: clientName(i.clientId),
    displayStatus: isOverdue(i, today) ? 'OVERDUE' : i.status,
  };
}

function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(p)) p += '.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const routes = [
  ['GET', /^\/api\/config$/, () => ({
    businessName: config.businessName,
    currency: config.currency,
    paypalMode: config.paypal.mode,
    llmProvider: llmAvailable() ? config.llm.provider : 'none',
    today: isoDate(),
    demoTimeOffsetDays: config.demoTimeOffsetDays,
    webhookConfigured: Boolean(config.paypal.webhookId),
  })],

  ['POST', /^\/api\/chat$/, async (req) => {
    const body = await json(req);
    if (!llmAvailable()) throw Object.assign(new Error('No AI provider configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env and restart.'), { status: 503 });
    const sessionId = String(body.sessionId || 'default').slice(0, 64);
    let image = null;
    if (body.image?.data) {
      const mediaType = String(body.image.mediaType || '');
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mediaType)) throw Object.assign(new Error('Unsupported image type'), { status: 400 });
      image = { mediaType, data: String(body.image.data).replace(/^data:[^,]+,/, '') };
    }
    if (!body.message?.trim() && !image) throw Object.assign(new Error('Empty message'), { status: 400 });
    return chat(sessionId, { text: body.message, image });
  }],

  ['POST', /^\/api\/chat\/reset$/, async (req) => {
    const body = await json(req);
    resetSession(String(body.sessionId || 'default'));
    return { ok: true };
  }],

  ['GET', /^\/api\/actions$/, (req, m, url) => ({
    actions: listActions({
      status: url.searchParams.get('status') || undefined,
      origin: url.searchParams.get('origin') || undefined,
      type: url.searchParams.get('type') || undefined,
    }).slice(0, 100),
  })],
  ['POST', /^\/api\/actions\/([\w-]+)\/approve$/, async (req, m) => {
    const body = await json(req);
    return { action: await approveAction(m[1], body.edits) };
  }],
  ['POST', /^\/api\/actions\/([\w-]+)\/reject$/, (req, m) => ({ action: rejectAction(m[1]) })],

  ['GET', /^\/api\/invoices$/, () => {
    const today = isoDate();
    return { invoices: db().invoices.map((i) => invoiceRow(i, today)) };
  }],
  ['POST', /^\/api\/sync$/, () => syncInvoices()],

  ['GET', /^\/api\/dashboard$/, () => {
    const today = isoDate();
    return {
      today,
      summary: earningsSummary({}, today),
      forecast: forecastCashflow(30, today),
      chart: chartSeries(today),
      activity: db().activity.slice(0, 15),
      pendingApprovals: listActions({ status: 'pending' }).length,
    };
  }],

  ['GET', /^\/api\/clients$/, () => {
    const today = isoDate();
    return {
      clients: db()
        .clients.map((c) => ({ ...c, ...clientStats(c.id, today) }))
        .sort((a, b) => b.riskScore - a.riskScore),
    };
  }],

  ['POST', /^\/api\/followups\/scan$/, async () => ({ created: await scanFollowups() })],
  // For a scheduled job (e.g. Render Cron): GET /api/cron/followups?key=CRON_SECRET
  ['GET', /^\/api\/cron\/followups$/, async (req, m, url) => {
    if (!config.cronSecret || url.searchParams.get('key') !== config.cronSecret) throw Object.assign(new Error('Forbidden'), { status: 403 });
    const created = await scanFollowups();
    return { created: created.length };
  }],

  ['POST', /^\/api\/webhooks\/paypal$/, async (req) => {
    const event = await json(req);
    if (!isMock) {
      if (!config.paypal.webhookId) throw Object.assign(new Error('PAYPAL_WEBHOOK_ID not configured'), { status: 503 });
      const ok = await paypal.verifyWebhook(req.headers, event);
      if (!ok) throw Object.assign(new Error('Webhook signature verification failed'), { status: 400 });
    }
    return applyWebhookEvent(event);
  }],

  // ---- mock mode helpers ----
  ['POST', /^\/api\/mock\/pay\/([\w-]+)$/, (req, m) => {
    if (!isMock) throw Object.assign(new Error('Only available in mock mode'), { status: 400 });
    paypal.simulatePayment(m[1]);
    // deliver it the same way PayPal would: as a webhook event
    return applyWebhookEvent({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: m[1], status: 'PAID' } } });
  }],
  ['GET', /^\/api\/mock\/invoice\/([\w-]+)$/, (req, m) => {
    const inv = db().invoices.find((i) => i.paypalId === m[1]);
    if (!inv) throw Object.assign(new Error('Not found'), { status: 404 });
    return { invoice: invoiceRow(inv, isoDate()), businessName: config.businessName };
  }],

  ['POST', /^\/api\/demo\/seed$/, () => {
    if (db().invoices.some((i) => i.source === 'seed')) return { ok: true, already: true };
    seedDemo();
    return { ok: true };
  }],
  ['POST', /^\/api\/demo\/reset$/, () => {
    resetDb();
    return { ok: true };
  }],
];

export function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, url.pathname);
  }
  for (const [method, re, fn] of routes) {
    const m = url.pathname.match(re);
    if (m && req.method === method) {
      return Promise.resolve()
        .then(() => fn(req, m, url))
        .then((data) => send(res, 200, data))
        .catch((e) => {
          const status = e.status || 500;
          if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, e.message);
          send(res, status, { error: e.message });
        });
    }
  }
  send(res, 404, { error: 'Not found' });
}

export function start(port = config.port) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(config.root, 'server.js')) {
  start().then(() => {
    console.log(`\n  PayPilot running → http://localhost:${config.port}`);
    console.log(`  PayPal: ${config.paypal.mode}${isMock ? ' (offline simulation - add PayPal sandbox keys to .env for real invoices)' : ''}`);
    console.log(`  AI:     ${llmAvailable() ? config.llm.provider : 'NOT CONFIGURED - set ANTHROPIC_API_KEY or OPENAI_API_KEY'}\n`);
  });
}
