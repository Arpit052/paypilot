// Retainer offers: find clients who already buy from you almost every month and suggest
// turning that habit into a fixed monthly plan at a small discount.
//
// Why both sides win (all measured from your own invoices):
//   - the client pays a little less than in a typical month they work with you;
//   - you get paid in the quiet months too, on a known date, with one invoice instead of many;
//   - clients already on a retainer usually pay faster, and we show your own numbers for that.
//
// Nothing is sent from here. PayPilot writes the offer; you send it from your own email.
// When the client says yes, one click creates the retainer (each invoice still waits for approval).
import { config, isoDate, addDays, daysBetween } from './config.js';
import { listClients, listInvoices, listSchedules, kvGet, kvSet, getClient } from './db.js';
import { isPaid, clientStats } from './analytics.js';
import { complete, llmAvailable } from './llm.js';
import { cleanText } from './actions.js';
import { typeOf } from './business.js';

const LOOKBACK = 180; // days of history we learn from
const MONTH = 30.44;
const r2 = (n) => Math.round(n * 100) / 100;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
/** Round a price the way people do: to 5 under 500, to 10 under 2,000, then to 25. */
const nicePrice = (n) => {
  const step = n < 500 ? 5 : n < 2000 ? 10 : 25;
  return Math.max(step, Math.round(n / step) * step);
};

const state = () => kvGet('offers:state') || {};
const saveState = (s) => kvSet('offers:state', s);

/** How late paid invoices were, on average, for a set of clients (null if no data). */
function avgLate(clientIds) {
  const ds = listInvoices()
    .filter((i) => clientIds.has(i.clientId) && isPaid(i) && i.paidDate)
    .map((i) => Math.max(0, daysBetween(i.dueDate, i.paidDate)));
  return ds.length ? { days: r2(mean(ds)), n: ds.length } : null;
}

/** Score one client's buying habit. Returns null when there isn't enough of a pattern. */
export function buyingPattern(clientId, today = isoDate()) {
  const from = addDays(today, -LOOKBACK);
  const invs = listInvoices({ clientId })
    .filter((i) => i.status !== 'CANCELLED' && i.currency === config.currency && i.issueDate >= from)
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate));
  if (invs.length < 4) return null;

  const span = Math.max(90, daysBetween(invs[0].issueDate, today)); // at least 3 months
  const buckets = Math.ceil(span / MONTH);
  // monthly spend, counting back from today in 30-day blocks (empty months count as 0)
  const monthly = Array.from({ length: buckets }, () => 0);
  for (const i of invs) {
    const k = Math.min(buckets - 1, Math.floor(daysBetween(i.issueDate, today) / MONTH));
    monthly[k] += i.total;
  }
  const covered = monthly.filter((v) => v > 0).length;
  const coverage = covered / buckets;
  const gaps = invs.slice(1).map((i, k) => daysBetween(invs[k].issueDate, i.issueDate));
  const cadence = mean(gaps);
  const cv = cadence ? sd(gaps) / cadence : 1; // how irregular the gaps are
  const regularity = Math.max(0, Math.min(1, 1 - cv));
  const total = invs.reduce((t, i) => t + i.total, 0);
  const perMonth = total / buckets; // average over every month, quiet ones included
  const perActiveMonth = total / covered; // a typical month they do buy
  const score = 0.5 * coverage + 0.3 * regularity + 0.2 * Math.min(1, invs.length / 6);

  // what they usually buy: most frequent line items
  const counts = new Map();
  for (const i of invs) for (const it of i.items) if (!it.lateFee) counts.set(it.name, (counts.get(it.name) || 0) + 1);
  const usual = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);

  return {
    invoices: invs.length,
    months: buckets,
    activeMonths: covered,
    coverage: r2(coverage),
    cadenceDays: Math.round(cadence),
    regularity: r2(regularity),
    score: r2(score),
    total: r2(total),
    perMonth: r2(perMonth),
    perActiveMonth: r2(perActiveMonth),
    swing: { low: r2(Math.min(...monthly)), high: r2(Math.max(...monthly)), sd: r2(sd(monthly)) },
    monthly: monthly.map(r2).reverse(), // oldest -> newest
    usual,
  };
}

/** Discount: just enough to make the commitment worth it for the client. */
function discountFor(p) {
  if (p.coverage >= 0.95) return 3; // already buys every month: the plan is about certainty, so only a small thank-you
  if (p.coverage >= 0.8) return 8;
  return 10;
}

/** Clients worth offering a retainer, best first. */
export function retainerOffers(today = isoDate()) {
  const onPlan = new Set(listSchedules().filter((s) => s.active).map((s) => s.clientId));
  const st = state();
  const word = typeOf(config.businessType).retainer;
  const planPayers = onPlan.size ? avgLate(onPlan) : null;
  const out = [];
  for (const c of listClients()) {
    if (onPlan.has(c.id)) continue;
    const s = st[c.id];
    if (s?.status === 'dismissed' && s.until > today) continue;
    if (s?.status === 'accepted') continue;
    const p = buyingPattern(c.id, today);
    // only clients who really buy about monthly: otherwise a monthly plan would cost them more
    if (!p || p.coverage < 0.75 || p.cadenceDays > 40 || p.score < 0.6) continue;
    // a client who already pays very late would likely be late on a retainer too
    if (clientStats(c.id, today).riskLabel === 'high') continue;

    const discount = discountFor(p);
    const price = nicePrice(p.perActiveMonth * (1 - discount / 100));
    const own = avgLate(new Set([c.id]));
    const yearNow = r2(p.perMonth * 12);
    const yearPlan = r2(price * 12);
    out.push({
      clientId: c.id,
      client: c.name,
      company: c.company || '',
      email: c.email,
      currency: config.currency,
      pattern: p,
      offer: {
        word,
        discount,
        price,
        clientSaves: r2(p.perActiveMonth - price), // per month, vs a typical month they buy
        yearNow, // what this client is worth a year at today's pace
        yearPlan,
        yearChange: r2(yearPlan - yearNow),
        invoicesNow: Math.round((p.invoices / p.months) * 12),
        invoicesPlan: 12,
        payment: {
          client: own ? own.days : null,
          retainerClients: planPayers ? planPayers.days : null,
          retainerSample: planPayers ? planPayers.n : 0,
        },
      },
      status: s?.status === 'offered' ? 'offered' : 'new',
      offeredAt: s?.status === 'offered' ? s.at : null,
      draft: kvGet(`offer:${c.id}`),
    });
  }
  // most extra yearly income first
  return out.sort((a, b) => b.offer.yearChange - a.offer.yearChange || b.pattern.score - a.pattern.score);
}

export function findOffer(clientId) {
  const o = retainerOffers().find((x) => x.clientId === clientId);
  if (!o) throw Object.assign(new Error('No retainer suggestion for this client right now'), { status: 404 });
  return o;
}

function templateOffer(o) {
  const first = o.client.split(/\s+/)[0];
  const m = (v) => `${o.currency} ${v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  const sign = config.signOff || [config.ownerName, config.businessName].filter(Boolean).join('\n') || 'Thanks';
  return {
    subject: `A simpler way to work together: a ${o.offer.word}`,
    message: cleanText(`Hi ${first},

Over the last ${o.pattern.months} months we've worked together in ${o.pattern.activeMonths} of them, usually for ${o.pattern.usual.slice(0, 2).map((x) => `"${x}"`).join(' and ') || 'similar work'}.

Instead of a separate invoice each time, I'd like to offer you a ${o.offer.word}: ${m(o.offer.price)} a month, which is ${o.offer.discount}% less than a typical month with us. It covers the same kind of work you already book, you get priority scheduling, and you receive one invoice on the same date each month.

If that sounds useful, just reply and I'll set it up from next month. Happy to adjust what's included.

${sign}`),
  };
}

async function aiOffer(o) {
  const t = typeOf(config.businessType);
  const prompt = `Write a short email offering a ${o.offer.word} to a ${t.client} of a ${t.label.toLowerCase()} business${config.businessName ? ` called "${config.businessName}"` : ''}.
Facts (use only these, do not invent others):
- ${t.client} name: ${o.client}${o.company ? ` (${o.company})` : ''}
- they worked with us in ${o.pattern.activeMonths} of the last ${o.pattern.months} months; usual work: ${o.pattern.usual.join('; ')}
- offer: ${o.currency} ${o.offer.price} per month, ${o.offer.discount}% less than a typical month with us
- one invoice on the same date every month, priority scheduling, can be adjusted
Style: ${config.reminderStyle || 'warm'}, plain US English, under 130 words, no emojis, no pressure, no exclamation marks.
${config.aiInstructions ? `Owner's own instructions: ${config.aiInstructions}\n` : ''}Sign off with: ${config.signOff || [config.ownerName, config.businessName].filter(Boolean).join(', ') || 'the owner'}
Return JSON: {"subject": "...", "message": "..."}`;
  const { content } = await complete({ system: 'You write short, honest business emails. Output JSON only.', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 600 });
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  if (!json.subject || !json.message) throw new Error('bad AI output');
  return { subject: cleanText(json.subject), message: cleanText(json.message) };
}

/** Write (or rewrite) the offer email. Cached so the page doesn't call the AI on every load. */
export async function draftOffer(clientId, { refresh = false } = {}) {
  const o = findOffer(clientId);
  if (o.draft && !refresh && o.draft.price === o.offer.price) return o.draft;
  let draft;
  let by = 'ai';
  try {
    if (!llmAvailable()) throw new Error('no llm');
    draft = await aiOffer(o);
  } catch {
    draft = templateOffer(o);
    by = 'template';
  }
  const saved = { ...draft, price: o.offer.price, draftedBy: by, at: new Date().toISOString() };
  kvSet(`offer:${clientId}`, saved);
  return saved;
}

export function markOffered(clientId) {
  findOffer(clientId);
  const s = state();
  s[clientId] = { status: 'offered', at: isoDate() };
  saveState(s);
}

export function dismissOffer(clientId, days = 60) {
  const s = state();
  s[clientId] = { status: 'dismissed', until: addDays(isoDate(), days) };
  saveState(s);
}

/** The client said yes: build the payload for a monthly schedule. */
export function acceptPayload(clientId, { price, startDate } = {}) {
  const o = findOffer(clientId);
  const c = getClient(clientId);
  const amount = Number(price) > 0 ? r2(Number(price)) : o.offer.price;
  const label = o.offer.word.charAt(0).toUpperCase() + o.offer.word.slice(1);
  return {
    offer: o,
    payload: {
      clientName: c.name,
      clientEmail: c.email,
      company: c.company || '',
      items: [{ name: `${label}${o.pattern.usual[0] ? ` (${o.pattern.usual[0]} and similar work)` : ''}`, quantity: 1, unitPrice: amount }],
      frequency: 'monthly',
      startDate,
      dueInDays: 7,
    },
  };
}

export function markAccepted(clientId, price) {
  const s = state();
  s[clientId] = { status: 'accepted', at: isoDate(), price };
  saveState(s);
}
