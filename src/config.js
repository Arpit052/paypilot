import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present (Node >= 20.12). Real env vars always win.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env file - fine */
}

const env = process.env;

function detectLlmProvider() {
  if (env.LLM_PROVIDER) return env.LLM_PROVIDER.toLowerCase();
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
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
