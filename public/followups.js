import { api, header, esc, renderSlip, toast, fmtDate, money, copyPayLink, markPaidButton, openInvoiceDrawer } from './common.js';

const $ = (id) => document.getElementById(id);
const cfg = await header('followups');

let data = null; // /api/collections: unpaid invoices with their reminder plan
let invoices = []; // every invoice
let drafts = []; // invoice drafts waiting for approval
let schedules = [];
let receipts = new Map();
let tab = new URLSearchParams(location.search).get('tab') || 'needs';
let q = '';

const TONE = { friendly: 'Friendly', firm: 'Firm', final: 'Final' };
const entries = (m) => Object.entries(m || {});
const moneyMap = (m) => (entries(m).length ? entries(m).map(([c, v]) => money(v, c)).join(' + ') : money(0, cfg.currency || 'USD'));
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const dayLabel = (iso) => (iso === data.today ? 'today' : fmtDate(iso));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const HELP = {
  needs: 'Reminders that are due or written and waiting for your OK, and invoice drafts to approve.',
  waiting: 'Sent and not paid yet. Nothing to do: PayPilot reminds the client on schedule and tells you when it is paid.',
  upcoming: 'Invoices that will go out by themselves: retainers and other recurring work. Each one waits for your OK first.',
  paid: 'Paid invoices, newest first, with how early or late each one came in and whether the receipt has been sent.',
};

function dueText(c) {
  if (c.daysLate > 0) return `<span class="st ${c.stage}"><i></i>${plural(c.daysLate, 'day')} late</span>`;
  if (c.daysLate === 0) return '<span class="st due"><i></i>Due today</span>';
  return `<span class="st ok"><i></i>Due in ${plural(-c.daysLate, 'day')}</span>`;
}
const needsYou = (c) => c.actionable && (c.drafts.length > 0 || c.plan.next?.state === 'due' || c.plan.next?.state === 'waiting');

function nextLine(c, inv) {
  const bits = [];
  if (c.lastContact) bits.push(`${TONE[c.lastContact.tone] || 'Reminder'} reminder sent ${dayLabel(c.lastContact.at)}`);
  const n = c.plan.next;
  if (n && n.state === 'planned') bits.push(`next: ${n.label.toLowerCase()} ${dayLabel(n.date)}`);
  if (inv?.expected?.date) bits.push(`expected around ${fmtDate(inv.expected.date)}`);
  return bits.join(' · ');
}

function unpaidRow(c, mode) {
  const inv = invoices.find((i) => i.id === c.id);
  const draft = c.drafts.find((d) => d.type === 'send_reminder') || c.drafts[0];
  let act = '';
  let why = '';
  if (!c.actionable) act = '<span class="muted small">other PayPal account</span>';
  else if (draft) {
    act = `<button class="btn small" data-review="${esc(draft.id)}">Review ${draft.type === 'add_late_fee' ? 'late fee' : 'reminder'}</button>`;
    why = `${draft.type === 'add_late_fee' ? 'Late fee' : `${TONE[draft.tone] || ''} reminder`} written, waiting for your OK`;
  } else if (mode === 'needs') {
    act = `<button class="btn small" data-draft="${esc(c.id)}" data-kind="reminder">${c.daysLate > 0 ? 'Write reminder' : 'Send heads-up'}</button>`;
    why = `${c.plan.next?.label || 'Reminder'} is due${c.lastContact ? ` · last one sent ${dayLabel(c.lastContact.at)}` : ''}`;
  } else {
    why = nextLine(c, inv);
  }
  return `<div class="ivrow" data-inv="${esc(c.id)}" tabindex="0">
    <span class="avatar" aria-hidden="true">${esc(initials(c.client))}</span>
    <span class="iv-who"><b>${esc(c.client)}</b><span>${esc(c.company || c.email)}</span></span>
    <span class="iv-work"><span class="iv-l1"><span class="mono">#${esc(c.number)}</span> ${esc(c.work)}</span><em>${esc(why)}</em></span>
    <span class="iv-st">${dueText(c)}</span>
    <span class="iv-amt">${esc(money(c.total, c.currency))}${c.status === 'PARTIALLY_PAID' ? '<em>part paid</em>' : ''}</span>
    <span class="iv-act">${act}
      <span class="more"><button class="sb-icon" data-menu aria-label="More actions">⋯</button>
        <span class="menu hidden">
          ${c.payerUrl ? `<button data-copy="${esc(c.payerUrl)}">Copy pay link</button>` : ''}
          <a href="/client-view?inv=${esc(c.id)}">How your client sees it</a>
          ${mode !== 'needs' && c.actionable && !draft ? `<button data-draft="${esc(c.id)}" data-kind="reminder">Write a reminder now</button>` : ''}
          ${c.lateFeeEligible ? `<button data-draft="${esc(c.id)}" data-kind="late_fee">Add ${data.lateFee.percent}% late fee</button>` : ''}
          <button data-open="${esc(c.id)}">Open invoice</button>
          ${c.actionable ? markPaidButton(c.id) : ''}
        </span></span>
    </span>
  </div>`;
}

function draftRow(a) {
  const p = a.payload;
  const total = (p.items || []).reduce((t, i) => t + i.quantity * i.unitPrice, 0) * (1 + (p.taxPercent || 0) / 100);
  return `<div class="ivrow">
    <span class="avatar" aria-hidden="true">${esc(initials(p.clientName))}</span>
    <span class="iv-who"><b>${esc(p.clientName)}</b><span>${esc(p.company || p.clientEmail || '')}</span></span>
    <span class="iv-work">${esc((p.items || []).map((i) => i.name).join(', '))}<em>Invoice draft${p.scheduleId ? ' from a recurring plan' : ''}, not sent yet</em></span>
    <span class="iv-st"><span class="st plan"><i></i>Draft</span></span>
    <span class="iv-amt">${esc(money(total, p.currency || cfg.currency))}</span>
    <span class="iv-act"><a class="btn small" href="/assistant">Review draft</a></span>
  </div>`;
}

function scheduleRow(s) {
  const next = s.upcoming?.[0] || s.nextRun;
  return `<div class="ivrow">
    <span class="avatar" aria-hidden="true">${esc(initials(s.client))}</span>
    <span class="iv-who"><b>${esc(s.client)}</b><span>${esc(s.company || s.email)}</span></span>
    <span class="iv-work">${esc(s.items.map((i) => i.name).join(', '))}<em>${s.frequency === 'weekly' ? 'Every week' : 'Every month'} · ${s.invoicesSent} sent so far · ${esc(money(s.perYear, s.currency))} a year</em></span>
    <span class="iv-st"><span class="st plan"><i></i>Goes out ${esc(fmtDate(next))}</span></span>
    <span class="iv-amt">${esc(money(s.total, s.currency))}</span>
    <span class="iv-act"><a class="btn ghost small" href="/clients#retainers">Manage</a></span>
  </div>`;
}

function paidRow(i) {
  const late = i.paidLateDays;
  const when = late === null || late === undefined ? '' : late < 0 ? `${plural(-late, 'day')} early` : late === 0 ? 'on time' : `${plural(late, 'day')} late`;
  const r = receipts.get(i.id);
  const rText = !r ? '' : r.status === 'auto' ? 'receipt by PayPal' : r.status === 'needed' ? '<b class="warn-t">receipt to send</b>' : r.status === 'viewed' ? 'receipt opened' : 'receipt sent';
  return `<div class="ivrow" data-inv="${esc(i.id)}" tabindex="0">
    <span class="avatar" aria-hidden="true">${esc(initials(i.client))}</span>
    <span class="iv-who"><b>${esc(i.client)}</b><span>${esc(i.clientEmail || '')}</span></span>
    <span class="iv-work"><span class="iv-l1"><span class="mono">#${esc(i.number)}</span> ${esc(i.items.map((x) => x.name).join(', '))}</span><em>${[when, rText].filter(Boolean).join(' · ')}</em></span>
    <span class="iv-st"><span class="st paid"><i></i>Paid ${esc(fmtDate(i.paidDate))}</span></span>
    <span class="iv-amt">${esc(money(i.total, i.currency))}</span>
    <span class="iv-act">${r && r.status === 'needed' ? `<a class="btn small" href="/receipts?inv=${esc(i.id)}">Send receipt</a>` : ''}</span>
  </div>`;
}

const match = (...fields) => !q || fields.join(' ').toLowerCase().includes(q);

function sets() {
  const unpaid = data.cards;
  const paid = invoices.filter((i) => i.paidDate && ['PAID', 'MARKED_AS_PAID'].includes(i.status)).sort((a, b) => b.paidDate.localeCompare(a.paidDate));
  return {
    needs: [...unpaid.filter(needsYou).map((c) => ['u', c]), ...drafts.map((a) => ['d', a])],
    waiting: unpaid.filter((c) => !needsYou(c)).sort((a, b) => b.daysLate - a.daysLate).map((c) => ['w', c]),
    upcoming: schedules.filter((s) => s.active).map((s) => ['s', s]),
    paid: paid.map((i) => ['p', i]),
  };
}

function renderStats() {
  const t = data.totals;
  const late = {};
  for (const k of ['late', 'later', 'critical']) for (const [c, v] of entries(t[k])) late[c] = Math.round(((late[c] || 0) + v) * 100) / 100;
  const lateN = data.counts.late + data.counts.later + data.counts.critical;
  const monthStart = `${data.today.slice(0, 7)}-01`;
  const paidMonth = invoices.filter((i) => i.paidDate && i.paidDate >= monthStart && ['PAID', 'MARKED_AS_PAID'].includes(i.status));
  const paidSum = {};
  for (const i of paidMonth) paidSum[i.currency] = Math.round(((paidSum[i.currency] || 0) + i.total) * 100) / 100;
  const expected = {};
  for (const i of invoices) if (i.expected && i.expected.within30) expected[i.currency] = (expected[i.currency] || 0) + i.total * (i.expected.within30 / 100);
  $('stats').innerHTML = `
    <div><span>Unpaid</span><b>${esc(moneyMap(t.owed))}</b><em>${plural(data.cards.length, 'invoice')}</em></div>
    <div><span>Overdue</span><b class="${lateN ? 'bad' : ''}">${esc(moneyMap(late))}</b><em>${lateN ? `${lateN} past the due date` : 'nothing late'}</em></div>
    <div><span>Likely in 30 days</span><b>${esc(moneyMap(expected))}</b><em>from how each client pays</em></div>
    <div><span>Paid this month</span><b>${esc(moneyMap(paidSum))}</b><em>${plural(paidMonth.length, 'invoice')}</em></div>`;
}

function renderList() {
  const S = sets();
  for (const b of document.querySelectorAll('#tabs button')) {
    const k = b.dataset.t;
    b.setAttribute('aria-selected', String(k === tab));
    b.querySelector('span').textContent = S[k].length || '';
  }
  $('tabHelp').textContent = HELP[tab];
  const rows = S[tab].filter(([kind, x]) =>
    kind === 'd' ? match(x.payload.clientName, ...(x.payload.items || []).map((i) => i.name)) : kind === 's' ? match(x.client, ...x.items.map((i) => i.name)) : kind === 'p' ? match(x.client, x.number, ...x.items.map((i) => i.name)) : match(x.client, x.company, x.number, x.work),
  );
  const shown = tab === 'paid' ? rows.slice(0, 60) : rows;
  const html = shown.map(([kind, x]) => (kind === 'd' ? draftRow(x) : kind === 's' ? scheduleRow(x) : kind === 'p' ? paidRow(x) : unpaidRow(x, tab))).join('');
  const empty = {
    needs: `<div class="list-empty ok"><b>Nothing needs you</b><span>${data.cards.length ? `${plural(data.cards.length, 'invoice')} awaiting payment, all on schedule.` : 'No unpaid invoices.'}</span></div>`,
    waiting: '<div class="list-empty"><b>Nothing awaiting payment</b><span>Invoices you send show up here until they are paid.</span></div>',
    upcoming: '<div class="list-empty"><b>No recurring invoices</b><span>Set up a retainer from Clients, or ask the Assistant to bill someone every month.</span></div>',
    paid: '<div class="list-empty"><b>No paid invoices yet</b><span>Paid invoices land here with their receipt.</span></div>',
  }[tab];
  $('list').innerHTML = shown.length
    ? `<div class="ivrow head"><span></span><span>Client</span><span>Work</span><span>Status</span><span class="r">Amount</span><span></span></div>${html}${rows.length > shown.length ? `<p class="muted small" style="padding:12px 20px">Showing the latest ${shown.length}. Search to find older ones.</p>` : ''}`
    : q
      ? '<div class="list-empty"><b>No matches</b><span>Try another name or number.</span></div>'
      : empty;
  $('chaseAll').classList.toggle('hidden', !data.cards.some((c) => c.daysLate > 0 && c.actionable && !c.drafts.length && c.plan.next?.state === 'due'));
}

function renderRail() {
  const until = new Date(Date.parse(`${data.today}T12:00:00Z`) + 14 * 864e5).toISOString().slice(0, 10);
  const up = data.comingUp.filter((x) => x.date <= until).slice(0, 7);
  $('railSub').textContent = data.autopilot.enabled ? 'next 14 days' : 'Autopilot is off';
  if (!data.autopilot.enabled) {
    $('rail').innerHTML = `<li class="rail-empty">Reminders are written only when you ask. Turn Autopilot on in <a href="/settings#autopilot">Settings</a>.</li>`;
    return;
  }
  const groups = [];
  for (const x of up) {
    const g = groups.at(-1);
    g && g.date === x.date ? g.items.push(x) : groups.push({ date: x.date, items: [x] });
  }
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  $('rail').innerHTML = groups.length
    ? groups
        .map((g) => `<li><span class="rd">${esc(cap(dayLabel(g.date)))}</span>${g.items.map((x) => `<div class="ri ${esc(x.tone)}"><i></i><span><b>${esc(x.client)}</b><span>${esc(x.label)} · <span class="mono">#${esc(x.number)}</span>${x.state === 'waiting' ? ' · <em>ready</em>' : ''}</span></span></div>`).join('')}</li>`)
        .join('')
    : '<li class="rail-empty">No reminders planned in the next two weeks.</li>';
}

async function load() {
  const [col, inv, act, sch, rec] = await Promise.all([
    api('/api/collections'),
    api('/api/invoices'),
    api('/api/actions?status=pending'),
    api('/api/schedules'),
    api('/api/receipts').catch(() => ({ receipts: [] })),
  ]);
  data = col;
  invoices = inv.invoices;
  drafts = act.actions.filter((a) => a.type === 'create_invoice');
  schedules = sch.schedules;
  receipts = new Map(rec.receipts.map((r) => [r.invoiceId, r]));
  renderStats();
  renderList();
  renderRail();
}

// ---------------- interactions ----------------
function openDrawer(action) {
  $('drawerTitle').textContent = action.type === 'add_late_fee' ? `Late fee · #${action.payload.number}` : `${TONE[action.payload.tone] || ''} reminder · #${action.payload.number}`;
  $('drawerBody').innerHTML = '';
  $('drawerBody').append(
    renderSlip(action, {
      onDone: (a) => {
        if (a.status === 'approved') toast(a.type === 'add_late_fee' ? 'Late fee added on PayPal' : 'Reminder sent through PayPal');
        closeDrawer();
        load();
      },
      onGone: closeDrawer,
    })
  );
  $('drawer').classList.remove('hidden');
}
function closeDrawer() {
  $('drawer').classList.add('hidden');
  $('drawerBody').innerHTML = '';
}
$('drawer').addEventListener('click', (e) => e.target.closest('[data-close]') && closeDrawer());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());
document.addEventListener('click', (e) => {
  if (!e.target.closest('.more')) document.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
});

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  tab = b.dataset.t;
  history.replaceState(null, '', tab === 'needs' ? location.pathname : `?tab=${tab}`);
  renderList();
});
$('q').addEventListener('input', () => {
  q = $('q').value.trim().toLowerCase();
  renderList();
});

$('list').addEventListener('click', async (e) => {
  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) {
    const m = menuBtn.nextElementSibling;
    const open = m.classList.contains('hidden');
    document.querySelectorAll('.menu').forEach((x) => x.classList.add('hidden'));
    m.classList.toggle('hidden', !open);
    return;
  }
  const cp = e.target.closest('[data-copy]');
  if (cp) return copyPayLink(cp.dataset.copy);
  if (e.target.closest('[data-markpaid]') || e.target.closest('a')) return;
  const op = e.target.closest('[data-open]');
  const rev = e.target.closest('[data-review]');
  const btn = e.target.closest('[data-draft]');
  if (rev) {
    const { actions } = await api('/api/actions?status=pending');
    const a = actions.find((x) => x.id === rev.dataset.review);
    return a ? openDrawer(a) : load();
  }
  if (btn) {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = btn.dataset.kind === 'late_fee' ? 'Calculating…' : 'Writing…';
    try {
      const { action } = await api('/api/followups/draft', { body: { invoiceId: btn.dataset.draft, kind: btn.dataset.kind } });
      await load();
      openDrawer(action);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = label;
    }
    return;
  }
  const r = op ? op.dataset.open : e.target.closest('button, .menu') ? null : e.target.closest('[data-inv]')?.dataset.inv;
  const inv = r && invoices.find((i) => i.id === r);
  if (inv) openInvoiceDrawer(inv, { today: data.today, mock: cfg.paypalMode === 'mock', onSimulatePay: async (pid) => { await api(`/api/mock/pay/${pid}`, { body: {} }); load(); } });
});

$('chaseAll').onclick = async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = 'Writing reminders…';
  try {
    const { created } = await api('/api/followups/scan', { body: {} });
    toast(created.length ? `${plural(created.length, 'draft')} ready to review` : 'Every late invoice already has a draft or a recent reminder');
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Draft reminders for all late';
  }
};

window.addEventListener('pp:notification', load);
window.addEventListener('pp:changed', load);
await load();
const deep = new URLSearchParams(location.search).get('inv');
if (deep) {
  const inv = invoices.find((i) => i.id === deep);
  if (inv) openInvoiceDrawer(inv, { today: data.today, mock: cfg.paypalMode === 'mock' });
}
