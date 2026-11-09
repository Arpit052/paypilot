// In-app settings (Settings page + first-run "Connect PayPal" screen).
// Stored in the kv table under "settings:*" keys, layered on top of .env:
//   - PayPal: keys connected in the app win; "demo" forces offline mode; otherwise .env decides.
//   - Business: name, default tax, late-fee policy.
// The PayPal secret is kept server-side only and never sent back to the browser.
import { config } from './config.js';
import { currentSpace, perSpace } from './context.js';
import { kvGet, kvSet } from './db.js';
import { BUSINESS_TYPES, normalType } from './business.js';
import { activeProfile } from './bizprofile.js';

const SANDBOX_URL = 'https://api-m.sandbox.paypal.com';
// What .env said at start-up, so "Disconnect" can fall back to it.
const envPaypal = { ...config.paypal };
const envBusiness = {
  businessName: config.businessName,
  defaultTaxPercent: config.defaultTaxPercent,
  lateFeePercent: config.lateFeePercent,
  lateFeeAfterDays: config.lateFeeAfterDays,
  currency: config.currency,
  ownerName: '',
  businessEmail: '',
  website: '',
  defaultTermsDays: 7,
  defaultNote: '',
  reminderStyle: 'warm',
  signOff: '',
  aiInstructions: '',
  notify: { payment: true, overdue: true, due: true, approval: true, import: true },
  businessType: 'graphic_designer',
  businessTypeOther: '',
  businessDescription: '',
  accountType: 'freelancer',
  teamSize: '',
};
const PREF_KEYS = ['accountType', 'teamSize', 'businessType', 'businessTypeOther', 'businessDescription', 'currency', 'ownerName', 'businessEmail', 'website', 'defaultTermsDays', 'defaultNote', 'reminderStyle', 'signOff', 'aiInstructions', 'notify'];
const envChoseMode = Boolean(process.env.PAYPAL_MODE);

// where the PayPal keys came from, per visitor workspace on the hosted demo
const source = perSpace(() => ({ value: 'env' }));

/** Re-read stored settings into the live config. Call after any change. */
export function applySettings() {
  const p = kvGet('settings:paypal');
  if (p?.state === 'connected' && p.clientId && p.clientSecret) {
    Object.assign(config.paypal, { mode: 'sandbox', clientId: p.clientId, clientSecret: p.clientSecret, baseUrl: SANDBOX_URL });
    source.value = 'app';
  } else if (p?.state === 'demo' || currentSpace()) {
    // demo mode holds no keys at all; a visitor workspace never falls back to the server's .env keys
    Object.assign(config.paypal, { mode: 'mock', clientId: '', clientSecret: '', webhookId: '' });
    source.value = p?.state === 'demo' ? 'demo' : 'none';
  } else {
    Object.assign(config.paypal, envPaypal);
    source.value = envPaypal.mode === 'mock' ? 'none' : 'env';
  }
  const b = kvGet('settings:business') || {};
  // a visitor's private copy starts with no name; the server's BUSINESS_NAME is only the demo's default
  config.businessName = b.businessName || (currentSpace() ? '' : envBusiness.businessName);
  config.defaultTaxPercent = b.defaultTaxPercent ?? envBusiness.defaultTaxPercent;
  config.lateFeePercent = b.lateFeePercent ?? envBusiness.lateFeePercent;
  config.lateFeeAfterDays = b.lateFeeAfterDays ?? envBusiness.lateFeeAfterDays;
  for (const k of PREF_KEYS) config[k] = k === 'notify' ? { ...envBusiness.notify, ...(b.notify || {}) } : b[k] ?? envBusiness[k];
  config.businessType = normalType(config.businessType);
}

/** Has the first-run choice been made (connect PayPal or try demo)? */
export function setupDone() {
  if (currentSpace()) return Boolean(kvGet('settings:paypal')); // a visitor workspace chooses for itself
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
      source: source.value, // 'app' | 'env' | 'demo' | 'none'
      clientId: config.paypal.mode === 'mock' ? '' : mask(config.paypal.clientId),
      connectedAt: p?.state === 'connected' ? p.connectedAt : null,
      envKeysAvailable: envPaypal.mode !== 'mock' && !currentSpace(),
    },
    business: {
      businessName: config.businessName,
      defaultTaxPercent: config.defaultTaxPercent,
      lateFeePercent: config.lateFeePercent,
      lateFeeAfterDays: config.lateFeeAfterDays,
      ...Object.fromEntries(PREF_KEYS.map((k) => [k, config[k]])),
      profile: activeProfile(),
    },
    setupDone: setupDone(),
    hiddenClients: (kvGet('hidden:emails') || []).length,
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
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  if (input.ownerName !== undefined) next.ownerName = text(input.ownerName, 80);
  if (input.website !== undefined) next.website = text(input.website, 120);
  if (input.signOff !== undefined) next.signOff = text(input.signOff, 200);
  if (input.defaultNote !== undefined) next.defaultNote = text(input.defaultNote, 600);
  if (input.aiInstructions !== undefined) next.aiInstructions = text(input.aiInstructions, 600);
  if (input.businessEmail !== undefined) {
    const e = text(input.businessEmail, 120);
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw httpErr('That business email doesn\'t look right');
    next.businessEmail = e;
  }
  if (input.defaultTermsDays !== undefined) next.defaultTermsDays = Math.round(num(input.defaultTermsDays, 0, 120, 'Default payment terms'));
  if (input.reminderStyle !== undefined) {
    if (!['warm', 'neutral', 'brief'].includes(input.reminderStyle)) throw httpErr('Unknown reminder style');
    next.reminderStyle = input.reminderStyle;
  }
  if (input.accountType !== undefined) {
    if (!['freelancer', 'business'].includes(input.accountType)) throw httpErr('Choose freelancer or business');
    next.accountType = input.accountType;
    // businesses usually bill on Net 30 and keep reminders matter-of-fact
    if (input.applyPreset && input.accountType === 'business') {
      next.defaultTermsDays = 30;
      next.reminderStyle = 'neutral';
    }
  }
  if (input.teamSize !== undefined) next.teamSize = String(input.teamSize || '').trim().slice(0, 20);
  // businesses describe what they sell in their own words; the AI reads it (src/bizprofile.js)
  if (input.businessDescription !== undefined) next.businessDescription = String(input.businessDescription || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (input.businessTypeOther !== undefined) next.businessTypeOther = String(input.businessTypeOther || '').trim().slice(0, 40);
  if (input.businessType !== undefined) {
    if (!BUSINESS_TYPES[input.businessType]) throw httpErr('Unknown profession');
    if (input.businessType !== 'other' && input.businessTypeOther === undefined) next.businessTypeOther = '';
    next.businessType = input.businessType;
    // "Use these defaults": copy the type's terms, reminder style and invoice note
    if (input.applyPreset) {
      const t = BUSINESS_TYPES[input.businessType];
      next.defaultTermsDays = t.terms;
      next.reminderStyle = t.style;
      next.defaultNote = t.note;
    }
  }
  if (input.applyPreset && (input.accountType ?? next.accountType) === 'business') {
    next.defaultTermsDays = 30;
    next.reminderStyle = 'neutral';
  }
  if (input.currency !== undefined) {
    const c = String(input.currency).toUpperCase();
    if (!config.paypalCurrencies.includes(c)) throw httpErr(`PayPal can't invoice in ${c}`);
    next.currency = c;
  }
  if (input.notify && typeof input.notify === 'object') {
    next.notify = { ...(cur.notify || envBusiness.notify) };
    for (const k of Object.keys(envBusiness.notify)) if (input.notify[k] !== undefined) next.notify[k] = Boolean(input.notify[k]);
  }
  kvSet('settings:business', next);
  applySettings();
  return publicSettings().business;
}
