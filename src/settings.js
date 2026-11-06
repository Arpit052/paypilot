// In-app settings (Settings page + first-run "Connect PayPal" screen).
// Stored in the kv table under "settings:*" keys, layered on top of .env:
//   - PayPal: keys connected in the app win; "demo" forces offline mode; otherwise .env decides.
//   - Business: name, default tax, late-fee policy.
// The PayPal secret is kept server-side only and never sent back to the browser.
import { config } from './config.js';
import { kvGet, kvSet } from './db.js';

const SANDBOX_URL = 'https://api-m.sandbox.paypal.com';
// What .env said at start-up, so "Disconnect" can fall back to it.
const envPaypal = { ...config.paypal };
const envBusiness = {
  businessName: config.businessName,
  defaultTaxPercent: config.defaultTaxPercent,
  lateFeePercent: config.lateFeePercent,
  lateFeeAfterDays: config.lateFeeAfterDays,
};
const envChoseMode = Boolean(process.env.PAYPAL_MODE);

let paypalSource = 'env';

/** Re-read stored settings into the live config. Call after any change. */
export function applySettings() {
  const p = kvGet('settings:paypal');
  if (p?.state === 'connected' && p.clientId && p.clientSecret) {
    Object.assign(config.paypal, { mode: 'sandbox', clientId: p.clientId, clientSecret: p.clientSecret, baseUrl: SANDBOX_URL });
    paypalSource = 'app';
  } else if (p?.state === 'demo') {
    Object.assign(config.paypal, { mode: 'mock' });
    paypalSource = 'demo';
  } else {
    Object.assign(config.paypal, envPaypal);
    paypalSource = envPaypal.mode === 'mock' ? 'none' : 'env';
  }
  const b = kvGet('settings:business') || {};
  config.businessName = b.businessName || envBusiness.businessName;
  config.defaultTaxPercent = b.defaultTaxPercent ?? envBusiness.defaultTaxPercent;
  config.lateFeePercent = b.lateFeePercent ?? envBusiness.lateFeePercent;
  config.lateFeeAfterDays = b.lateFeeAfterDays ?? envBusiness.lateFeeAfterDays;
}

/** Has the first-run choice been made (connect PayPal or try demo)? */
export function setupDone() {
  return Boolean(kvGet('settings:paypal')) || envChoseMode || envPaypal.mode !== 'mock';
}

export function connectPaypal({ clientId, clientSecret }) {
  kvSet('settings:paypal', { state: 'connected', clientId, clientSecret, connectedAt: new Date().toISOString() });
  applySettings();
}

export function useDemoMode() {
  kvSet('settings:paypal', { state: 'demo', at: new Date().toISOString() });
  applySettings();
}

/** Forget keys entered in the app. Falls back to demo mode (not to .env), so it really disconnects. */
export function disconnectPaypal() {
  useDemoMode();
}

const mask = (id) => (id ? `${id.slice(0, 6)}…${id.slice(-4)}` : '');

/** Safe-to-display view of the settings (no secrets). */
export function publicSettings() {
  const p = kvGet('settings:paypal');
  return {
    paypal: {
      mode: config.paypal.mode, // 'sandbox' | 'live' | 'mock'
      source: paypalSource, // 'app' | 'env' | 'demo' | 'none'
      clientId: config.paypal.mode === 'mock' ? '' : mask(config.paypal.clientId),
      connectedAt: p?.state === 'connected' ? p.connectedAt : null,
      envKeysAvailable: envPaypal.mode !== 'mock',
    },
    business: {
      businessName: config.businessName,
      defaultTaxPercent: config.defaultTaxPercent,
      lateFeePercent: config.lateFeePercent,
      lateFeeAfterDays: config.lateFeeAfterDays,
    },
    setupDone: setupDone(),
  };
}

const httpErr = (m) => Object.assign(new Error(m), { status: 400 });

export function saveBusinessSettings(input = {}) {
  const cur = kvGet('settings:business') || {};
  const next = { ...cur };
  if (input.businessName !== undefined) {
    const name = String(input.businessName).trim().slice(0, 100);
    if (!name) throw httpErr('Business name cannot be empty');
    next.businessName = name;
  }
  const num = (v, lo, hi, label) => {
    const n = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(n) || n < lo || n > hi) throw httpErr(`${label} must be between ${lo} and ${hi}`);
    return n;
  };
  if (input.defaultTaxPercent !== undefined) next.defaultTaxPercent = num(input.defaultTaxPercent, 0, 50, 'Default sales tax');
  if (input.lateFeePercent !== undefined) next.lateFeePercent = num(input.lateFeePercent, 0, 25, 'Late fee');
  if (input.lateFeeAfterDays !== undefined) next.lateFeeAfterDays = Math.round(num(input.lateFeeAfterDays, 1, 90, 'Days before a late fee'));
  kvSet('settings:business', next);
  applySettings();
  return publicSettings().business;
}
