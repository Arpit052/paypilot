// Labels PayPilot learns from your own data, so the Growth page works on any book, not just
// the demo: which industry each client is in, and which kind of work an unusual line item is.
//
//   1. Rules first: the company name, the email domain and the work billed often say it
//      ("Lumen Health", "@overcastlabs.io", "Wedding invitation suite").
//   2. Anything the rules can't place goes to the AI in one small batch, which picks from the
//      standard list or names a new sector / kind of work in a few words.
//   3. Results are saved, so each client or item is labelled once. Anything you set yourself
//      always wins and is never overwritten.
import { listClients, listInvoices, kvGet, kvSet, kvDel, kvList, setClientIndustry } from './db.js';
import { complete, llmAvailable } from './llm.js';

export const INDUSTRIES = [
  'Software & SaaS', 'E-commerce & retail', 'Marketing & agencies', 'Professional services', 'Healthcare',
  'Education', 'Finance & insurance', 'Real estate', 'Hospitality & food', 'Energy & utilities',
  'Manufacturing', 'Media & entertainment', 'Non-profit', 'Wholesale & trade', 'Logistics & transport',
  'Construction & architecture', 'Private clients',
];

const RULES = [
  ['Healthcare', /\b(health|clinic|medical|medic|dental|dentist|pharma|hospital|care|wellness|therapy|physio|vet|biotech)/i],
  ['Education', /\b(school|academy|university|college|edu|learning|tutor|institute|courses?)\b/i],
  ['Finance & insurance', /\b(bank|capital|finance|financial|invest|insurance|fund|wealth|credit|fintech|accounting|cpa)/i],
  ['Real estate', /\b(realty|real estate|estates?|homes|property|properties|realtors?|housing)\b/i],
  ['Hospitality & food', /\b(cafe|café|coffee|restaurant|food|kitchen|bakery|hotel|hospitality|catering|bistro|bar|brew)/i],
  ['Energy & utilities', /\b(energy|solar|power|utility|utilities|electric|oil|gas|renewables?)\b/i],
  ['Non-profit', /\b(foundation|charity|nonprofit|non-profit|ngo|trust|society)\b/i],
  ['Wholesale & trade', /\b(exports?|imports?|exim|trading|traders|wholesale|distribut|merchants?|overseas)/i],
  ['Logistics & transport', /\b(logistic|freight|shipping|transport|cargo|courier|movers|fleet)/i],
  ['Construction & architecture', /\b(construct|builders?|architect|interiors|contractors?|infra)/i],
  ['Manufacturing', /\b(manufactur|industries|industrial|factory|engineering|machin|fabricat)/i],
  ['Media & entertainment', /\b(films?|pictures|music|records|entertainment|games|gaming|podcast|media house|tv|radio)\b/i],
  ['Marketing & agencies', /\b(agency|marketing|growth|creative|advertis|pr\b|branding|media)/i],
  ['Professional services', /\b(consult|consulting|partners|advisory|advisors|law|legal|attorneys?|associates|llp)\b/i],
  ['E-commerce & retail', /\b(shop|store|retail|boutique|commerce|goods|apparel|fashion|brands?|outfitters|market)\b/i],
  ['Software & SaaS', /\b(labs?|software|tech|technologies|app|apps|cloud|data|saas|systems|digital|ai|dev|platform|io)\b/i],
];
const PERSONAL = /^(gmail|googlemail|yahoo|outlook|hotmail|icloud|me|aol|proton|protonmail|fastmail|live|msn|yandex|zoho|gmx|mail|rediffmail)\./i;

/** Best guess from the client's own details; null when the rules can't tell. */
export function guessIndustry({ company = '', email = '', work = [] } = {}) {
  const domain = String(email).split('@')[1] || '';
  const tld = domain.split('.').slice(-1)[0];
  const name = `${company} ${PERSONAL.test(domain) ? '' : domain.replace(/\.[a-z]+$/i, '').replace(/[.-]/g, ' ')}`.trim();
  for (const [ind, re] of RULES) if (re.test(name)) return ind;
  // domains run words together ("kumarexports.in"), so look inside them, for longer words only
  const host = PERSONAL.test(domain) ? '' : domain.split('.')[0];
  if (host) {
    for (const [ind, re] of RULES) {
      const loose = new RegExp(re.source.replace(/\\b/g, ''), 'gi');
      if ([...host.matchAll(loose)].some((m) => m[0].length >= 5)) return ind;
    }
  }
  if (!company && PERSONAL.test(domain)) return 'Private clients';
  if (/^(io|ai|dev|app|tech)$/i.test(tld)) return 'Software & SaaS';
  if (/^(edu)$/i.test(tld)) return 'Education';
  if (/^(org)$/i.test(tld) && !company) return 'Non-profit';
  if (/(wedding|birthday|family|personal|portrait)/i.test(work.join(' '))) return 'Private clients';
  return null;
}

const autoKey = (id) => `industry:auto:${id}`;
/** How a client's industry was set: 'you', 'rules', 'ai' or null. */
export function industrySource(client) {
  if (!client.industry) return null;
  return kvGet(autoKey(client.id)) || 'you';
}
/** You set it: never relabel this client. */
export function markIndustryByOwner(clientId) {
  kvDel(autoKey(clientId));
}

const areaKey = (name) => `area:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`;
/** Saved labels for line items the built-in rules couldn't place. */
export function learnedAreas() {
  const m = new Map();
  for (const { key, value } of kvList('area:')) if (value) m.set(key, value);
  return { get: (name) => m.get(areaKey(name)) || null };
}

const parseJson = (text) => {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  return JSON.parse(a >= 0 ? t.slice(a, b + 1) : t);
};
let retryAfter = 0;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/**
 * Label what's new. Cheap when nothing is new (no AI call). `unplaced` is the list of line-item
 * names the work-area rules couldn't place. Returns what changed.
 */
export async function learnLabels({ unplaced = [], profession = '', timeoutMs = 9000 } = {}) {
  const changed = { industries: 0, areas: 0, ai: false };
  const invs = listInvoices();
  const workOf = (id) => invs.filter((i) => i.clientId === id).flatMap((i) => (i.items || []).map((x) => x.name)).slice(0, 8);
  const unknown = [];
  for (const c of listClients()) {
    if (c.industry) continue;
    const g = guessIndustry({ company: c.company, email: c.email, work: workOf(c.id) });
    if (g) {
      setClientIndustry(c.id, g);
      kvSet(autoKey(c.id), 'rules');
      changed.industries++;
    } else unknown.push(c);
  }
  const areas = learnedAreas();
  const items = [...new Set(unplaced)].filter((n) => !areas.get(n)).slice(0, 40);
  if ((!unknown.length && !items.length) || !llmAvailable()) return changed;
  // after a failed AI call, wait a while before asking again (no key, quota, offline)
  if (Date.now() < retryAfter) return changed;
  try {
    const ask = {
      clients: unknown.slice(0, 25).map((c) => ({ id: c.id, name: c.name, company: c.company || '', emailDomain: (c.email || '').split('@')[1] || '', work: workOf(c.id) })),
      lineItems: items,
    };
    const { content } = await withTimeout(
      complete({
        system: 'You label small-business data. Reply with JSON only, no prose.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `A ${profession || 'freelancer'} has these clients and invoice line items.\n${JSON.stringify(ask)}\n\n` +
                  `1. For each client, choose the industry the client works in. Prefer one of: ${INDUSTRIES.join('; ')}. If none fits, write a new 1-3 word sector name. Use "Private clients" for individuals.\n` +
                  '2. For each line item, name the kind of work in 1-3 words, Title case (e.g. "Brand identity", "Bookkeeping", "Event photography"). Reuse the same name for similar items.\n' +
                  'Reply exactly as {"clients":{"<id>":"<industry>"},"lineItems":{"<item>":"<kind of work>"}}',
              },
            ],
          },
        ],
        maxTokens: 1200,
      }),
      timeoutMs,
    );
    const out = parseJson(content.filter((c) => c.type === 'text').map((c) => c.text).join(''));
    changed.ai = true;
    for (const c of unknown) {
      const ind = String(out?.clients?.[c.id] || '').trim().slice(0, 40);
      if (!ind) continue;
      setClientIndustry(c.id, ind);
      kvSet(autoKey(c.id), 'ai');
      changed.industries++;
    }
    for (const n of items) {
      const a = String(out?.lineItems?.[n] || '').trim().slice(0, 40);
      if (!a) continue;
      kvSet(areaKey(n), a);
      changed.areas++;
    }
  } catch (e) {
    retryAfter = Date.now() + 15 * 60 * 1000;
    console.log(`  [labels] AI labelling skipped: ${e.message}`);
  }
  return changed;
}
