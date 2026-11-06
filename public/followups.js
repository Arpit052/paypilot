import { api, header, esc, renderSlip, toast, fmtDate, money, copyPayLink, markPaidButton, openInvoiceDrawer } from './common.js';

const $ = (id) => document.getElementById(id);
const cfg = await header('followups');

let data = null;
let invoices = [];
let tab = 'attention';
const TONE = { friendly: 'Friendly', firm: 'Firm', final: 'Final' };
const entries = (m) => Object.entries(m || {});
const moneyMap = (m) => (entries(m).length ? entries(m).map(([c, v]) => money(v, c)).join(' + ') : money(0, cfg.currency || 'USD'));
const sumMaps = (...ms) => {
  const out = {};
  for (const m of ms) for (const [c, v] of entries(m)) out[c] = Math.round(((out[c] || 0) + v) * 100) / 100;
  return out;
};
const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const dayLabel = (iso) => (iso === data.today ? 'Today' : fmtDate(iso));

function status(c) {
  if (c.daysLate > 0) return `<span class="st ${c.stage}"><i></i>${c.daysLate} day${c.daysLate === 1 ? '' : 's'} late</span>`;
  if (c.daysLate === 0) return '<span class="st due"><i></i>Due today</span>';
  return `<span class="st ok"><i></i>Due in ${-c.daysLate} day${c.daysLate === -1 ? '' : 's'}</span>`;
}

// three short bars: friendly / firm / final
function progress(c) {
  if (!c.plan.steps.length) return '<span class="muted small">—</span>';
  const word = { done: 'sent', waiting: 'draft ready', due: 'due now', planned: 'planned', skipped: 'skipped' };
  const tip = c.plan.steps.map((s) => `${TONE[s.tone]}: ${word[s.state]}${s.state === 'planned' ? ` ${dayLabel(s.date)}` : ''}`).join(' · ');
  const next = c.plan.next;
  const label = c.drafts.length ? 'Draft ready' : next ? `${TONE[next.tone]} · ${next.state === 'due' ? 'due now' : dayLabel(next.date)}` : c.lastContact ? `${TONE[c.lastContact.tone]} sent` : '—';
  return `<span class="prog" title="${esc(tip)}"><span class="bars">${c.plan.steps.map((s) => `<i class="b-${s.state}"></i>`).join('')}</span><span class="pl">${esc(label)}</span></span>`;
}

function action(c) {
  if (!c.actionable) return '<span class="muted small">other account</span>';
  const draft = c.drafts.find((d) => d.type === 'send_reminder') || c.drafts[0];
  if (draft) return `<button class="btn small" data-review="${esc(draft.id)}">Review ${draft.type === 'add_late_fee' ? 'late fee' : 'reminder'}</button>`;
  return `<button class="btn ghost small" data-draft="${esc(c.id)}" data-kind="reminder">${c.daysLate > 0 ? 'Write reminder' : 'Send heads-up'}</button>`;
}

function row(c) {
  return `<div class="crow" data-inv="${esc(c.id)}" tabindex="0">
    <span class="avatar" aria-hidden="true">${esc(initials(c.client))}</span>
    <span class="cr-who"><b>${esc(c.client)}</b><span>${esc(c.company || c.email)}</span></span>
    <span class="cr-work"><span class="mono">#${esc(c.number)}</span> ${esc(c.work)}</span>
    <span class="cr-st">${status(c)}${progress(c)}</span>
    <span class="cr-amt">${esc(money(c.total, c.currency))}${c.status === 'PARTIALLY_PAID' ? '<em>part paid</em>' : ''}</span>
    <span class="cr-act">${action(c)}
      <span class="more"><button class="sb-icon" data-menu aria-label="More actions">⋯</button>
        <span class="menu hidden">
          ${c.payerUrl ? `<button data-copy="${esc(c.payerUrl)}">Copy pay link</button>` : ''}
          ${c.lateFeeEligible ? `<button data-draft="${esc(c.id)}" data-kind="late_fee">Add ${data.lateFee.percent}% late fee</button>` : ''}
          <button data-open="${esc(c.id)}">Open invoice</button>
          ${c.actionable ? markPaidButton(c.id) : ''}
        </span></span>
    </span>
  </div>`;
}

function renderStats() {
  const t = data.totals;
  const late = sumMaps(t.late, t.later, t.critical);
  const lateN = data.counts.late + data.counts.later + data.counts.critical;
  const sp = data.speed;
  $('stats').innerHTML = `
    <div><span>Outstanding</span><b>${esc(moneyMap(t.owed))}</b><em>${data.cards.length} unpaid</em></div>
    <div><span>Late</span><b class="${lateN ? 'bad' : ''}">${esc(moneyMap(late))}</b><em>${lateN ? `${lateN} past due` : 'nothing late'}</em></div>
    <div><span>Due this week</span><b>${esc(moneyMap(data.dueThisWeek))}</b><em>not late yet</em></div>
    <div><span>Time to get paid</span><b>${sp.avgDaysToGetPaid != null ? `${sp.avgDaysToGetPaid} days` : '—'}</b><em>${sp.onTimeRate != null ? `${sp.onTimeRate}% on time` : 'on average'}</em></div>
    <div><span>Waiting for you</span><b>${data.waiting}</b><em>draft${data.waiting === 1 ? '' : 's'} to approve</em></div>`;
}

function renderList() {
  const needs = (c) => c.daysLate >= -1 || c.drafts.length || c.plan.next?.state === 'due';
  const sets = {
    attention: data.cards.filter(needs),
    upcoming: data.cards.filter((c) => !needs(c)),
    all: data.cards,
  };
  for (const b of document.querySelectorAll('#tabs button')) {
    const k = b.dataset.t;
    b.setAttribute('aria-selected', String(k === tab));
    b.querySelector('span').textContent = k === 'sent' ? data.recent.length || '' : sets[k].length || '';
  }
  if (tab === 'sent') {
    $('list').innerHTML = data.recent.length
      ? `<div class="sent-rows">${data.recent
          .map(
            (r) => `<div class="srow"><span class="pill ${r.type === 'add_late_fee' ? 'final' : esc(r.tone)}">${r.type === 'add_late_fee' ? 'late fee' : esc(TONE[r.tone] || r.tone)}</span>
          <span>${r.type === 'add_late_fee' ? `${esc(money(r.fee, r.currency))} late fee added to` : 'Reminder sent for'} <span class="mono">#${esc(r.number)}</span> · ${esc(r.client)}</span><span class="muted">${esc(fmtDate(r.at))}</span></div>`
          )
          .join('')}</div>`
      : '<div class="list-empty"><b>Nothing sent yet</b><span>Reminders and late fees you approve will show up here.</span></div>';
    return;
  }
  const list = sets[tab];
  $('list').innerHTML = list.length
    ? `<div class="crow head"><span></span><span>Client</span><span>Invoice</span><span>Status · next step</span><span class="r">Amount</span><span></span></div>${list.map(row).join('')}`
    : tab === 'attention'
      ? `<div class="list-empty ok"><b>You're all caught up</b><span>${data.comingUp.find((x) => x.state === 'planned') ? `Next: ${esc(data.comingUp.find((x) => x.state === 'planned').label.toLowerCase())} to ${esc(data.comingUp.find((x) => x.state === 'planned').client)}, ${esc(dayLabel(data.comingUp.find((x) => x.state === 'planned').date))}.` : 'Nothing needs you right now.'}</span></div>`
      : '<div class="list-empty"><b>No unpaid invoices</b><span>Invoices you send show up here until they are paid.</span></div>';
  $('chaseAll').classList.toggle('hidden', !data.cards.some((c) => c.daysLate > 0 && c.actionable));
}

function renderRail() {
  const until = new Date(Date.parse(`${data.today}T12:00:00Z`) + 14 * 864e5).toISOString().slice(0, 10);
  const up = data.comingUp.filter((x) => x.date <= until);
  $('railSub').textContent = data.autopilot.enabled ? 'Autopilot' : 'Autopilot is off';
  if (!data.autopilot.enabled) {
    $('rail').innerHTML = `<li class="rail-empty">Reminders are only written when you ask. You can turn Autopilot on in <a href="/settings#autopilot">Settings</a>.</li>`;
    return;
  }
  const groups = [];
  for (const x of up) {
    const g = groups.at(-1);
    g && g.date === x.date ? g.items.push(x) : groups.push({ date: x.date, items: [x] });
  }
  $('rail').innerHTML = groups.length
    ? groups
        .map(
          (g) => `<li><span class="rd">${esc(dayLabel(g.date))}</span>${g.items
            .map((x) => `<div class="ri ${esc(x.tone)}"><i></i><span><b>${esc(x.client)}</b><span>${esc(x.label)} · <span class="mono">#${esc(x.number)}</span>${x.state === 'waiting' ? ' · <em>ready</em>' : ''}</span></span></div>`)
            .join('')}</li>`
        )
        .join('')
    : '<li class="rail-empty">Nothing planned in the next two weeks.</li>';
}

async function load() {
  [data, { invoices }] = await Promise.all([api('/api/collections'), api('/api/invoices')]);
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
  if (e.target.closest('[data-markpaid]')) return;
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
  const r = op ? op.dataset.open : e.target.closest('button, a, .menu') ? null : e.target.closest('[data-inv]')?.dataset.inv;
  const inv = r && invoices.find((i) => i.id === r);
  if (inv) openInvoiceDrawer(inv, { today: data.today, mock: cfg.paypalMode === 'mock', onSimulatePay: async (pid) => { await api(`/api/mock/pay/${pid}`, { body: {} }); load(); } });
});

$('chaseAll').onclick = async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = 'Writing reminders…';
  try {
    const { created } = await api('/api/followups/scan', { body: {} });
    toast(created.length ? `${created.length} draft${created.length > 1 ? 's' : ''} ready to review` : 'Every late invoice already has a draft or a recent reminder');
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
