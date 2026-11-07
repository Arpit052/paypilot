// Growth page: what the payment history says about where to focus and how to grow.
//
// Everything here is computed from the invoice book; nothing is estimated from outside data.
//   - client segments (recency, frequency, value + payment habit)
//   - value vs payment-speed quadrant
//   - industries: which sectors bring the most and pay the fastest
//   - work areas: what you sell, and whether demand is rising or falling
//   - concentration (top-client share, HHI) and days sales outstanding (DSO)
//   - opportunities with an amount only where the amount follows from the book
//   - an optional AI growth plan written from these facts (deterministic plan otherwise)
//
// Amounts are in the main currency only, like the Analytics page.
import { config, isoDate, addDays, daysBetween } from './config.js';
import { listInvoices, listClients, listSchedules } from './db.js';
import { isOpen, isPaid, clientStats } from './analytics.js';
import { retainerOffers } from './offers.js';
import { complete, llmAvailable } from './llm.js';
import { normalType } from './business.js';

const r2 = (n) => Math.round(n * 100) / 100;
const sum = (xs, f = (x) => x) => xs.reduce((t, x) => t + f(x), 0);
const avg = (xs) => (xs.length ? sum(xs) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmtMoney = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: config.currency, maximumFractionDigits: 0 }).format(v);

// ---------------- work areas ----------------
// Line items are grouped into broad areas by keyword, so "Logo refresh" and "Brand guidelines v2"
// count as one kind of work. First match wins, so the order matters.
const words = (...w) => new RegExp(`\\b(?:${w.join('|')})(?:s|es)?\\b`, 'i');
const AREAS = [
  ['Retainers and ongoing work', words('monthly', 'retainer', 'maintenance', 'ongoing', 'subscription')],
  ['Brand and identity', words('logo', 'brand', 'identity', 'guidelines', 'colour', 'color', 'type sheet', 'naming')],
  ['Print and events', words('print', 'poster', 'flyer', 'booth', 'invitation', 'save-the-date', 'card', 'envelope', 'shelf', 'display', 'packaging', 'can artwork', 'signage', 'brochure', 'menu', 'label')],
  ['Websites and product', words('web', 'website', 'site', 'landing', 'page', 'ui', 'ux', 'screen', 'app', 'cms', 'integration', 'api', 'checkout', 'dashboard', 'portal', 'illustration', 'bug', 'plugin', 'theme', 'form', 'microsite', 'store')],
  ['Social and ads', words('social', 'ad', 'campaign', 'linkedin', 'instagram', 'tiktok', 'promo', 'creative', 'ppc', 'paid media', 'influencer')],
  ['Decks and documents', words('deck', 'slide', 'one-pager', 'chart', 'icon', 'report', 'presentation', 'whitepaper', 'ebook')],
  ['Writing and content', words('blog', 'copy', 'article', 'newsletter', 'case study', 'email', 'words', 'content', 'script', 'ghostwriting', 'proofreading')],
  ['Video and photo', words('video', 'edit', 'editing', 'shoot', 'photo', 'photography', 'retouching', 'headshot', 'reel', 'motion', 'animation', 'footage', 'thumbnail')],
  ['Strategy and advice', words('strategy', 'audit', 'workshop', 'session', 'consulting', 'research', 'seo', 'plan', 'roadmap', 'discovery', 'training', 'coaching')],
  ['Admin and support', words('hour', 'admin', 'inbox', 'scheduling', 'bookkeeping', 'data entry', 'support', 'calendar')],
];
// Each profession sells different things, so it gets its own areas; the general list above
// catches anything else.
const R = ['Retainers and ongoing work', words('monthly', 'retainer', 'subscription')];
const BY_PROFESSION = {
  web_developer: [
    ['Retainers and maintenance', words('monthly', 'maintenance', 'retainer')],
    ['Integrations and APIs', words('integration', 'api', 'checkout', 'signup', 'locator')],
    ['New sites and pages', words('site', 'microsite', 'landing', 'page', 'portfolio', 'rebuild', 'build', 'portal')],
    ['Fixes and performance', words('bug', 'fix', 'performance', 'accessibility', 'update')],
    ['Themes and CMS', words('cms', 'template', 'theme', 'customisation', 'customization')],
  ],
  graphic_designer: [
    R,
    ['Brand and identity', words('logo', 'brand', 'guidelines', 'colour', 'color', 'type sheet', 'identity')],
    ['Print and packaging', words('print', 'poster', 'flyer', 'booth', 'invitation', 'save-the-date', 'card', 'envelope', 'shelf', 'display', 'can artwork', 'brochure', 'packaging')],
    ['Digital and UI', words('landing', 'page', 'screen', 'onboarding', 'illustration', 'ui')],
    ['Social and ads', words('social', 'ad', 'creative', 'campaign', 'promo', 'linkedin', 'webinar')],
    ['Decks and documents', words('deck', 'slide', 'one-pager', 'chart', 'icon')],
    ['Photo editing', words('retouching', 'headshot', 'photo')],
  ],
  content_writer: [
    R,
    ['Email and newsletters', words('email', 'newsletter', 'sequence')],
    ['Brand and messaging', words('brand', 'voice', 'tagline', 'press release', 'script')],
    ['Blogs and long-form', words('blog', 'article', 'case study', 'guide', 'rewrite', 'whitepaper', 'ebook')],
    ['Social posts', words('linkedin', 'social', 'post', 'thread')],
    ['Editing', words('editing', 'proofreading', 'speech')],
    ['Website and product copy', words('copy', 'description')],
  ],
  digital_marketer: [
    ['Ongoing management', words('monthly', 'management', 'retainer')],
    ['SEO and local search', words('seo', 'keyword', 'google business')],
    ['Email marketing', words('email')],
    ['Paid ads', words('google ads', 'ad creative', 'paid social', 'ppc', 'ad')],
    ['Social and influencer', words('social', 'linkedin', 'influencer')],
    ['Analytics and conversion', words('report', 'conversion', 'analytics')],
    ['Seasonal campaigns', words('campaign', 'holiday', 'launch')],
  ],
  video_editor: [
    ['Retainers and packages', words('monthly', 'package', 'retainer')],
    ['Colour and sound', words('colour', 'color', 'grading', 'sound', 'mix')],
    ['Short-form and social', words('short-form', 'clip', 'cutdown', 'social', 'tiktok')],
    ['Ads and promos', words('promo', 'ad', 'launch', 'demo')],
    ['Events and weddings', words('event', 'wedding', 'highlight', 'film')],
    ['YouTube and long-form', words('youtube', 'webinar', 'interview', 'thumbnail', 'series')],
    ['Brand stories', words('testimonial', 'tour', 'story', 'video')],
  ],
  consultant: [
    ['Advisory retainers', words('monthly', 'retainer')],
    ['Pricing', words('pricing')],
    ['Research and analysis', words('research', 'competitor', 'survey', 'analysis', 'study')],
    ['Customer and growth', words('journey', 'referral', 'programme', 'program', 'retention')],
    ['Strategy', words('strategy', 'go-to-market', 'workshop', 'session', 'business plan')],
    ['Reviews and audits', words('review', 'readiness', 'audit')],
    ['Hourly advice', words('advisory', 'hour', 'call')],
  ],
  photographer: [
    R,
    ['Editing and licensing', words('edited', 'licence', 'license', 'usage', 'retouching')],
    ['Product', words('product', 'packshot')],
    ['Events', words('event', 'wedding')],
    ['Brand and campaign', words('brand', 'campaign', 'lifestyle')],
    ['People and portraits', words('headshot', 'portrait', 'team', 'family')],
    ['Spaces', words('interior', 'display', 'retail', 'office', 'clinic')],
  ],
  virtual_assistant: [
    R,
    ['Data and CRM', words('data', 'crm')],
    ['Logistics and travel', words('travel', 'logistics', 'shipping', 'move', 'event', 'trade show')],
    ['Research and prep', words('research', 'preparation', 'prep')],
    ['Systems setup', words('setup', 'reminder', 'automation')],
    ['Admin hours', words('admin', 'hour')],
  ],
  other: [
    R,
    ['Hourly work', words('hour')],
    ['Projects', words('project')],
    ['Consultations', words('consultation', 'consult')],
    ['Materials and expenses', words('material', 'expense')],
  ],
};

export function areaOf(name, profession = normalType(config.businessType)) {
  for (const [area, re] of [...(BY_PROFESSION[profession] || []), ...AREAS]) if (re.test(name || '')) return area;
  return 'Other work';
}
const isRecurringArea = (name) => /retainer|ongoing|management|packages/i.test(name);

/** Suggested sectors for the client industry picker (free text is allowed too). */
export const INDUSTRIES = [
  'Software & SaaS', 'E-commerce & retail', 'Marketing & agencies', 'Professional services', 'Healthcare',
  'Education', 'Finance & insurance', 'Real estate', 'Hospitality & food', 'Energy & utilities',
  'Manufacturing', 'Media & entertainment', 'Non-profit', 'Private clients',
];

// ---------------- helpers ----------------
const lateOf = (i) => daysBetween(i.dueDate, i.paidDate);
const toPay = (i) => Math.max(0, daysBetween(i.issueDate, i.paidDate));

/** Money owed to you at the end of a given day (invoices issued by then, not paid by then). */
function receivableOn(invs, day) {
  return sum(
    invs.filter((i) => i.status !== 'CANCELLED' && i.issueDate <= day && (!i.paidDate || i.paidDate > day) && (isOpen(i) || isPaid(i))),
    (i) => i.total,
  );
}

/** Days sales outstanding: receivables ÷ billing over the last 90 days × 90. */
function dsoOn(invs, day) {
  const billed = sum(invs.filter((i) => i.status !== 'CANCELLED' && i.issueDate > addDays(day, -90) && i.issueDate <= day), (i) => i.total);
  if (!billed) return null;
  return Math.round((receivableOn(invs, day) / billed) * 90);
}

/** Change between the last 3 full months and the 3 before, as a label + percent. */
function trendOf(recent, before) {
  if (!recent && !before) return { label: 'quiet', pct: null };
  if (!before) return { label: 'new', pct: null };
  if (!recent) return { label: 'stopped', pct: -100 };
  const pct = Math.round(((recent - before) / before) * 100);
  return { label: pct >= 15 ? 'growing' : pct <= -15 ? 'shrinking' : 'steady', pct };
}

// ---------------- the report ----------------
export function growthReport(today = isoDate()) {
  const cur = config.currency;
  const all = listInvoices().filter((i) => i.currency === cur && i.status !== 'CANCELLED' && i.status !== 'DRAFT');
  const yearAgo = addDays(today, -365);
  // full calendar months back from today (0 = this month, still in progress)
  const [ty, tm] = today.split('-').map(Number);
  const monthsAgo = (d) => ty * 12 + tm - (Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)));
  const inRecent = (d) => monthsAgo(d) >= 1 && monthsAgo(d) <= 3;
  const inBefore = (d) => monthsAgo(d) >= 4 && monthsAgo(d) <= 6;
  const year = all.filter((i) => i.issueDate > yearAgo);
  const yearRevenue = sum(year.filter(isPaid), (i) => i.total);
  const onPlan = new Set(listSchedules().filter((s) => s.active).map((s) => s.clientId));

  // ---- per client ----
  const clients = listClients()
    .map((c) => {
      const mine = all.filter((i) => i.clientId === c.id).sort((a, b) => a.issueDate.localeCompare(b.issueDate));
      if (!mine.length) return null;
      const mineYear = mine.filter((i) => i.issueDate > yearAgo);
      const paid = mine.filter(isPaid);
      const dates = mine.map((i) => i.issueDate);
      const gaps = dates.slice(1).map((d, k) => daysBetween(dates[k], d)).filter((g) => g > 0);
      const cadence = gaps.length ? Math.round(median(gaps)) : null;
      const last = dates.at(-1);
      const since = daysBetween(last, today);
      const first = dates[0];
      const value = sum(mineYear, (i) => i.total);
      const lateDays = paid.map(lateOf);
      const avgLate = lateDays.length ? Math.max(0, Math.round(avg(lateDays))) : null;
      const daysToPay = paid.length ? Math.round(avg(paid.map(toPay))) : null;
      const onTime = paid.length ? Math.round((paid.filter((i) => lateOf(i) <= 0).length / paid.length) * 100) : null;
      const openNow = mine.filter(isOpen);
      const overdue = sum(openNow.filter((i) => i.dueDate < today), (i) => i.total);
      const risk = clientStats(c.id, today).riskLabel;
      // when the next invoice would normally have come; overdue on that = slipping
      const expectedBack = cadence ? addDays(last, cadence) : null;
      const quietFor = cadence ? since - cadence : null;
      return {
        id: c.id,
        name: c.name,
        company: c.company || '',
        industry: c.industry || '',
        onPlan: onPlan.has(c.id),
        invoices: mine.length,
        invoicesYear: mineYear.length,
        value: r2(value),
        avgInvoice: r2(sum(mine, (i) => i.total) / mine.length),
        firstInvoice: first,
        lastInvoice: last,
        daysSinceLast: since,
        cadence,
        expectedBack,
        quietFor,
        avgLate,
        daysToPay,
        onTime,
        overdue: r2(overdue),
        risk,
      };
    })
    .filter(Boolean);

  // ---- segments ----
  const values = clients.map((c) => c.value).filter((v) => v > 0);
  const valueMedian = median(values) || 0;
  for (const c of clients) {
    const slowPayer = (c.avgLate ?? 0) >= 7 || c.risk === 'high';
    const highValue = c.value >= valueMedian && c.value > 0;
    let seg;
    if (daysBetween(c.firstInvoice, today) <= 75 && c.invoices <= 2) seg = 'new';
    else if (c.invoices === 1) seg = c.daysSinceLast > 120 ? 'lost' : 'oneoff';
    else if (c.cadence && c.quietFor > Math.max(21, c.cadence * 0.5) && !c.onPlan) seg = c.daysSinceLast > Math.max(180, c.cadence * 3) ? 'lost' : 'slipping';
    else if (highValue && slowPayer) seg = 'fix';
    else if (highValue && (c.onTime ?? 0) >= 70) seg = 'champion';
    else seg = 'loyal';
    c.segment = seg;
    // quadrant: value vs how fast they pay (days from invoice to money)
    c.quadrant = highValue ? (slowPayer ? 'fix_terms' : 'grow') : slowPayer ? 'rethink' : 'nurture';
  }
  const SEGMENTS = {
    champion: { label: 'Champions', help: 'High value, buy often, pay on time. Protect these.' },
    loyal: { label: 'Loyal', help: 'Come back regularly. Room to sell them more.' },
    fix: { label: 'Valuable but slow', help: 'Worth a lot, but pay late. Tighten terms, not the relationship.' },
    slipping: { label: 'Slipping away', help: 'Past the point they usually come back. A check-in now is cheap.' },
    new: { label: 'New', help: 'First invoices in the last 75 days.' },
    oneoff: { label: 'One-off', help: 'One job so far. A follow-up can turn them into repeat work.' },
    lost: { label: 'Gone quiet', help: 'No work for a long time.' },
  };
  const segments = Object.entries(SEGMENTS)
    .map(([key, s]) => {
      const members = clients.filter((c) => c.segment === key);
      return { key, ...s, count: members.length, value: r2(sum(members, (c) => c.value)), clients: members.map((c) => c.name) };
    })
    .filter((s) => s.count);

  // ---- industries ----
  const byInd = new Map();
  for (const c of clients) {
    const k = c.industry || 'Not set';
    const row = byInd.get(k) || { name: k, clients: [], invoices: [] };
    row.clients.push(c);
    row.invoices.push(...all.filter((i) => i.clientId === c.id));
    byInd.set(k, row);
  }
  const industries = [...byInd.values()]
    .map((r) => {
      const inYear = r.invoices.filter((i) => i.issueDate > yearAgo);
      const paid = r.invoices.filter(isPaid);
      const revenue = sum(inYear.filter(isPaid), (i) => i.total);
      const billed = sum(inYear, (i) => i.total);
      const recent = sum(r.invoices.filter((i) => inRecent(i.issueDate)), (i) => i.total);
      const before = sum(r.invoices.filter((i) => inBefore(i.issueDate)), (i) => i.total);
      const daysToPay = paid.length ? Math.round(avg(paid.map(toPay))) : null;
      const onTime = paid.length ? Math.round((paid.filter((i) => lateOf(i) <= 0).length / paid.length) * 100) : null;
      return {
        name: r.name,
        clients: r.clients.length,
        clientNames: r.clients.map((c) => c.name),
        revenue: r2(revenue),
        billed: r2(billed),
        share: 0, // filled below, as a share of everything billed
        perClient: r2(billed / r.clients.length),
        avgInvoice: inYear.length ? r2(billed / inYear.length) : null,
        daysToPay,
        onTime,
        trend: trendOf(recent, before),
      };
    })
    .sort((a, b) => b.billed - a.billed);
  const billedAll = sum(industries, (x) => x.billed) || 1;
  for (const x of industries) x.share = Math.round((x.billed / billedAll) * 100);
  // a simple, explainable score: yearly value per client, discounted by slow payment
  const indMax = Math.max(1, ...industries.map((x) => x.perClient));
  for (const x of industries) {
    const speed = x.onTime === null ? 0.5 : x.onTime / 100;
    x.score = Math.round(((x.perClient / indMax) * 0.6 + speed * 0.4) * 100);
  }
  const ranked = industries.filter((x) => x.name !== 'Not set' && x.billed > 0).sort((a, b) => b.score - a.score);
  for (const x of industries) {
    x.verdict =
      ranked.length >= 2 && x === ranked[0]
        ? 'focus'
        : x.onTime !== null && x.onTime < 50
          ? 'slow'
          : x.trend.label === 'shrinking'
            ? 'cooling'
            : x.trend.label === 'growing'
              ? 'rising'
              : 'steady';
  }

  // ---- work areas ----
  const byArea = new Map();
  const profession = normalType(config.businessType);
  for (const i of all) {
    for (const it of i.items || []) {
      if (it.lateFee) continue;
      const k = areaOf(it.name, profession);
      const amount = it.quantity * it.unitPrice;
      const row = byArea.get(k) || { name: k, lines: 0, amount: 0, recent: 0, before: 0, year: 0, buyers: new Map(), pay: [], examples: new Set() };
      row.lines += 1;
      row.amount += amount;
      if (i.issueDate > yearAgo) row.year += amount;
      if (inRecent(i.issueDate)) row.recent += amount;
      else if (inBefore(i.issueDate)) row.before += amount;
      row.buyers.set(i.clientId, (row.buyers.get(i.clientId) || 0) + 1);
      if (isPaid(i)) row.pay.push(toPay(i));
      if (row.examples.size < 3) row.examples.add(String(it.name).replace(/\s*(,|\(| - ).*$/, '').trim());
      byArea.set(k, row);
    }
  }
  const totalYear = sum([...byArea.values()], (r) => r.year) || 1;
  const areas = [...byArea.values()]
    .map((r) => ({
      name: r.name,
      recurring: isRecurringArea(r.name),
      lines: r.lines,
      revenue: r2(r.year),
      lifetime: r2(r.amount),
      share: Math.round((r.year / totalYear) * 100),
      avgLine: r2(r.amount / r.lines),
      clients: r.buyers.size,
      repeatClients: [...r.buyers.values()].filter((n) => n >= 2).length,
      daysToPay: r.pay.length ? Math.round(avg(r.pay)) : null,
      // a retainer moves with the plan, not with demand
      trend: isRecurringArea(r.name) ? { label: 'recurring', pct: null } : trendOf(r.recent, r.before),
      recent: r2(r.recent),
      before: r2(r.before),
      examples: [...r.examples],
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // ---- concentration ----
  const shares = clients.map((c) => (sum(values) ? c.value / sum(values) : 0)).sort((a, b) => b - a);
  const hhi = Math.round(sum(shares, (s) => (s * 100) ** 2));
  const top = [...clients].sort((a, b) => b.value - a.value);
  const concentration = {
    topClient: top[0] ? { name: top[0].name, share: Math.round((shares[0] || 0) * 100) } : null,
    top3Share: Math.round(sum(shares.slice(0, 3)) * 100),
    hhi,
    // the US DOJ bands for market concentration, borrowed as a plain-English scale
    label: hhi >= 2500 ? 'concentrated' : hhi >= 1500 ? 'moderate' : 'spread',
    clients: clients.filter((c) => c.value > 0).length,
  };

  // ---- DSO now vs 90 days ago ----
  const dso = { now: dsoOn(all, today), before: dsoOn(all, addDays(today, -90)) };
  dso.change = dso.now !== null && dso.before !== null ? dso.now - dso.before : null;
  dso.terms = Math.round(median(all.map((i) => daysBetween(i.issueDate, i.dueDate)).filter((d) => d >= 0)) || 0);

  // ---- opportunities: an amount only when it follows from the book ----
  const opportunities = [];
  const add = (o) => opportunities.push(o);
  let offers = [];
  try {
    offers = retainerOffers(today);
  } catch {
    offers = [];
  }
  for (const o of offers.slice(0, 2)) {
    add({
      kind: 'retainer',
      title: `Offer ${o.client} a monthly ${o.offer.word || 'plan'}`,
      body: `They already buy about monthly. A plan at ${fmtMoney(o.offer.price)}/month turns ${o.offer.invoicesNow} separate invoices a year into one predictable payment.`,
      amount: o.offer.yearChange > 0 ? o.offer.yearChange : null,
      amountLabel: o.offer.yearChange > 0 ? 'more a year' : null,
      basis: `${o.pattern.invoices} invoices in ${o.pattern.months} months`,
      link: { href: '/clients#offers', label: 'See the offer' },
    });
  }
  for (const c of clients.filter((x) => x.segment === 'slipping').sort((a, b) => b.value - a.value).slice(0, 2)) {
    add({
      kind: 'winback',
      title: `Check in with ${c.name}`,
      body: `They usually send work every ${c.cadence} days; it has been ${c.daysSinceLast}. A short "anything coming up?" note costs nothing.`,
      amount: c.value || null,
      amountLabel: c.value ? 'billed in the last year' : null,
      basis: `last invoice on ${new Date(c.lastInvoice + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`,
      link: { href: '/clients', label: 'Open client' },
    });
  }
  for (const c of clients.filter((x) => x.segment === 'fix').slice(0, 1)) {
    add({
      kind: 'terms',
      title: `Ask ${c.name} for a deposit`,
      body: `They are worth ${fmtMoney(c.value)} a year but pay ${c.avgLate} days late on average. A 30–50% deposit or an early-pay discount gets the money in sooner without losing the client.`,
      amount: null,
      basis: `${c.invoices} invoices, ${c.onTime ?? 0}% on time`,
      link: { href: '/new-invoice', label: 'New invoice' },
    });
  }
  const focus = ranked[0];
  if (focus && ranked.length >= 2) {
    add({
      kind: 'focus',
      title: `Find more ${focus.name} clients`,
      body: `Your ${focus.name} clients are worth ${fmtMoney(focus.perClient)} each a year and ${focus.onTime ?? 0}% of their invoices are paid on time${focus.daysToPay !== null ? `, in ${focus.daysToPay} days on average` : ''}. That is your best mix of value and speed.`,
      amount: null,
      basis: `${focus.clients} client${focus.clients === 1 ? '' : 's'}: ${focus.clientNames.join(', ')}`,
    });
  }
  // retainers grow by plan, not demand, so they are not a "lean into" signal
  const grow = areas.filter((a) => a.trend.label === 'growing' && a.revenue > 0 && !a.recurring).sort((a, b) => b.recent - a.recent)[0];
  if (grow) {
    add({
      kind: 'area',
      title: `Lean into ${grow.name.toLowerCase()}`,
      body: `Billing for this work rose ${grow.trend.pct}% in the last 3 full months compared with the 3 before (${fmtMoney(grow.recent)} vs ${fmtMoney(grow.before)}). Package it, put it first on your site, and quote it to existing clients.`,
      amount: null,
      basis: `${grow.lines} line item${grow.lines === 1 ? '' : 's'} from ${grow.clients} client${grow.clients === 1 ? '' : 's'}`,
    });
  }
  const priceArea = areas.find((a) => a.repeatClients >= 2 && a.revenue > 0 && !a.recurring);
  if (priceArea) {
    const extra = r2(priceArea.revenue * 0.1);
    add({
      kind: 'price',
      title: `Test a 10% higher price on ${priceArea.name.toLowerCase()}`,
      body: `${priceArea.repeatClients} clients have bought this more than once, a sign it is valued. At last year's volume, 10% more is ${fmtMoney(extra)}; try it on new quotes first.`,
      amount: extra,
      amountLabel: 'a year at the same volume',
      basis: `${fmtMoney(priceArea.revenue)} billed in the last year`,
    });
  }
  if (concentration.topClient && concentration.topClient.share >= 35) {
    add({
      kind: 'diversify',
      title: 'Spread your income',
      body: `${concentration.topClient.name} is ${concentration.topClient.share}% of last year's billing. Losing them would cut income by about that much. Aim to win one more client in ${focus ? focus.name : 'your best sector'} this quarter.`,
      amount: null,
      basis: `top 3 clients = ${concentration.top3Share}% of billing`,
    });
  }
  const oneoffs = clients.filter((c) => c.segment === 'oneoff');
  if (oneoffs.length) {
    add({
      kind: 'repeat',
      title: `Turn ${oneoffs.length === 1 ? oneoffs[0].name : `${oneoffs.length} one-off clients`} into repeat work`,
      body: `A thank-you with a small follow-up offer (an update, a second piece, a bundle) is the cheapest new business there is.`,
      amount: null,
      basis: oneoffs.map((c) => c.name).join(', '),
      link: { href: '/clients', label: 'Clients' },
    });
  }

  return {
    currency: cur,
    today,
    since: yearAgo,
    yearRevenue: r2(yearRevenue),
    yearBilled: r2(sum(year, (i) => i.total)),
    clients,
    segments,
    industries,
    areas,
    concentration,
    dso,
    opportunities,
    medianValue: r2(valueMedian),
  };
}

// ---------------- the plan ----------------
const CACHE_MS = 10 * 60 * 1000;
let planCache = null;

/** A short deterministic plan from the report, used when AI is off or fails. */
export function basicPlan(g) {
  // one step per kind of move, so the plan covers clients, sectors, work and cash flow
  const seen = new Set();
  const picked = [];
  for (const o of g.opportunities) {
    const kind = o.kind === 'price' || o.kind === 'area' ? 'work' : o.kind;
    if (seen.has(kind)) continue;
    seen.add(kind);
    picked.push(o);
  }
  const steps = picked.slice(0, 4).map((o) => `${o.title}. ${o.body.split(/(?<=\.)\s/)[0]}`);
  const focus = g.industries.find((x) => x.verdict === 'focus');
  const headline = focus
    ? `Your best clients are in ${focus.name}: grow there, keep retainers steady, and tighten terms for slow payers.`
    : 'Keep your best clients close, turn regular buyers into retainers, and tighten terms for slow payers.';
  return { headline, steps };
}

function planFacts(g) {
  return {
    currency: g.currency,
    lastYearBilled: g.yearBilled,
    segments: g.segments.map((s) => ({ segment: s.label, clients: s.clients, value: s.value })),
    industries: g.industries.map((x) => ({ industry: x.name, clients: x.clients, billed: x.billed, perClient: x.perClient, onTimePct: x.onTime, daysToPay: x.daysToPay, trend: x.trend })),
    workAreas: g.areas.map((a) => ({ area: a.name, billed: a.revenue, share: a.share, trend: a.trend, repeatClients: a.repeatClients })),
    concentration: g.concentration,
    dso: g.dso,
    opportunities: g.opportunities.map((o) => ({ title: o.title, amount: o.amount, basis: o.basis })),
  };
}

export async function growthPlan({ refresh = false } = {}, today = isoDate()) {
  const g = growthReport(today);
  const basic = basicPlan(g);
  if (!refresh && planCache && Date.now() - planCache.at < CACHE_MS) return { ...planCache.plan, cached: true };
  if (!llmAvailable()) return { source: 'rules', ...basic, note: 'AI is not configured, so this plan comes straight from your numbers.' };
  try {
    const { content } = await complete({
      system:
        'You are a practical growth advisor for a small service business. Plain US English, warm and direct. ' +
        'Use ONLY facts and numbers from the JSON; never invent figures, clients or market data. Name clients, industries and work areas.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `Data from the last 12 months of invoices:\n${JSON.stringify(planFacts(g))}\n\n` +
                'Write a 90-day growth plan. Reply in exactly this format:\n' +
                'HEADLINE: <one sentence, max 22 words: where to focus>\n' +
                '- <step 1, most valuable, specific, under 28 words>\n- <step 2>\n- <step 3>\n- <step 4>\n' +
                'Cover: which industry to pursue, which work to push or reprice, which clients to protect or win back, and one cash-flow fix. No other text.',
            },
          ],
        },
      ],
      maxTokens: 1500,
    });
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    const headline = /HEADLINE:\s*(.+)/i.exec(text)?.[1]?.trim() || null;
    const steps = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[-*•]\s+/.test(l))
      .map((l) => l.replace(/^[-*•]\s+/, ''));
    if (!headline || !steps.length) throw new Error('empty AI reply');
    const plan = { source: 'ai', headline, steps, generatedAt: new Date().toISOString() };
    planCache = { at: Date.now(), plan };
    return plan;
  } catch (e) {
    console.log(`  [growth] AI plan failed: ${e.message}`);
    return { source: 'rules', ...basic, note: 'The AI plan is unavailable right now, so this one comes straight from your numbers.' };
  }
}

/** Compact version for the assistant's get_growth_insights tool. */
export function growthSummary(today = isoDate()) {
  const g = growthReport(today);
  return {
    currency: g.currency,
    lastYearBilled: g.yearBilled,
    segments: g.segments.map(({ label, clients, value }) => ({ segment: label, clients, value })),
    industries: g.industries.map(({ name, clients, billed, perClient, onTime, daysToPay, trend, verdict }) => ({ name, clients, billed, perClient, onTimePct: onTime, daysToPay, trend: trend.label, verdict })),
    workAreas: g.areas.map(({ name, revenue, share, trend, repeatClients }) => ({ name, billedLastYear: revenue, share, trend: trend.label, trendPct: trend.pct, repeatClients })),
    concentration: g.concentration,
    dso: g.dso,
    opportunities: g.opportunities.map(({ title, amount, amountLabel, basis }) => ({ title, amount, amountLabel, basis })),
  };
}
