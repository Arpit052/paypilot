import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export const config = {
  root: ROOT,
  port: Number(env.PORT || 3000),
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),

  businessName: env.BUSINESS_NAME || 'Arpit Designs',
  currency: (env.DEFAULT_CURRENCY || 'USD').toUpperCase(),
  // Shift the app's clock forward for demos ("what happens in 10 days?").
  demoTimeOffsetDays: Number(env.DEMO_TIME_OFFSET_DAYS || 0),
  reminderCooldownDays: Number(env.REMINDER_COOLDOWN_DAYS || 3),
  cronSecret: env.CRON_SECRET || '',

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
    // thinking level: low | medium | high | off (= let the model decide)
    geminiThinking: (env.GEMINI_REASONING || 'low').toLowerCase(),
  },
};

config.paypal.baseUrl =
  config.paypal.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

/** "Today" for the app, respecting DEMO_TIME_OFFSET_DAYS. Returns a Date. */
export function now() {
  return new Date(Date.now() + config.demoTimeOffsetDays * 86400000);
}

/** YYYY-MM-DD for a Date (UTC). */
export function isoDate(d = now()) {
  return new Date(d).toISOString().slice(0, 10);
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
