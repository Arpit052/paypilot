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

export const RISK_TEXT = { none: 'No risk', low: 'Low', medium: 'Medium', high: 'High' };

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

export async function header(active) {
  CONFIG = await api('/api/config').catch(() => ({}));
  const pending = await api('/api/actions?status=pending').then((r) => r.actions.length).catch(() => 0);
  const link = (href, label, key, extra = '') =>
    `<a href="${href}" ${active === key ? 'aria-current="page"' : ''}>${label}${extra}</a>`;
  const pp = CONFIG.paypalMode === 'mock' ? 'Mock' : CONFIG.paypalMode === 'live' ? 'Live' : 'Sandbox';
  const ai = CONFIG.llmProvider === 'none' ? 'not set' : CONFIG.llmProvider;
  const el = document.createElement('header');
  el.className = 'topbar';
  el.innerHTML = `
    <a class="brand" href="/" aria-label="PayPilot home">${LOGO}<span class="wordmark">PayPilot</span></a>
    <nav class="nav" aria-label="Main">
      ${link('/', 'Assistant', 'chat')}
      ${link('/dashboard', 'Dashboard', 'dashboard')}
      ${link('/followups', 'Follow-ups', 'followups', pending ? `<span class="badge" title="${pending} waiting for approval">${pending}</span>` : '')}
      ${link('/clients', 'Clients', 'clients')}
      <a href="/new-invoice" class="nav-cta" ${active === 'new' ? 'aria-current="page"' : ''}>+ New invoice</a>
    </nav>
    <div class="modes">
      <span class="mode live-clock" id="liveClock" title="Current time (${esc(CONFIG.timezone || '')})"></span>
      <div class="bell-wrap">
        <button class="bell" id="bellBtn" aria-label="Notifications" aria-expanded="false" aria-haspopup="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 003.4 0"/></svg>
          <span class="bell-count hidden" id="bellCount"></span>
        </button>
        <div class="bell-panel hidden" id="bellPanel" role="dialog" aria-label="Notifications">
          <div class="bell-head"><b>Notifications</b><button class="linkbtn" id="markRead">Mark all as read</button></div>
          <ul id="bellList"></ul>
        </div>
      </div>
      <span class="mode ${CONFIG.paypalMode === 'mock' ? 'warn' : ''}" title="PayPal environment">PayPal: <b>${pp}</b></span>
      <span class="mode ${ai === 'not set' ? 'warn' : ''}" title="AI provider">AI: <b>${esc(ai)}</b></span>
      ${CONFIG.demoTimeOffsetDays ? `<span class="mode warn" title="DEMO_TIME_OFFSET_DAYS">Clock +${CONFIG.demoTimeOffsetDays}d</span>` : ''}
      ${CONFIG.loginEnabled ? '<button class="mode" id="logoutBtn" style="background:none;cursor:pointer">Sign out</button>' : ''}
    </div>`;
  document.body.prepend(el);
  startLiveClock(CONFIG.timezone);
  startNotifications();
  el.querySelector('#logoutBtn')?.addEventListener('click', async () => {
    await api('/api/logout', { body: {} }).catch(() => {});
    location.href = '/login.html';
  });
  return CONFIG;
}

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
const NOTE_ICON = { payment: '💰', approval: '📝' };
let notes = [];
let unread = 0;

function renderBell() {
  const count = document.getElementById('bellCount');
  count.textContent = unread > 9 ? '9+' : String(unread);
  count.classList.toggle('hidden', !unread);
  document.getElementById('bellList').innerHTML = notes.length
    ? notes
        .map(
          (n) => `<li class="${n.read ? '' : 'unread'}"><a href="${esc(n.link || '#')}" data-note="${n.id}">
            <span class="ni">${NOTE_ICON[n.kind] || '🔔'}</span>
            <span class="nt"><b>${esc(n.title)}</b><span>${esc(n.body || '')}</span><time>${ago(n.at)}</time></span></a></li>`
        )
        .join('')
    : '<li class="empty-note">No notifications yet. You\'ll be told here the moment a client pays.</li>';
}

async function startNotifications() {
  const btn = document.getElementById('bellBtn');
  const panel = document.getElementById('bellPanel');
  try {
    const r = await api('/api/notifications');
    notes = r.notifications;
    unread = r.unread;
  } catch {
    /* ignore */
  }
  renderBell();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
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
    notes = [n, ...notes.filter((x) => x.id !== n.id)].slice(0, 30);
    unread += 1;
    renderBell();
    popToast(n);
    window.dispatchEvent(new CustomEvent('pp:notification', { detail: n }));
  });
}

function popToast(n) {
  const t = document.createElement('div');
  t.className = `note-toast ${n.kind}`;
  t.setAttribute('role', 'status');
  t.innerHTML = `<span class="ni">${NOTE_ICON[n.kind] || '🔔'}</span><span><b>${esc(n.title)}</b><br>${esc(n.body || '')}</span>`;
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
const STAMP = { create_invoice: 'SENT', send_reminder: 'REMINDED', cancel_invoice: 'VOID', create_schedule: 'SCHEDULED' };

/**
 * Render an approval card for an action. `onDone(action)` fires after approve/reject.
 */
export function renderSlip(action, { onDone } = {}) {
  const el = document.createElement('article');
  el.className = 'slip';
  el.dataset.id = action.id;
  const p = action.payload;
  const cur = p.currency || CONFIG?.currency || 'USD';

  if (action.type === 'create_invoice') {
    el.innerHTML = `
      <div class="slip-head">
        <div><div class="slip-kind">${action.origin === 'schedule' ? 'Recurring invoice draft' : 'Invoice draft'}</div><div class="slip-from">from ${esc(CONFIG?.businessName || '')} · via PayPal</div></div>
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
      <label>Message</label><textarea data-f="message">${esc(p.message)}</textarea>
      ${p.draftedBy === 'template' ? '<div class="slip-meta muted">Drafted from a template because the AI was unavailable. Edit it as you like.</div>' : ''}
      <div class="slip-actions">
        <button class="btn" data-approve>Send reminder via PayPal</button>
        <button class="btn ghost" data-reject>Discard</button>
      </div>
      <div class="slip-error" role="alert"></div>
      <div class="slip-result"></div>`;
    el._edits = () => ({ subject: el.querySelector('[data-f=subject]').value, message: el.querySelector('[data-f=message]').value });
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
      el.querySelector('.slip-result').textContent = 'Discarded.';
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
        ? `Invoice <b>#${esc(r.number)}</b> sent through PayPal.${r.payerUrl ? ` <a href="${esc(r.payerUrl)}" target="_blank" rel="noopener">Open client's payment page</a>` : ''}`
        : a.type === 'send_reminder'
          ? `Reminder sent for invoice <b>#${esc(r.number)}</b>.`
          : `Invoice <b>#${esc(r.number)}</b> cancelled.`;
  };

  if (action.status !== 'pending') markDone(action);

  el.querySelector('[data-approve]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    errBox.textContent = '';
    try {
      const { action: a } = await api(`/api/actions/${action.id}/approve`, { body: { edits: el._edits() } });
      markDone(a);
      onDone?.(a);
    } catch (err) {
      errBox.textContent = err.message;
      btn.disabled = false;
    }
  });
  el.querySelector('[data-reject]')?.addEventListener('click', async () => {
    try {
      const { action: a } = await api(`/api/actions/${action.id}/reject`, { body: {} });
      markDone(a);
      onDone?.(a);
    } catch (err) {
      errBox.textContent = err.message;
    }
  });
  return el;
}
