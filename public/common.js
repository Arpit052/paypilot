// Shared UI helpers: API calls, header, formatting, and the approval "slip" cards.
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/login')) {
    location.href = '/login.html';
    throw new Error('Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function money(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount || 0);
  } catch {
    return `${currency} ${Number(amount || 0).toFixed(2)}`;
  }
}

/** Sum a {CUR: amount} map into a display string, primary currency first. */
export function moneyMap(map, primary) {
  const entries = Object.entries(map || {});
  if (!entries.length) return money(0, primary);
  entries.sort(([a], [b]) => (a === primary ? -1 : b === primary ? 1 : 0));
  return entries.map(([c, v]) => money(v, c)).join(' + ');
}

export const RISK_TEXT = { none: 'No risk', low: 'Low', medium: 'Medium', high: 'High', new: 'New client' };

export function daysLateText(d) {
  if (d === null || d === undefined) return 'No history yet';
  if (d <= 0) return 'On time';
  return `${d} day${d === 1 ? '' : 's'} late`;
}

export function fmtDate(d) {
  if (!d) return '';
  return new Date(d.length === 10 ? d + 'T00:00:00Z' : d).toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Minimal, safe markdown: escape first, then **bold**, `code`, bullet lists, paragraphs. */
export function md(text) {
  const lines = esc(text).split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const li = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${li[1]}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (line.trim()) html += `<p>${line}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

/** Copy the PayPal link a client pays from (to paste in a text, email or WhatsApp). */
export async function copyPayLink(url) {
  const full = new URL(url, location.origin).href;
  try {
    await navigator.clipboard.writeText(full);
  } catch {
    const t = Object.assign(document.createElement('textarea'), { value: full });
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  toast('Pay link copied. Paste it in a text, email or WhatsApp to your client.');
}

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

export const LOGO = `<svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="ppg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset=".55" stop-color="#6366f1"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs><rect width="40" height="40" rx="11" fill="url(#ppg)"/><path d="M7.5 32.5C11 31 13.5 28 15.6 24.4" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="2.2" stroke-linecap="round" stroke-dasharray=".1 4.2"/><path d="M31.5 8.5 10 17.6l8.2 3.4 3.3 8.5z" fill="#fff"/><path d="M31.5 8.5 18.2 21l3.3 8.5z" fill="#c7d2fe"/></svg>`;

export let CONFIG = null;

const ICON = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
  followups: '<path d="M12 2v20"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  analytics: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  clients: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  new: '<path d="M12 5v14M5 12h14"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
};
export const icon = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;

const PAGES = [
  { key: 'dashboard', href: '/', label: 'Dashboard', group: 'Platform' },
  { key: 'chat', href: '/assistant', label: 'Assistant', group: 'Platform' },
  { key: 'followups', href: '/followups', label: 'Collections', group: 'Platform' },
  { key: 'calendar', href: '/calendar', label: 'Calendar', group: 'Platform' },
  { key: 'analytics', href: '/analytics', label: 'Analytics', group: 'Platform' },
  { key: 'clients', href: '/clients', label: 'Clients', group: 'Platform' },
  { key: 'settings', href: '/settings', label: 'Settings', group: 'System' },
];

export async function header(active) {
  CONFIG = await api('/api/config').catch(() => ({}));
  const pending = await api('/api/actions?status=pending').then((r) => r.actions.length).catch(() => 0);
  const pp = CONFIG.paypalMode === 'mock' ? 'Demo mode' : CONFIG.paypalMode === 'live' ? 'PayPal Live' : 'PayPal Sandbox';
  const ai = CONFIG.llmProvider === 'none' ? 'AI not set' : `AI · ${CONFIG.llmProvider}`;
  const biz = CONFIG.businessName || 'Your business';
  const initials = biz.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const navLink = (p) => {
    const badge = p.key === 'followups' && pending ? `<span class="sb-badge" title="${pending} waiting for approval">${pending}</span>` : '';
    return `<a class="sb-link" href="${p.href}" ${active === p.key ? 'aria-current="page"' : ''} data-tip="${esc(p.label)}">${icon(p.key)}<span class="sb-text">${esc(p.label)}</span>${badge}</a>`;
  };
  const group = (g) => `<div class="sb-label">${g}</div>${PAGES.filter((p) => p.group === g).map(navLink).join('')}`;
  const ap = CONFIG.autopilot;
  try {
    if (localStorage.getItem('pp-sb') === 'collapsed') document.body.classList.add('sb-collapsed');
  } catch {}
  document.body.classList.add('shell');

  const side = document.createElement('aside');
  side.className = 'sidebar';
  side.id = 'sidebar';
  side.innerHTML = `
    <div class="sb-top">
      <a class="brand" href="/" aria-label="PayPilot home">${LOGO}<span class="wordmark sb-text">PayPilot</span></a>
      <button class="sb-icon" id="sbToggle" aria-label="Toggle sidebar" title="Toggle sidebar">${icon('panel', 17)}</button>
    </div>
    <button class="sb-search" id="openSearch" aria-label="Search" data-tip="Search">${icon('search', 16)}<span class="sb-text">Search…</span><kbd class="sb-text">${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd></button>
    <a class="sb-new" href="/new-invoice" ${active === 'new' ? 'aria-current="page"' : ''} data-tip="New invoice">${icon('new', 17)}<span class="sb-text">New invoice</span></a>
    <nav class="sb-nav" aria-label="Main">${group('Platform')}${group('System')}</nav>
    <div class="sb-fill"></div>
    ${ap ? `<a class="sb-card" href="/followups" data-tip="Autopilot">
      <span class="sb-card-h">${icon('bolt', 15)}<span class="sb-text">Autopilot ${ap.enabled ? 'on' : 'off'}</span><i class="${ap.enabled ? 'on' : ''}"></i></span>
      <span class="sb-text sb-card-b">${ap.enabled ? (ap.next ? `Next: ${esc(ap.next.label.toLowerCase())} to ${esc(ap.next.client)}, ${esc(fmtDate(ap.next.date))}` : 'Watching your unpaid invoices') : 'Reminders are only drafted when you ask'}</span>
    </a>` : ''}
    ${CONFIG.loginEnabled ? `<button class="sb-link" id="logoutBtn" data-tip="Sign out">${icon('logout')}<span class="sb-text">Sign out</span></button>` : ''}
    <a class="sb-user" href="/settings" title="Business settings" data-tip="${esc(biz)}">
      <span class="sb-avatar">${esc(initials || 'P')}</span>
      <span class="sb-text sb-user-t"><b>${esc(biz)}</b><span>${esc(pp)} · ${esc(ai)}</span></span>
    </a>`;
  const bar = document.createElement('header');
  bar.className = 'topbar';
  const title = PAGES.find((p) => p.key === active)?.label || (active === 'new' ? 'New invoice' : '');
  bar.innerHTML = `
    <button class="sb-icon mobile-only" id="sbOpen" aria-label="Open menu">${icon('menu')}</button>
    <div class="crumb"><span class="muted">${esc(biz)}</span><span class="sep">/</span><b>${esc(title)}</b></div>
    <div class="modes">
      <span class="mode live-clock" id="liveClock" title="Current time (${esc(CONFIG.timezone || '')})"></span>
      ${CONFIG.demoTimeOffsetDays ? `<span class="mode warn" title="DEMO_TIME_OFFSET_DAYS">Clock +${CONFIG.demoTimeOffsetDays}d</span>` : ''}
      <a class="mode mode-link ${CONFIG.paypalMode === 'mock' ? 'warn' : 'ok'}" href="/settings#paypal" title="${CONFIG.paypalMode === 'mock' ? 'Demo mode: connect your PayPal in Settings' : 'Connected to PayPal'}"><i class="dot"></i>${esc(pp)}</a>
      <div class="bell-wrap">
        <button class="bell" id="bellBtn" aria-label="Notifications" aria-expanded="false" aria-haspopup="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 003.4 0"/></svg>
          <span class="bell-count hidden" id="bellCount"></span>
        </button>
        <div class="bell-panel hidden" id="bellPanel" role="dialog" aria-label="Notifications">
          <div class="bell-head"><b>Notifications</b><button class="linkbtn" id="markRead">Mark all as read</button></div>
          <div class="bell-summary" id="bellSummary"></div>
          <ul id="bellList"></ul>
        </div>
      </div>
    </div>`;
  const scrim = document.createElement('div');
  scrim.className = 'sb-scrim';
  document.body.prepend(side, scrim, bar);
  if (!CONFIG.businessName && active !== 'settings') {
    const nudge = document.createElement('div');
    nudge.className = 'nudge';
    nudge.innerHTML = 'Your invoices don\'t show a business name yet. <a href="/settings">Add it in Settings</a>';
    bar.after(nudge);
  }
  side.querySelector('#sbToggle').onclick = () => {
    if (window.matchMedia('(max-width: 900px)').matches) return document.body.classList.remove('sb-open');
    const c = document.body.classList.toggle('sb-collapsed');
    try { localStorage.setItem('pp-sb', c ? 'collapsed' : 'open'); } catch {}
  };
  bar.querySelector('#sbOpen').onclick = () => document.body.classList.add('sb-open');
  scrim.onclick = () => document.body.classList.remove('sb-open');
  side.querySelector('#openSearch').onclick = () => openSearch();
  startLiveClock(CONFIG.timezone);
  startNotifications();
  side.querySelector('#logoutBtn')?.addEventListener('click', async () => {
    await api('/api/logout', { body: {} }).catch(() => {});
    location.href = '/login.html';
  });
  return CONFIG;
}

// ------------------------------------------------------------------
// Search (Ctrl/⌘ K): pages, actions, clients and invoices in one box
// ------------------------------------------------------------------
let searchIndex = null;
async function loadIndex() {
  if (searchIndex) return searchIndex;
  const [inv, cl] = await Promise.all([api('/api/invoices').catch(() => ({ invoices: [] })), api('/api/clients').catch(() => ({ clients: [] }))]);
  searchIndex = { invoices: inv.invoices, clients: cl.clients };
  return searchIndex;
}
const ACTIONS = [
  { label: 'New invoice', hint: 'Create and send through PayPal', href: '/new-invoice', ic: 'new' },
  { label: 'Ask the Assistant', hint: 'Bill a client in plain words', href: '/assistant', ic: 'chat' },
  { label: 'Chase late invoices', hint: 'Collections', href: '/followups', ic: 'followups' },
  { label: 'Export invoices (CSV)', hint: 'For your accountant', href: '/api/invoices.csv', ic: 'analytics' },
  { label: 'Autopilot plan', hint: 'Settings', href: '/settings#autopilot', ic: 'settings' },
];

function searchResults(q, idx) {
  const t = q.trim().toLowerCase();
  const out = [];
  const has = (...xs) => xs.some((x) => String(x || '').toLowerCase().includes(t));
  if (!t) {
    out.push({ section: 'Jump to', items: PAGES.map((p) => ({ label: p.label, hint: p.group, href: p.href, ic: p.key })) });
    out.push({ section: 'Actions', items: ACTIONS });
    return out;
  }
  const pages = PAGES.filter((p) => has(p.label)).map((p) => ({ label: p.label, hint: 'Page', href: p.href, ic: p.key }));
  const acts = ACTIONS.filter((a) => has(a.label, a.hint));
  const clients = idx.clients.filter((c) => has(c.name, c.company, c.email)).slice(0, 5).map((c) => ({ label: c.name, hint: [c.company, c.email].filter(Boolean).join(' · '), href: `/clients#${c.id}`, ic: 'clients' }));
  const invoices = idx.invoices
    .filter((i) => has(i.number, `#${i.number}`, i.client, i.reference, ...(i.items || []).map((x) => x.name)))
    .slice(0, 6)
    .map((i) => ({ label: `#${i.number} · ${i.client}`, hint: `${money(i.total, i.currency)} · ${(i.displayStatus || i.status).toLowerCase().replace(/_/g, ' ')}`, href: `/?inv=${i.id}`, ic: 'followups' }));
  if (invoices.length) out.push({ section: 'Invoices', items: invoices });
  if (clients.length) out.push({ section: 'Clients', items: clients });
  if (pages.length || acts.length) out.push({ section: 'Pages & actions', items: [...pages, ...acts] });
  out.push({ section: 'Ask AI', items: [{ label: `Ask the Assistant: “${q.trim()}”`, hint: 'Enter', href: `/assistant?ask=${encodeURIComponent(q.trim())}`, ic: 'chat' }] });
  return out;
}

export async function openSearch() {
  if (document.getElementById('cmdk')) return;
  const box = document.createElement('div');
  box.id = 'cmdk';
  box.innerHTML = `<div class="cmdk-scrim"></div><div class="cmdk" role="dialog" aria-label="Search">
    <div class="cmdk-in">${icon('search', 17)}<input id="cmdkQ" placeholder="Search invoices, clients, pages… or ask AI" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
    <div class="cmdk-list" id="cmdkList" role="listbox"></div></div>`;
  document.body.append(box);
  const input = box.querySelector('#cmdkQ');
  const list = box.querySelector('#cmdkList');
  let flat = [];
  let sel = 0;
  const close = () => box.remove();
  const render = async () => {
    const idx = await loadIndex();
    const groups = searchResults(input.value, idx);
    flat = groups.flatMap((g) => g.items);
    sel = Math.min(sel, flat.length - 1);
    let n = 0;
    list.innerHTML = groups
      .map((g) => `<div class="cmdk-sec">${esc(g.section)}</div>${g.items.map((it) => `<a class="cmdk-item ${n === sel ? 'sel' : ''}" data-i="${n++}" href="${esc(it.href)}">${icon(it.ic, 16)}<span>${esc(it.label)}</span><em>${esc(it.hint || '')}</em></a>`).join('')}`)
      .join('');
  };
  box.querySelector('.cmdk-scrim').onclick = close;
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
      list.querySelectorAll('.cmdk-item').forEach((el) => el.classList.toggle('sel', Number(el.dataset.i) === sel));
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && flat[sel]) location.href = flat[sel].href;
  });
  await render();
  input.focus();
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.getElementById('cmdk') ? document.getElementById('cmdk').remove() : openSearch();
  }
});

// ------------------------------------------------------------------
// Notifications: bell + dropdown, live updates over Server-Sent Events
// ------------------------------------------------------------------
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const NOTE_ICON = {
  payment: svg('<path d="M12 2v20"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  approval: svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  import: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  overdue: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  due: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
};
const NOTE_CTA = { payment: 'View', approval: 'Review', import: 'See invoices', overdue: 'Chase it', due: 'Open' };
const noteIcon = (k) => NOTE_ICON[k] || svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>');
let notes = [];
let unread = 0;
let summary = null;

function isToday(iso) {
  const d = new Date(iso), n = new Date();
  return d.toDateString() === n.toDateString();
}

function renderBell() {
  const count = document.getElementById('bellCount');
  count.textContent = unread > 9 ? '9+' : String(unread);
  count.classList.toggle('hidden', !unread);
  const paid = Object.entries(summary?.paidThisWeek || {});
  document.getElementById('bellSummary').innerHTML = summary
    ? `<a class="bs" href="/dashboard"><span>Paid this week</span><b>${paid.length ? paid.map(([c, v]) => esc(money(v, c))).join(' + ') : esc(money(0, CONFIG?.currency || 'USD'))}</b></a>
       <a class="bs" href="/followups"><span>Overdue</span><b class="${summary.overdue ? 'bad' : ''}">${summary.overdue}</b></a>
       <a class="bs" href="/followups"><span>To approve</span><b class="${summary.waiting ? 'warn' : ''}">${summary.waiting}</b></a>`
    : '';
  const item = (n) => `<li class="${n.read ? '' : 'unread'} k-${esc(n.kind)}"><a href="${esc(n.link || '#')}" data-note="${n.id}">
      <span class="ni">${noteIcon(n.kind)}</span>
      <span class="nt"><b>${esc(n.title)}</b><span>${esc(n.body || '')}</span><time>${ago(n.at)}</time></span>
      <span class="ncta">${esc(NOTE_CTA[n.kind] || 'Open')}</span></a></li>`;
  const today = notes.filter((n) => isToday(n.at));
  const earlier = notes.filter((n) => !isToday(n.at));
  document.getElementById('bellList').innerHTML = notes.length
    ? (today.length ? `<li class="ngroup">Today</li>${today.map(item).join('')}` : '') + (earlier.length ? `<li class="ngroup">Earlier</li>${earlier.map(item).join('')}` : '')
    : `<li class="empty-note"><b>You're all caught up.</b><br>Payments, late invoices and drafts waiting for you will show up here.</li>`;
}

async function refreshBell() {
  try {
    const r = await api('/api/notifications');
    notes = r.notifications;
    unread = r.unread;
    summary = r.summary;
  } catch {
    /* ignore */
  }
  renderBell();
}

async function startNotifications() {
  const btn = document.getElementById('bellBtn');
  const panel = document.getElementById('bellPanel');
  await refreshBell();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
    if (open) refreshBell();
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== btn) {
      panel.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  document.getElementById('markRead').addEventListener('click', async () => {
    const r = await api('/api/notifications/read', { body: {} });
    unread = r.unread;
    notes = notes.map((n) => ({ ...n, read: true }));
    renderBell();
  });
  document.getElementById('bellList').addEventListener('click', (e) => {
    const a = e.target.closest('[data-note]');
    if (a) api('/api/notifications/read', { body: { id: a.dataset.note } }).catch(() => {});
  });

  if (!window.EventSource) return;
  const es = new EventSource('/api/events');
  es.addEventListener('notification', (ev) => {
    const n = JSON.parse(ev.data);
    notes = [n, ...notes.filter((x) => x.id !== n.id)].slice(0, 40);
    unread += 1;
    renderBell();
    popToast(n);
    btn.classList.remove('ring');
    void btn.offsetWidth;
    btn.classList.add('ring');
    refreshBell();
    window.dispatchEvent(new CustomEvent('pp:notification', { detail: n }));
  });
}

function popToast(n) {
  const t = document.createElement('div');
  t.className = `note-toast ${n.kind}`;
  t.setAttribute('role', 'status');
  t.innerHTML = `<span class="ni k-${esc(n.kind)}">${noteIcon(n.kind)}</span><span><b>${esc(n.title)}</b><br>${esc(n.body || '')}</span>${n.link ? `<a class="ncta" href="${esc(n.link)}">${esc(NOTE_CTA[n.kind] || 'Open')}</a>` : ''}`;
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 5200);
  setTimeout(() => t.remove(), 5600);
}

// ------------------------------------------------------------------
// Live clock in the top bar (business time zone), ticking every second
// ------------------------------------------------------------------
export function startLiveClock(timeZone) {
  const el = document.getElementById('liveClock');
  if (!el) return;
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  }
  // friendlier zone abbreviation where the US locale only knows "GMT+5:30" (e.g. IST)
  let zone = '';
  try {
    zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
    if (/^GMT[+-]/.test(zone)) {
      const alt = new Intl.DateTimeFormat('en-IN', { timeZone, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
      if (alt && !/^GMT/.test(alt)) zone = alt;
    }
  } catch {
    /* keep default */
  }
  const tick = () => {
    const parts = fmt.formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    el.innerHTML = `${get('weekday')}, ${get('month')} ${get('day')} · <b class="clock-time">${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod')}</b> ${zone || get('timeZoneName')}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ------------------------------------------------------------------
// Approval slips
// ------------------------------------------------------------------
const STAMP = { create_invoice: 'SENT', send_reminder: 'REMINDED', cancel_invoice: 'VOID', create_schedule: 'SCHEDULED', add_late_fee: 'FEE ADDED' };

/**
 * Render an approval card for an action. `onDone(action)` fires after approve/reject.
 */
export function renderSlip(action, { onDone, onGone } = {}) {
  const el = document.createElement('article');
  el.className = 'slip';
  el.dataset.id = action.id;
  const p = action.payload;
  const cur = p.currency || CONFIG?.currency || 'USD';

  if (action.type === 'create_invoice') {
    el.innerHTML = `
      <div class="slip-head">
        <div><div class="slip-kind">${action.origin === 'schedule' ? 'Recurring invoice draft' : 'Invoice draft'}</div><div class="slip-from">from ${esc(CONFIG?.businessName || 'your business')} · via PayPal</div></div>
        <div class="slip-from num">${esc(cur)}</div>
      </div>
      <div class="row2">
        <div><label>Bill to</label><input data-f="clientName" value="${esc(p.clientName)}" aria-label="Client name"></div>
        <div><label>Client email</label><input data-f="clientEmail" type="email" value="${esc(p.clientEmail)}" aria-label="Client email"></div>
      </div>
      <table class="items">
        <thead><tr><th>Work</th><th class="q">Qty</th><th class="p">Rate</th><th class="amt">Amount</th><th class="x"></th></tr></thead>
        <tbody></tbody>
      </table>
      <button class="add-line" type="button">+ Add line</button>
      <div class="row2">
        <div><label>Due date</label><input data-f="dueDate" type="date" value="${esc(p.dueDate)}"></div>
        <div><label>Note to client</label><input data-f="note" value="${esc(p.note)}" placeholder="Optional"></div>
      </div>
      <div class="row2">
        <div><label>Sales tax %</label><input data-f="taxPercent" class="num" type="number" min="0" max="50" step="0.01" value="${esc(p.taxPercent || 0)}"></div>
        <div><label>Deposit due upfront (${esc(cur)})</label><input data-f="depositAmount" class="num" type="number" min="0" step="0.01" value="${esc(p.depositAmount || 0)}" placeholder="0 = none"></div>
      </div>
      <div class="sums num">
        <div><span>Subtotal</span><span data-sub></span></div>
        <div data-taxrow><span>Sales tax</span><span data-tax></span></div>
      </div>
      <div class="total"><span>Total due</span><b class="num" data-total></b></div>
      <div class="deposit-line num" data-deprow></div>
      ${p.risk && ['medium', 'high'].includes(p.risk.label) ? `<div class="risk ${p.risk.label}">This client has ${p.risk.label} payment risk${p.risk.avgDaysLate ? ` and usually pays ${p.risk.avgDaysLate} days late` : ''}.${p.depositSuggested ? ' A 50% deposit was added so you get paid part upfront. Set it to 0 to remove it.' : ' Consider a shorter due date or a deposit.'}</div>` : ''}
      <div class="slip-actions">
        <button class="btn" data-approve>Approve &amp; send via PayPal</button>
        <button class="btn ghost" data-reject>Discard</button>
      </div>
      <div class="slip-error" role="alert"></div>
      <div class="slip-result"></div>`;
    const tbody = el.querySelector('tbody');
    const addRow = (it = { name: '', quantity: 1, unitPrice: 0 }) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input data-i="name" value="${esc(it.name)}" aria-label="Item"></td>
        <td class="q"><input data-i="quantity" class="num" type="number" min="0" step="any" value="${esc(it.quantity)}" aria-label="Quantity"></td>
        <td class="p"><input data-i="unitPrice" class="num" type="number" min="0" step="any" value="${esc(it.unitPrice)}" aria-label="Rate"></td>
        <td class="amt num"></td>
        <td class="x"><button type="button" aria-label="Remove line">×</button></td>`;
      tr.querySelector('.x button').onclick = () => { tr.remove(); recalc(); };
      tbody.append(tr);
    };
    const items = () =>
      [...tbody.rows].map((tr) => ({
        name: tr.querySelector('[data-i=name]').value,
        quantity: Number(tr.querySelector('[data-i=quantity]').value),
        unitPrice: Number(tr.querySelector('[data-i=unitPrice]').value),
      }));
    const r2 = (n) => Math.round(n * 100) / 100;
    const recalc = () => {
      let sub = 0;
      let tax = 0;
      const pct = Number(el.querySelector('[data-f=taxPercent]').value) || 0;
      [...tbody.rows].forEach((tr, i) => {
        const it = items()[i];
        const a = r2((it.quantity || 0) * (it.unitPrice || 0));
        sub += a;
        tax += r2((a * pct) / 100);
        tr.querySelector('.amt').textContent = money(a, cur);
      });
      el.querySelector('[data-sub]').textContent = money(sub, cur);
      el.querySelector('[data-tax]').textContent = money(tax, cur);
      el.querySelector('[data-taxrow]').classList.toggle('hidden', !pct);
      el.querySelector('[data-total]').textContent = money(sub + tax, cur);
      const dep = Number(el.querySelector('[data-f=depositAmount]').value) || 0;
      el.querySelector('[data-deprow]').textContent = dep > 0 ? `${money(dep, cur)} due upfront, ${money(Math.max(sub + tax - dep, 0), cur)} by the due date` : '';
    };
    p.items.forEach(addRow);
    el.querySelector('.add-line').onclick = () => { addRow(); recalc(); };
    el.addEventListener('input', recalc);
    recalc();
    el._edits = () => ({
      clientName: el.querySelector('[data-f=clientName]').value,
      clientEmail: el.querySelector('[data-f=clientEmail]').value,
      dueDate: el.querySelector('[data-f=dueDate]').value,
      note: el.querySelector('[data-f=note]').value,
      taxPercent: Number(el.querySelector('[data-f=taxPercent]').value) || 0,
      depositAmount: Number(el.querySelector('[data-f=depositAmount]').value) || 0,
      depositPercent: 0,
      items: items(),
    });
  } else if (action.type === 'create_schedule') {
    el.innerHTML = `
      <div class="slip-head">
        <div><div class="slip-kind">Recurring invoice</div><div class="slip-from">${esc(p.clientName)} · ${esc(p.clientEmail)}</div></div>
        <span class="pill SCHEDULED">${esc(p.frequency)}</span>
      </div>
      <table class="items">
        <thead><tr><th>Work</th><th class="q">Qty</th><th class="amt">Amount</th></tr></thead>
        <tbody>${p.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="q num">${esc(it.quantity)}</td><td class="amt num">${money(it.quantity * it.unitPrice, cur)}</td></tr>`).join('')}</tbody>
      </table>
      <div class="total"><span>Per invoice${p.taxPercent ? ` (incl. ${esc(p.taxPercent)}% tax)` : ''}</span><b class="num">${money(p.total, cur)}</b></div>
      <div class="row2">
        <div><label>First invoice on</label><input data-f="startDate" type="date" value="${esc(p.startDate)}"></div>
        <div><label>Payment terms (days)</label><input data-f="dueInDays" class="num" type="number" min="0" max="90" value="${esc(p.dueInDays)}"></div>
      </div>
      <div class="slip-meta" style="margin-top:10px">Each ${p.frequency === 'weekly' ? 'week' : 'month'} a new invoice draft appears in your approval tray. Nothing is sent without your approval.</div>
      <div class="slip-actions">
        <button class="btn" data-approve>Approve schedule</button>
        <button class="btn ghost" data-reject>Discard</button>
      </div>
      <div class="slip-error" role="alert"></div>
      <div class="slip-result"></div>`;
    el._edits = () => ({ startDate: el.querySelector('[data-f=startDate]').value, dueInDays: Number(el.querySelector('[data-f=dueInDays]').value) });
  } else if (action.type === 'send_reminder') {
    el.innerHTML = `
      <div class="slip-head">
        <div><div class="slip-kind">Payment reminder</div>
          <div class="slip-from">Invoice #${esc(p.number)} · ${esc(p.client)} · ${money(p.amount, cur)}${p.daysOverdue ? ` · ${p.daysOverdue} days overdue` : ''}</div></div>
        <span class="pill ${esc(p.tone)}">${esc(p.tone)}</span>
      </div>
      <label>Subject</label><input data-f="subject" value="${esc(p.subject)}">
      <label>Message</label><textarea data-f="message">${esc(String(p.message || "").replace(/\\n/g, "\n"))}</textarea>
      ${p.draftedBy === 'template' ? '<div class="slip-meta muted">Drafted from a template because the AI was unavailable. Edit it as you like.</div>' : ''}
      <div class="slip-actions">
        <button class="btn" data-approve>Send reminder via PayPal</button>
        <button class="btn ghost" data-reject>Discard</button>
      </div>
      <div class="slip-error" role="alert"></div>
      <div class="slip-result"></div>`;
    el._edits = () => ({ subject: el.querySelector('[data-f=subject]').value, message: el.querySelector('[data-f=message]').value });
  } else if (action.type === 'add_late_fee') {
    el.innerHTML = `
      <div class="slip-head">
        <div><div class="slip-kind">Late fee</div>
          <div class="slip-from">Invoice #${esc(p.number)} · ${esc(p.client)}${p.daysOverdue ? ` · ${p.daysOverdue} days overdue` : ''}</div></div>
        <span class="pill final">late fee</span>
      </div>
      <div class="sums num">
        <div><span>Current total</span><span>${money(p.amount, cur)}</span></div>
        <div><span>Late fee <input data-f="percent" class="num fee-pct" type="number" min="0.5" max="25" step="0.5" value="${esc(p.percent)}" aria-label="Late fee percent">%</span><span data-fee></span></div>
      </div>
      <div class="total"><span>New total</span><b class="num" data-newtotal></b></div>
      <div class="slip-meta" style="margin-top:10px">Added as a separate line (no tax) on the PayPal invoice. PayPal emails your client the updated invoice.</div>
      <div class="slip-actions">
        <button class="btn" data-approve>Add late fee via PayPal</button>
        <button class="btn ghost" data-reject>Waive it</button>
      </div>
      <div class="slip-error" role="alert"></div>
      <div class="slip-result"></div>`;
    const pctIn = el.querySelector('[data-f=percent]');
    const recalcFee = () => {
      const fee = Math.round(p.amount * (Number(pctIn.value) || 0)) / 100;
      el.querySelector('[data-fee]').textContent = '+' + money(fee, cur);
      el.querySelector('[data-newtotal]').textContent = money(Math.round((p.amount + fee) * 100) / 100, cur);
    };
    pctIn.addEventListener('input', recalcFee);
    recalcFee();
    el._edits = () => ({ percent: Number(pctIn.value) });
  } else {
    el.innerHTML = `
      <div class="slip-head"><div><div class="slip-kind">Cancel invoice #${esc(p.number)}</div>
        <div class="slip-from">${esc(p.client)} · ${money(p.amount, cur)}</div></div></div>
      <label>Reason sent to client</label><input data-f="reason" value="${esc(p.reason)}" placeholder="Optional">
      <div class="slip-actions">
        <button class="btn danger" data-approve>Cancel invoice</button>
        <button class="btn ghost" data-reject>Keep it</button>
      </div>
      <div class="slip-error" role="alert"></div>
      <div class="slip-result"></div>`;
    el._edits = () => ({ reason: el.querySelector('[data-f=reason]').value });
  }

  const errBox = el.querySelector('.slip-error');
  if (action.error) errBox.textContent = action.error;
  const markDone = (a) => {
    el.classList.add('done');
    if (a.status === 'rejected') {
      el.classList.add('rejected');
      el.querySelector('.slip-result').textContent = a.type === 'add_late_fee' ? 'Waived. PayPilot won\'t suggest a fee for this invoice again.' : 'Discarded.';
      return;
    }
    const s = document.createElement('div');
    s.className = 'stamp' + (a.type === 'cancel_invoice' ? ' void' : '');
    s.textContent = STAMP[a.type];
    el.append(s);
    const r = a.result || {};
    el.querySelector('.slip-result').innerHTML =
      a.type === 'create_schedule'
        ? `Recurring ${esc(r.frequency)} invoice scheduled. First draft on <b>${esc(fmtDate(r.nextRun))}</b>.`
        : a.type === 'create_invoice'
        ? `Invoice <b>#${esc(r.number)}</b> sent through PayPal.${r.payerUrl ? ` <button class="linkbtn" data-copylink="${esc(r.payerUrl)}" title="Paste it in a text or WhatsApp. Clients pay faster from a direct link.">Copy pay link</button>` : ''}`
        : a.type === 'send_reminder'
          ? `Reminder sent for invoice <b>#${esc(r.number)}</b>.`
          : a.type === 'add_late_fee'
          ? `Late fee of <b>${money(r.fee, cur)}</b> added. Invoice <b>#${esc(r.number)}</b> is now ${money(r.newTotal, cur)}.`
          : `Invoice <b>#${esc(r.number)}</b> cancelled.`;
    if (r.notice) el.querySelector('.slip-result').insertAdjacentHTML('beforeend', `<div class="slip-notice">${esc(r.notice)}</div>`);
  };

  // after Send/Discard: show the result for a moment, then fold the slip away
  const leave = () => {
    setTimeout(() => {
      el.style.height = el.offsetHeight + 'px';
      el.classList.add('leaving');
      requestAnimationFrame(() => (el.style.height = '0px'));
      setTimeout(() => {
        el.remove();
        onGone?.(action);
      }, 520);
    }, 1500);
  };

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copylink]');
    if (b) copyPayLink(b.dataset.copylink);
  });
  if (action.status !== 'pending') markDone(action);

  el.querySelector('[data-approve]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    errBox.textContent = '';
    try {
      const { action: a } = await api(`/api/actions/${action.id}/approve`, { body: { edits: el._edits() } });
      markDone(a);
      onDone?.(a);
      leave();
    } catch (err) {
      errBox.textContent = err.message;
      btn.disabled = false;
      if (/no longer exists/.test(err.message)) leave();
    }
  });
  el.querySelector('[data-reject]')?.addEventListener('click', async () => {
    try {
      const { action: a } = await api(`/api/actions/${action.id}/reject`, { body: {} });
      markDone(a);
      onDone?.(a);
      leave();
    } catch (err) {
      errBox.textContent = err.message;
    }
  });
  return el;
}

// ------------------------------------------------------------------
// Invoice drawer: details + a timeline of everything that happened to it
// ------------------------------------------------------------------
const PAID_ST = ['PAID', 'MARKED_AS_PAID'];
const OPEN_ST = ['SENT', 'UNPAID', 'PARTIALLY_PAID'];
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/** Ordered events for one invoice, built from its saved history. */
export function invoiceTimeline(inv, today) {
  const ev = [];
  const cur = inv.currency;
  ev.push({
    at: inv.issueDate,
    icon: '✉️',
    title: inv.source === 'import' ? 'Created on PayPal' : inv.source === 'seed' ? 'Invoice issued' : 'Sent through PayPal',
    sub: `${money(inv.total - (inv.items || []).filter((i) => i.lateFee).reduce((s, i) => s + i.unitPrice, 0), cur)} to ${inv.client || 'client'}${inv.depositAmount ? ` · ${money(inv.depositAmount, cur)} deposit requested upfront` : ''}`,
  });
  (inv.reminders || []).forEach((r, n) =>
    ev.push({ at: r.at, icon: '🔔', title: `${r.tone ? r.tone[0].toUpperCase() + r.tone.slice(1) : 'Payment'} reminder sent`, sub: r.subject || `Reminder ${n + 1}` })
  );
  (inv.items || []).filter((i) => i.lateFee).forEach((i) => ev.push({ at: i.addedAt || today, icon: '⏰', cls: 'late', title: `${i.name} added`, sub: `+${money(i.unitPrice, cur)}, new total ${money(inv.total, cur)}` }));
  const paid = PAID_ST.includes(inv.status);
  if (paid && inv.paidDate) {
    const late = dayDiff(inv.dueDate, inv.paidDate);
    ev.push({ at: inv.paidDate, icon: '💰', cls: 'paid', title: `Paid ${money(inv.total, cur)}`, sub: late > 0 ? `${late} day${late === 1 ? '' : 's'} after the due date` : 'On time 🎉' });
  }
  if (inv.status === 'PARTIALLY_PAID') ev.push({ at: today, icon: '💵', cls: 'paid', title: 'Deposit received', sub: 'Part of this invoice has been paid' });
  if (inv.status === 'CANCELLED') ev.push({ at: null, icon: '✖', cls: 'late', title: 'Invoice cancelled', sub: '' });
  if (!paid && inv.status !== 'CANCELLED') {
    if (inv.dueDate < today) ev.push({ at: inv.dueDate, icon: '!', cls: 'late', title: 'Payment due date passed', sub: `${dayDiff(inv.dueDate, today)} days overdue` });
    else ev.push({ at: inv.dueDate, icon: '⏳', cls: 'future', title: inv.dueDate === today ? 'Due today' : 'Payment due', sub: inv.dueDate === today ? '' : `in ${dayDiff(today, inv.dueDate)} day${dayDiff(today, inv.dueDate) === 1 ? '' : 's'}` });
  }
  const order = (e) => (e.cls === 'future' ? '9999' : e.at || '9998');
  return ev.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

let drawerEls = null;
export function closeInvoiceDrawer() {
  if (!drawerEls) return;
  const [back, dr] = drawerEls;
  back.classList.remove('open');
  dr.classList.remove('open');
  setTimeout(() => { back.remove(); dr.remove(); }, 260);
  drawerEls = null;
}

// ------------------------------------------------------------------
// "Mark paid": two clicks, so a payment is never recorded by accident
// ------------------------------------------------------------------
export const markPaidButton = (id, label = 'Mark paid') => `<button class="btn ghost small mark-paid" data-markpaid="${esc(id)}">${label}</button>`;
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-markpaid]');
  if (!b) return;
  e.stopPropagation();
  if (!b.classList.contains('sure')) {
    document.querySelectorAll('.mark-paid.sure').forEach((x) => { x.classList.remove('sure'); x.textContent = 'Mark paid'; });
    b.classList.add('sure');
    b.textContent = 'Yes, it\'s paid';
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.classList.remove('sure'); b.textContent = 'Mark paid'; }, 4000);
    return;
  }
  b.disabled = true;
  b.textContent = 'Saving…';
  const form = b.closest('[data-paidform]');
  const body = form ? { method: form.querySelector('[name=method]')?.value, date: form.querySelector('[name=date]')?.value } : {};
  try {
    const r = await api(`/api/invoices/${encodeURIComponent(b.dataset.markpaid)}/mark-paid`, { body });
    toast(`Invoice #${r.number} marked as paid`);
    closeInvoiceDrawer();
    window.dispatchEvent(new CustomEvent('pp:changed'));
  } catch (err) {
    toast(err.message);
    b.disabled = false;
    b.classList.remove('sure');
    b.textContent = 'Mark paid';
  }
}, true);

/** Slide-in panel for one invoice. `opts.onSimulatePay(paypalId)` for demo mode. */
export function openInvoiceDrawer(inv, { today, mock = false, onSimulatePay } = {}) {
  closeInvoiceDrawer();
  const cur = inv.currency;
  const back = document.createElement('div');
  back.className = 'drawer-back';
  const dr = document.createElement('aside');
  dr.className = 'drawer';
  dr.setAttribute('role', 'dialog');
  dr.setAttribute('aria-label', `Invoice ${inv.number}`);
  const status = inv.displayStatus || inv.status;
  const label = status === 'OVERDUE' ? 'Overdue' : status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
  const lines = (inv.items || []).map((it) => `<tr class="${it.lateFee ? 'fee' : ''}"><td>${esc(it.name)}${it.quantity !== 1 ? ` × ${esc(it.quantity)}` : ''}</td><td>${money(it.quantity * it.unitPrice, cur)}</td></tr>`).join('');
  const taxable = (inv.items || []).filter((i) => !i.noTax).reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const isOpen = OPEN_ST.includes(inv.status);
  const ask = (q) => `/assistant?ask=${encodeURIComponent(q)}`;
  dr.innerHTML = `
    <button class="x" aria-label="Close">✕</button>
    <div class="dr-num">Invoice #${esc(inv.number)} · <span class="pill ${esc(status)}">${esc(label)}</span></div>
    <div class="dr-amt num">${money(inv.total, cur)}</div>
    <div class="dr-who">${esc(inv.client || '')}${inv.clientEmail ? ` · ${esc(inv.clientEmail)}` : ''}${inv.reference ? ` · Ref ${esc(inv.reference)}` : ''}</div>
    <table class="dr-lines"><tbody>${lines}${inv.taxPercent ? `<tr><td>Sales tax (${esc(inv.taxPercent)}%)</td><td>${money(Math.round(taxable * inv.taxPercent) / 100, cur)}</td></tr>` : ''}</tbody></table>
    <div class="dr-actions">
      ${isOpen && inv.payerUrl ? `<button class="btn small" data-copylink="${esc(inv.payerUrl)}">Copy pay link</button>` : ''}
      ${isOpen && mock && inv.paypalId ? `<button class="btn ghost small" data-sim title="Demo only: pretend the client paid through PayPal">Simulate PayPal payment</button>` : ''}
      ${isOpen ? `<a class="btn ghost small" href="${ask(`Draft a reminder for invoice #${inv.number}`)}">Draft a reminder</a>` : ''}
      ${isOpen && status === 'OVERDUE' && !(inv.items || []).some((i) => i.lateFee) ? `<a class="btn ghost small" href="${ask(`Add a late fee to invoice #${inv.number}`)}">Add late fee</a>` : ''}
    </div>
    ${isOpen ? `<div class="paid-form" data-paidform>
      <b>Got paid another way?</b>
      <span class="muted">Bank transfer, cash or cheque. ${mock ? '' : 'PayPilot records it on the PayPal invoice too.'}</span>
      <div class="pf-row">
        <select name="method" aria-label="How you were paid"><option value="bank">Bank transfer</option><option value="cash">Cash</option><option value="check">Cheque</option><option value="card">Card</option><option value="other">Other</option></select>
        <input type="date" name="date" value="${esc(today || '')}" max="${esc(today || '')}" aria-label="Payment date">
        ${markPaidButton(inv.id)}
      </div>
    </div>` : ''}
    <h3 style="margin:0 0 14px;font-size:15px">Timeline</h3>
    <ol class="timeline">${invoiceTimeline(inv, today)
      .map((e) => `<li class="${e.cls || ''}"><span class="tdot" aria-hidden="true">${e.icon}</span><div><b>${esc(e.title)}</b>${e.at ? `<time>${fmtDate(e.at)}</time>` : ''}${e.sub ? `<div class="tsub">${esc(e.sub)}</div>` : ''}</div></li>`)
      .join('')}</ol>`;
  document.body.append(back, dr);
  drawerEls = [back, dr];
  requestAnimationFrame(() => { back.classList.add('open'); dr.classList.add('open'); });
  back.onclick = closeInvoiceDrawer;
  dr.querySelector('.x').onclick = closeInvoiceDrawer;
  dr.querySelector('.x').focus();
  dr.querySelector('[data-copylink]')?.addEventListener('click', (e) => copyPayLink(e.currentTarget.dataset.copylink));
  dr.querySelector('[data-sim]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await onSimulatePay?.(inv.paypalId);
    closeInvoiceDrawer();
  });
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeInvoiceDrawer());

