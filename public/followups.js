import { api, header, esc, renderSlip, toast, fmtDate, money, RISK_TEXT, copyPayLink } from './common.js';

const $ = (id) => document.getElementById(id);
await header('followups');

let data = null;
const TONE_LABEL = { friendly: 'Friendly', firm: 'Firm', final: 'Final' };

const entries = (m) => Object.entries(m || {});
const moneyMap = (m) => (entries(m).length ? entries(m).map(([cur, v]) => money(v, cur)).join(' + ') : money(0, 'USD'));
const sumMaps = (...ms) => {
  const out = {};
  for (const m of ms) for (const [c, v] of entries(m)) out[c] = Math.round(((out[c] || 0) + v) * 100) / 100;
  return out;
};
const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const dayLabel = (iso) => (iso === data.today ? 'Today' : fmtDate(iso));

function lateText(d) {
  if (d < 0) return `Due in ${-d} day${-d === 1 ? '' : 's'}`;
  if (d === 0) return 'Due today';
  return `${d} day${d === 1 ? '' : 's'} late`;
}

// ---------------- stats ----------------
function renderStats() {
  const t = data.totals;
  const late = sumMaps(t.late, t.later, t.critical);
  const lateCount = data.counts.late + data.counts.later + data.counts.critical;
  const openCount = data.cards.length;
  const total = entries(t.owed).reduce((a, [, v]) => a + v, 0) || 1;
  const bar = ['upcoming', 'late', 'later', 'critical']
    .map((k) => {
      const v = entries(t[k]).reduce((a, [, x]) => a + x, 0);
      return v ? `<span class="sb-${k}" style="width:${(v / total) * 100}%" title="${esc(data.stages.find((s) => s.key === k).label)}: ${esc(moneyMap(t[k]))}"></span>` : '';
    })
    .join('');
  const sp = data.speed;
  $('stats').innerHTML = `
    <div class="cs"><span class="cs-l">Clients owe you</span><b class="cs-v">${esc(moneyMap(t.owed))}</b><span class="cs-s">${openCount} unpaid invoice${openCount === 1 ? '' : 's'}</span></div>
    <div class="cs ${lateCount ? 'bad' : ''}"><span class="cs-l">Late</span><b class="cs-v">${esc(moneyMap(late))}</b><span class="cs-s">${lateCount ? `${lateCount} invoice${lateCount > 1 ? 's' : ''} past due` : 'Nothing late'}</span></div>
    <div class="cs"><span class="cs-l">Due this week</span><b class="cs-v">${esc(moneyMap(data.dueThisWeek))}</b><span class="cs-s">not late yet</span></div>
    <div class="cs"><span class="cs-l">You get paid in</span><b class="cs-v">${sp.avgDaysToGetPaid != null ? `${sp.avgDaysToGetPaid} days` : '—'}</b><span class="cs-s">${sp.onTimeRate != null ? `${sp.onTimeRate}% of invoices paid on time` : 'on average, once you have history'}</span></div>
    <div class="cs-bar" aria-hidden="true">${bar}</div>`;
}

// ---------------- plan tracker on each invoice ----------------
function tracker(c) {
  const st = c.plan.steps;
  if (!st.length) return '';
  const icon = { done: '✓', waiting: '•', due: '!', planned: '', skipped: '–' };
  return `<ol class="trk">${st
    .map(
      (s) => `<li class="t-${esc(s.state)}" title="${esc(s.label)} · ${esc(s.state === 'done' ? 'sent' : s.state === 'waiting' ? 'draft ready' : s.state === 'skipped' ? 'skipped' : s.state === 'due' ? 'due now' : 'planned')}">
        <span class="t-dot">${icon[s.state] || ''}</span><span class="t-name">${esc(TONE_LABEL[s.tone])}</span><span class="t-date">${esc(s.state === 'done' ? 'sent' : s.state === 'skipped' ? 'skipped' : dayLabel(s.date))}</span></li>`
    )
    .join('')}</ol>`;
}

function primaryAction(c) {
  if (!c.actionable) return `<span class="muted small">Not on the PayPal account you're connected to.</span>`;
  const draft = c.drafts.find((d) => d.type === 'send_reminder') || c.drafts[0];
  if (draft) return `<button class="btn small" data-review="${esc(draft.id)}">Review ${draft.type === 'add_late_fee' ? 'late fee' : `${esc((draft.tone || '').toLowerCase())} reminder`}</button>`;
  const next = c.plan.next;
  const tone = next?.tone || 'friendly';
  const label = c.daysLate > 0 ? `Write ${tone} reminder` : 'Send a heads-up';
  return `<button class="btn small ${c.daysLate > 0 ? '' : 'ghost'}" data-draft="${esc(c.id)}" data-kind="reminder">${label}</button>`;
}

function attnCard(c) {
  const extraFee = c.lateFeeEligible && !c.drafts.some((d) => d.type === 'add_late_fee') ? `<button class="btn ghost small" data-draft="${esc(c.id)}" data-kind="late_fee">+ ${data.lateFee.percent}% late fee</button>` : '';
  const more = c.drafts.length > 1 ? `<span class="muted small">${c.drafts.length} drafts ready</span>` : '';
  return `<article class="acard s-${esc(c.stage)}">
    <div class="ac-who">
      <span class="avatar" aria-hidden="true">${esc(initials(c.client))}</span>
      <div><b>${esc(c.client)}</b><span class="muted">${esc(c.company || c.email)}</span></div>
    </div>
    <div class="ac-mid">
      <div class="ac-line"><span class="chip-late ${esc(c.stage)}">${esc(lateText(c.daysLate))}</span>${c.status === 'PARTIALLY_PAID' ? '<span class="chip-soft">Part paid</span>' : ''}${
        c.risk === 'high' || c.risk === 'medium' ? `<span class="chip-soft risk-${esc(c.risk)}">${esc(RISK_TEXT[c.risk])} risk · usually ${esc(c.usuallyLate)}d late</span>` : ''
      }</div>
      <div class="ac-work"><span class="num">#${esc(c.number)}</span> ${esc(c.work)}</div>
      <div class="ac-last">${c.lastContact ? `Last contact: ${esc(TONE_LABEL[c.lastContact.tone] || 'Reminder')} reminder, ${esc(fmtDate(c.lastContact.at))}` : `Sent ${esc(fmtDate(c.issueDate))}, no reminders yet`}</div>
      ${tracker(c)}
    </div>
    <div class="ac-right">
      <div class="ac-amt">${esc(money(c.total, c.currency))}</div>
      <div class="ac-acts">${primaryAction(c)}${extraFee}${more}</div>
      ${c.payerUrl ? `<button class="linkbtn small" data-copy="${esc(c.payerUrl)}" title="Paste it in a text or WhatsApp message. Clients pay faster from a direct link.">Copy pay link</button>` : ''}
    </div>
  </article>`;
}

function trackRow(c) {
  const n = c.plan.next;
  return `<div class="trow">
    <span class="avatar sm" aria-hidden="true">${esc(initials(c.client))}</span>
    <span class="tr-who"><b>${esc(c.client)}</b><span class="muted">#${esc(c.number)} · ${esc(c.work)}</span></span>
    <span class="tr-due">${esc(lateText(c.daysLate))}</span>
    <span class="tr-next muted">${n ? `${esc(n.label)} · ${esc(dayLabel(n.date))}` : '—'}</span>
    <span class="tr-amt">${esc(money(c.total, c.currency))}</span>
    ${c.payerUrl ? `<button class="linkbtn small" data-copy="${esc(c.payerUrl)}" title="Copy the PayPal link your client pays from">Copy link</button>` : ''}
  </div>`;
}

function renderLists() {
  const needs = (c) => c.daysLate >= -1 || c.drafts.length || c.plan.next?.state === 'due';
  const attn = data.cards.filter(needs);
  const track = data.cards.filter((c) => !needs(c));
  $('attnCount').textContent = attn.length ? `${attn.length}` : '';
  $('trackCount').textContent = track.length ? `${track.length}` : '';
  const nextUp = data.comingUp.find((x) => x.state === 'planned');
  $('attention').innerHTML = attn.length
    ? attn.map(attnCard).join('')
    : `<div class="all-clear"><div class="ac-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
        <div><b>You're all caught up.</b><br><span class="muted">${
          nextUp ? `Autopilot's next step: ${esc(nextUp.label.toLowerCase())} to ${esc(nextUp.client)} on ${esc(dayLabel(nextUp.date))}.` : data.cards.length ? 'Nothing needs you right now.' : 'No unpaid invoices. Send one from New invoice or the Assistant.'
        }</span></div></div>`;
  $('ontrack').innerHTML = track.length ? track.map(trackRow).join('') : `<div class="muted small" style="padding:6px 2px">Nothing else open.</div>`;
  const anyLate = data.cards.some((c) => c.daysLate > 0 && c.actionable);
  $('chaseAll').classList.toggle('hidden', !anyLate);
}

// ---------------- autopilot plan + coming up ----------------
function renderPlan() {
  const a = data.autopilot;
  $('apToggle').setAttribute('aria-checked', String(a.enabled));
  $('apToggle').classList.toggle('off', !a.enabled);
  $('apLabel').textContent = a.enabled ? 'Autopilot on' : 'Autopilot off';
  $('planMini').innerHTML = `<span class="apm-h"><b>Autopilot plan</b><span class="muted">Edit in Settings →</span></span>
    <span class="apm-steps"><span class="friendly"><i></i>Heads-up ${a.beforeDays}d before</span><span class="firm"><i></i>Firm ${a.firmAfter}d after</span><span class="final"><i></i>Final ${a.finalAfter}d after${a.feeWithFinal && data.lateFee.percent > 0 ? ` + ${data.lateFee.percent}% fee` : ''}</span></span>`;
  renderUpcoming();
}

function renderUpcoming() {
  const a = data.autopilot;
  const up = data.comingUp.slice(0, 10);
  const groups = [];
  for (const x of up) {
    const g = groups.at(-1);
    g && g.date === x.date ? g.items.push(x) : groups.push({ date: x.date, items: [x] });
  }
  $('upcoming').innerHTML = up.length
    ? groups
        .map(
          (g) => `<li class="up-day"><span class="up-date">${esc(dayLabel(g.date))}</span><ul>${g.items
            .map((x) => `<li class="up-item ${esc(x.tone)}"><span class="ps-dot"></span><span><b>${esc(x.label)}</b> · ${esc(x.client)}<br><span class="muted">#${esc(x.number)} · ${esc(x.amount)}${x.state === 'waiting' ? ' · draft ready' : ''}</span></span></li>`)
            .join('')}</ul></li>`
        )
        .join('')
    : `<li class="muted small">${a.enabled ? 'Nothing planned. Unpaid invoices get a plan automatically.' : 'Autopilot is off. Turn it on to plan reminders for every unpaid invoice.'}</li>`;
  $('runNow').classList.toggle('hidden', !(a.enabled && data.comingUp.some((x) => x.state === 'due')));
}

function renderRecent() {
  $('recent').innerHTML = data.recent.length
    ? data.recent
        .slice(0, 6)
        .map(
          (r) => `<li><span class="pill ${r.type === 'add_late_fee' ? 'final' : esc(r.tone)}">${r.type === 'add_late_fee' ? 'late fee' : esc(r.tone)}</span>
          <span>${r.type === 'add_late_fee' ? `${esc(money(r.fee, r.currency))} fee on` : 'Reminder for'} <b>#${esc(r.number)}</b> · ${esc(r.client)}</span><span class="muted">${esc(fmtDate(r.at))}</span></li>`
        )
        .join('')
    : '<li class="muted small">Nothing sent yet.</li>';
}

async function load() {
  data = await api('/api/collections');
  renderStats();
  renderLists();
  renderPlan();
  renderRecent();
}

// ---------------- interactions ----------------
function openDrawer(action) {
  $('drawerTitle').textContent = action.type === 'add_late_fee' ? `Late fee · invoice #${action.payload.number}` : `${TONE_LABEL[action.payload.tone] || ''} reminder · invoice #${action.payload.number}`;
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

document.querySelector('.coll').addEventListener('click', async (e) => {
  const cp = e.target.closest('[data-copy]');
  if (cp) return copyPayLink(cp.dataset.copy);
  const rev = e.target.closest('[data-review]');
  if (rev) {
    const { actions } = await api('/api/actions?status=pending');
    const a = actions.find((x) => x.id === rev.dataset.review);
    return a ? openDrawer(a) : load();
  }
  const btn = e.target.closest('[data-draft]');
  if (!btn) return;
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
});

$('apToggle').onclick = async () => {
  const enabled = !data.autopilot.enabled;
  await api('/api/autopilot', { body: { enabled } });
  toast(enabled ? 'Autopilot is on. It drafts reminders on the right days; you approve them.' : 'Autopilot is off. Nothing will be drafted automatically.');
  if (enabled) await api('/api/autopilot/run', { body: {} }).catch(() => {});
  load();
};

$('runNow').onclick = async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = 'Writing…';
  try {
    const { created } = await api('/api/autopilot/run', { body: {} });
    toast(created.length ? `${created.length} draft${created.length > 1 ? 's' : ''} ready for your OK` : 'Nothing new to draft');
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
    b.textContent = "Draft today's now";
  }
};

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

window.addEventListener('pp:notification', () => load());
await load();
