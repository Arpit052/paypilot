import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentSpace } from './context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load settings from .env. Tolerant of what Windows Notepad produces:
 * UTF-8 with BOM, UTF-16, a ".env.txt" name, spaces around "=", quotes.
 * Real environment variables always win. Returns the file name used, or null.
 */
function loadEnvFile() {
  for (const name of ['.env', '.env.txt', 'env', 'env.txt', '.env.example.txt']) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const buf = fs.readFileSync(file);
    let text;
    if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
    else if (buf[0] === 0xfe && buf[1] === 0xff) text = Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
    else text = buf.toString('utf8');
    text = text.replace(/^﻿/, '');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
    return name;
  }
  return null;
}

export const envFile = loadEnvFile();

const env = process.env;

// Convenience: a Gemini key (starts with "AIza") pasted into OPENAI_API_KEY or
// GEMINI_API_KEY works even if the base URL / model lines were left out.
if (!env.OPENAI_API_KEY && env.GEMINI_API_KEY) env.OPENAI_API_KEY = env.GEMINI_API_KEY;
if (/^(AIza|AQ\.)/.test(env.OPENAI_API_KEY || '')) {
  env.OPENAI_BASE_URL ||= 'https://generativelanguage.googleapis.com/v1beta/openai';
  env.OPENAI_MODEL ||= 'gemini-3.6-flash';
}

// Google AI Studio keys: classic "AIza..." and the newer "AQ." format
export const isGoogleKey = (k) => /^(AIza|AQ\.)/.test(k || '');

function detectLlmProvider() {
  if (env.LLM_PROVIDER) return env.LLM_PROVIDER.toLowerCase();
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.GEMINI_API_KEY || isGoogleKey(env.OPENAI_API_KEY) || (env.OPENAI_BASE_URL || '').includes('generativelanguage.googleapis.com')) return 'gemini';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

function detectPaypalMode() {
  const m = (env.PAYPAL_MODE || '').toLowerCase();
  if (m === 'mock' || m === 'sandbox' || m === 'live') return m;
  return env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET ? 'sandbox' : 'mock';
}

function validTimeZone(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    console.warn(`  APP_TIMEZONE "${tz}" is not a valid time zone - ignoring it.`);
    return null;
  }
}

const baseConfig = {
  root: ROOT,
  port: Number(env.PORT || 3000),
  // Only this computer can open the app, unless HOST says otherwise. Hosting platforms
  // (Render sets RENDER=true) need 0.0.0.0 so visitors can reach it.
  // Render sets RENDER, Azure App Service sets WEBSITE_SITE_NAME.
  host: env.HOST || (env.RENDER || env.WEBSITE_SITE_NAME ? '0.0.0.0' : '127.0.0.1'),
  // On Azure App Service only /home survives restarts and redeploys
  dataDir: env.DATA_DIR || (env.WEBSITE_SITE_NAME ? '/home/data' : path.join(ROOT, 'data')),

  businessName: env.BUSINESS_NAME || '', // set on the welcome screen or in Settings
  currency: (env.DEFAULT_CURRENCY || 'USD').toUpperCase(),
  // Currencies PayPal accepts on invoices (INR, for example, is not one of them).
  paypalCurrencies: ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'ILS', 'MXN', 'BRL', 'SGD', 'HKD', 'TWD', 'THB', 'PHP', 'MYR', 'CNY'],
  // Shift the app's clock forward for demos ("what happens in 10 days?").
  demoTimeOffsetDays: Number(env.DEMO_TIME_OFFSET_DAYS || 0),
  // a shared public copy: nobody can disconnect PayPal or wipe data for everyone
  hostedDemo: /^(1|true|yes)$/i.test(env.HOSTED_DEMO || ''),
  seedSampleOnBoot: /^(1|true|yes)$/i.test(env.SEED_SAMPLE_ON_BOOT || ''),
  reminderCooldownDays: Number(env.REMINDER_COOLDOWN_DAYS || 3),
  cronSecret: env.CRON_SECRET || '',
  defaultTaxPercent: Number(env.DEFAULT_TAX_PERCENT || 0),
  // Late-fee policy: suggest a fee of lateFeePercent once an invoice is lateFeeAfterDays overdue (0% = off).
  lateFeePercent: env.LATE_FEE_PERCENT === undefined ? 5 : Number(env.LATE_FEE_PERCENT),
  lateFeeAfterDays: Number(env.LATE_FEE_AFTER_DAYS || 7),
  // Business-day calendar: dates ("today", due dates) are computed in this time zone.
  timezone: validTimeZone(env.APP_TIMEZONE) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  // Optional passcode for the web app (recommended when the demo is hosted publicly).
  appPassword: env.APP_PASSWORD || '',
  // Background jobs (PayPal sync, overdue scan, recurring invoices). 0 = off.
  schedulerMinutes: env.SCHEDULER_INTERVAL_MIN === undefined ? 360 : Number(env.SCHEDULER_INTERVAL_MIN),
  chatRateLimitPerMin: Number(env.CHAT_RATE_LIMIT_PER_MIN || 15),

  paypal: {
    mode: detectPaypalMode(),
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
  },

  llm: {
    provider: detectLlmProvider(),
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    openaiKey: env.OPENAI_API_KEY || '',
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
    geminiKey: env.GEMINI_API_KEY || env.OPENAI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || (env.OPENAI_MODEL?.startsWith('gemini') ? env.OPENAI_MODEL : 'gemini-3.6-flash'),
    // tried in order when the primary model is rate-limited or overloaded (each has its own quota)
    geminiFallbacks: (env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    // thinking level: low | medium | high | off (= let the model decide)
    geminiThinking: (env.GEMINI_REASONING || 'low').toLowerCase(),
  },
};

baseConfig.paypal.baseUrl =
  baseConfig.paypal.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

/**
 * The live settings. Inside a visitor workspace (hosted demo), anything the app changes at run
 * time (business name, PayPal keys, preferences) is kept on that workspace, never on the shared
 * object, so one visitor's settings and keys can't be seen by another.
 */
export const config = new Proxy(baseConfig, {
  get(t, k) {
    const s = currentSpace();
    if (!s) return t[k];
    if (Object.hasOwn(s.cfg, k)) return s.cfg[k];
    // each workspace starts in demo mode with no keys, whatever the server's own .env says
    if (k === 'paypal') return (s.cfg.paypal = { ...t.paypal, mode: 'mock', clientId: '', clientSecret: '', webhookId: '' });
    if (k === 'notify') return (s.cfg.notify = { ...t.notify });
    return t[k];
  },
  set(t, k, v) {
    const s = currentSpace();
    if (s) s.cfg[k] = v;
    else t[k] = v;
    return true;
  },
});

/** "Today" for the app, respecting DEMO_TIME_OFFSET_DAYS. Returns a Date. */
export function now() {
  return new Date(Date.now() + config.demoTimeOffsetDays * 86400000);
}

let dayFmt = null;
/** Calendar date (YYYY-MM-DD) of an instant, in the business time zone (APP_TIMEZONE). */
export function isoDate(d = now()) {
  dayFmt ||= new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dayFmt.format(new Date(d));
}

/** Pure calendar arithmetic on YYYY-MM-DD strings (time-zone independent). */
export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Same day next month(s), clamped to month end (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(dateStr, months) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return first.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

/**
 * Round money to cents, half away from zero, without binary floating point surprises:
 * 1.005 -> 1.01 and 0.575 -> 0.58 (plain Math.round(x * 100) / 100 gives 1.00 and 0.57).
 */
export function cents(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  const scaled = Number((Math.abs(x) * 100).toPrecision(12));
  return (Math.sign(x) * Math.round(scaled)) / 100 || 0;
}

/**
 * The visitor's address for rate limits. Some proxies (Azure App Service) forward it with the
 * client's port ("203.0.113.5:51234"), which changes on every connection; drop the port.
 */
export function clientIp(req) {
  const ip = String(req?.ip || '');
  if (!ip) return 'local';
  const v4 = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4) return v4[1];
  const v6 = ip.match(/^\[([0-9a-f:.]+)\]:\d+$/i);
  return v6 ? v6[1] : ip;
}
