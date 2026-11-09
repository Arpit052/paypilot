// A business describes what it sells in its own words ("Commercial cleaning for offices and
// clinics in Austin"). Instead of forcing it into a freelancer profession, PayPilot reads that
// sentence once and keeps a small profile: a short label, the kinds of work it bills for (used
// to group invoice lines on the Growth page), invoice shortcuts, the word for a retainer, and
// sample work for the demo. The AI writes the profile; simple rules fill in when no AI is
// available, so the feature never blocks onboarding.
import { config } from './config.js';
import { kvGet, kvSet } from './db.js';
import { complete, llmAvailable } from './llm.js';
import { BUSINESS_TYPES, typeOf } from './business.js';

const KEY = 'business:profile';
const STOP = new Set('a an and the for of to in on at by with from our we us you your my is are be services service company business businesses small local based plus also all other things stuff etc via who that this into across around best quality professional'.split(' '));
const words = (s) => String(s || '').toLowerCase().match(/[a-z][a-z&'-]+/g) || [];
const title = (s) => String(s || '').trim().replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const clip = (s, n) => title(s).slice(0, n).trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The saved profile, or null. */
export function getBusinessProfile() {
  const p = kvGet(KEY);
  return p && p.source ? p : null;
}

/** True when the owner runs a business and described it in their own words. */
export function usesDescription() {
  return config.accountType === 'business' && Boolean(String(config.businessDescription || '').trim());
}

/** Profile for the current settings (null for freelancers or an empty description). */
export function activeProfile() {
  if (!usesDescription()) return null;
  const p = getBusinessProfile();
  return p && p.source === config.businessDescription.trim() ? p : ruleProfile(config.businessDescription);
}

/**
 * What the app should use for shortcuts, the retainer word and prompts: the business profile
 * when there is one, otherwise the profession preset.
 */
export function activeType() {
  const p = activeProfile();
  const t = typeOf(config.businessType);
  if (!p) return { label: t.label, blurb: t.blurb, items: t.items, retainer: t.retainer, description: '' };
  return { label: p.label, blurb: p.summary, items: p.items.map((i) => [i.name, i.price]), retainer: p.retainer, description: config.businessDescription.trim(), customers: p.customers };
}

/**
 * Which of the business's own kinds of work an invoice line belongs to. Every area is scored by
 * how much of the line its keywords cover (longer, more specific words count more), so a
 * "Medical clinic deep clean" goes to Deep cleaning, not to whichever area says "clean" first.
 */
export function profileAreaOf(name) {
  const p = activeProfile();
  const text = String(name || '').toLowerCase();
  if (!p || !text) return null;
  let best = null;
  let top = 0;
  for (const a of p.areas) {
    let score = 0;
    for (const k of a.keywords) if (new RegExp(`\\b${esc(k)}`, 'i').test(text)) score += k.length;
    if (new RegExp(`\\b${esc(a.name.toLowerCase())}`).test(text)) score += a.name.length * 2;
    if (score > top) [best, top] = [a.name, score];
  }
  return best;
}

/** True when the profile has kinds of work of its own (then the profession lists are skipped). */
export function hasProfileAreas() {
  return Boolean(activeProfile()?.areas?.length);
}

/** Closest built-in preset by shared words (used for the fallback shortcuts and demo work). */
function closestPreset(text) {
  const w = new Set(words(text).filter((x) => !STOP.has(x) && x.length > 3));
  let best = 'other';
  let score = 0;
  for (const [key, t] of Object.entries(BUSINESS_TYPES)) {
    if (key === 'other') continue;
    const bag = words(`${t.label} ${t.blurb} ${t.items.map((i) => i[0]).join(' ')}`);
    const s = bag.filter((x) => w.has(x) || [...w].some((y) => y.length > 4 && (x.startsWith(y.slice(0, 5)) || y.startsWith(x.slice(0, 5))))).length;
    if (s > score) [best, score] = [key, s];
  }
  return score >= 2 ? best : 'other';
}

/** No-AI reading of the sentence: split it into the things it lists. */
export function ruleProfile(text) {
  const src = String(text || '').trim();
  const preset = closestPreset(src);
  const t = BUSINESS_TYPES[preset];
  // "office cleaning, deep cleans and window washing for clinics" → three kinds of work
  const main = src.split(/\b(?:for|to|in|across|serving)\b/i)[0];
  const parts = main
    .split(/,|;|\/|\band\b|&|\+/i)
    .map((s) => s.trim())
    .filter((s) => words(s).some((x) => !STOP.has(x) && x.length > 2))
    .slice(0, 6);
  const areas = parts.map((p) => {
    const kw = words(p).filter((x) => !STOP.has(x) && x.length > 3);
    return { name: clip(p.split(/\s+/).slice(0, 3).join(' '), 30), keywords: [...new Set(kw.map((k) => k.replace(/(ing|es|s)$/, '')).filter((k) => k.length > 3))].slice(0, 4) };
  });
  const seen = new Map();
  for (const a of areas) for (const k of a.keywords) seen.set(k, (seen.get(k) || 0) + 1);
  for (const a of areas) a.keywords = a.keywords.filter((k) => seen.get(k) === 1 || a.keywords.length === 1);
  const customers = (src.match(/\b(?:for|serving)\s+([^.]+)/i)?.[1] || '').trim().slice(0, 60);
  return {
    source: src,
    by: 'rules',
    label: clip(parts[0] || src, 40) || 'Business',
    summary: clip(src, 120),
    customers,
    preset,
    areas,
    items: t.items.slice(0, 4).map(([name, price]) => ({ name, price })),
    retainer: preset === 'other' ? 'service contract' : t.retainer,
    demo: null,
  };
}

const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 100) / 100 : null;
};
const line = (x) => {
  if (!Array.isArray(x)) x = [x?.name, x?.quantity ?? x?.qty ?? 1, x?.price ?? x?.unitPrice];
  const [name, q, p] = x;
  const quantity = num(q, 0.01, 10000);
  const unitPrice = num(p, 0.5, 250000);
  return name && quantity && unitPrice ? [clip(name, 60), quantity, unitPrice] : null;
};
const jobs = (arr, n) => {
  const out = (Array.isArray(arr) ? arr : []).map((j) => (Array.isArray(j) && Array.isArray(j[0]) || Array.isArray(j) && typeof j[0] === 'object' ? j : [j]).map(line).filter(Boolean)).filter((j) => j.length);
  return out.length >= n ? out.slice(0, n) : null;
};

/** Check and tidy what the AI sent back; anything unusable falls back to the rules. */
export function cleanProfile(raw, src) {
  const base = ruleProfile(src);
  if (!raw || typeof raw !== 'object') return base;
  const areas = (Array.isArray(raw.areas) ? raw.areas : [])
    .map((a) => ({ name: clip(a?.name, 30), keywords: [...new Set((Array.isArray(a?.keywords) ? a.keywords : []).map((k) => String(k).toLowerCase().trim()).filter((k) => /^[a-z][a-z0-9 &'-]{1,30}$/.test(k)))].slice(0, 10) }))
    .filter((a) => a.name && a.keywords.length)
    .slice(0, 8);
  const items = (Array.isArray(raw.items) ? raw.items : []).map((i) => ({ name: clip(i?.name, 60), price: num(i?.price, 0.5, 250000) })).filter((i) => i.name && i.price).slice(0, 6);
  const d = raw.demo || {};
  const retainer = line(Array.isArray(d.retainer?.[0]) ? d.retainer[0] : d.retainer);
  const demo = retainer && jobs(d.frequent, 4) && jobs(d.marcus, 4) && jobs(d.william, 4) && jobs(d.sofia, 3) && jobs(d.daniel, 1)
    ? { retainer, frequent: jobs(d.frequent, 4), marcus: jobs(d.marcus, 4), william: jobs(d.william, 4), sofia: jobs(d.sofia, 3), daniel: jobs(d.daniel, 1) }
    : null;
  return {
    source: src,
    by: 'ai',
    label: clip(raw.label, 40) || base.label,
    summary: clip(raw.summary, 160) || base.summary,
    customers: clip(raw.customers, 80) || base.customers,
    preset: BUSINESS_TYPES[raw.preset] ? raw.preset : base.preset,
    areas: areas.length >= 2 ? areas : base.areas,
    items: items.length >= 2 ? items : base.items,
    retainer: clip(raw.retainer, 40).toLowerCase() || base.retainer,
    demo,
  };
}

const parseJson = (text) => {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
};
const withTimeout = (p, ms) => {
  let t;
  const limit = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('timeout')), ms);
    t.unref?.();
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(t));
};

const ask = (text, maxTokens, timeoutMs) =>
  withTimeout(
    complete({ system: 'You set up invoicing software for a business from its own description. Reply with JSON only, no prose.', messages: [{ role: 'user', content: [{ type: 'text', text }] }], maxTokens, fast: true }),
    timeoutMs,
  ).then(({ content }) => parseJson(content.filter((c) => c.type === 'text').map((c) => c.text).join('')));

/**
 * Read the owner's description and save the profile. Cheap when the text hasn't changed.
 * Never throws: on any AI problem it saves the rule-based reading.
 */
export async function interpretBusiness(text, { timeoutMs = 120000, force = false } = {}) {
  const src = String(text || '').trim().slice(0, 200);
  if (!src) {
    kvSet(KEY, null);
    return null;
  }
  const have = getBusinessProfile();
  if (!force && have && have.source === src && (have.by === 'ai' || !llmAvailable())) return have;
  const rules = ruleProfile(src);
  if (!have || have.source !== src) kvSet(KEY, rules); // usable right away while the AI reads it
  if (!llmAvailable()) return rules;
  try {
    const raw = await ask(
      `The business describes itself as: ${JSON.stringify(src)}\nCurrency: ${config.currency}.\n\n` +
        'Return {"label","summary","customers","preset","areas","items","retainer"}:\n' +
        '- label: what it is in 2-5 words, e.g. "Commercial cleaning company"\n' +
        '- summary: one plain sentence of what it sells and to whom\n' +
        '- customers: who usually pays it, 2-6 words\n' +
        `- preset: the closest of ${Object.keys(BUSINESS_TYPES).join(', ')} ("other" if none is close)\n` +
        '- areas: 3-6 kinds of work it bills for, each {"name": 1-3 words, "keywords": 3-8 lowercase words or stems found in its invoice line items; no word in two areas}\n' +
        '- items: 4 typical invoice lines {"name","price"} with realistic prices\n' +
        '- retainer: what a repeat monthly arrangement is called here, e.g. "monthly cleaning contract"\n' +
        'Realistic for this exact business. No brand names.',
      900,
      timeoutMs,
    );
    if (getBusinessProfile()?.source !== src && getBusinessProfile()) return getBusinessProfile(); // text changed meanwhile
    const profile = cleanProfile(raw, src);
    kvSet(KEY, profile);
    return profile;
  } catch (e) {
    console.log(`  [business] AI reading skipped, using rules: ${e.message}`);
    return rules;
  }
}

/** Ask the AI for sample work that fits the profile (for demo data). Returns the demo or null. */
export async function writeDemoWork({ timeoutMs = 120000 } = {}) {
  const p = getBusinessProfile();
  if (!p || p.demo || !llmAvailable()) return p?.demo || null;
  try {
    const raw = await ask(
      `Business: ${p.label} (${p.summary}). Customers: ${p.customers || 'businesses'}. Kinds of work: ${p.areas.map((a) => a.name).join(', ')}. Currency: ${config.currency}.\n` +
        'Write sample invoice lines as [name, quantity, unitPrice] for a demo. Return {"retainer": one line for a monthly ' +
        `${p.retainer}, "frequent": 4 small orders, "marcus": 4 bigger jobs, "william": 4 jobs, "sofia": 3 smaller jobs, "daniel": 1 one-off for a private person}. ` +
        'Each order is a list of 1-2 lines. Realistic names and prices for this business. No brand names.',
      1400,
      timeoutMs,
    );
    const demo = cleanProfile({ ...p, demo: raw }, p.source).demo;
    const now = getBusinessProfile();
    if (!demo || now?.source !== p.source) return null;
    kvSet(KEY, { ...now, demo });
    return demo;
  } catch (e) {
    console.log(`  [business] sample work skipped: ${e.message}`);
    return null;
  }
}

/** Placeholder sample work built from the kinds of work, used until the AI has written its own. */
export function ruleDemoWork(p) {
  const names = (p?.areas || []).map((a) => a.name).filter(Boolean);
  if (!names.length) return null;
  const n = (i) => names[i % names.length];
  const L = (i, price, q = 1) => [[n(i), q, price]];
  return {
    retainer: [`${n(0)} (${p.retainer || 'monthly'})`.slice(0, 60), 1, 1200],
    frequent: [L(0, 450), L(1, 300), L(2, 380), L(0, 520)],
    marcus: [L(1, 2400), L(2, 950), L(0, 1800), L(1, 1150)],
    william: [L(0, 1600), L(2, 950), L(1, 720), L(0, 680)],
    sofia: [L(2, 420), L(0, 380), L(1, 560)],
    daniel: [L(0, 900)],
  };
}

/** Demo work in the persona shape, from the profile (null when it has none). */
export function profileDemoWork() {
  const p = activeProfile();
  if (!p) return null;
  return p.demo || ruleDemoWork(p);
}
