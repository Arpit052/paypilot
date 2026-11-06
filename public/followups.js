import { api, header, esc, renderSlip, toast, fmtDate, money, RISK_TEXT } from './common.js';

const $ = (id) => document.getElementById(id);
await header('followups');

const STAGE_COLOR = { upcoming: 'var(--paid)', late: '#fbbf24', later: '#fb923c', critical: 'var(--late)' };
let data = null;

const sumMap = (m) => Object.entries(m || {});
const moneyMap = (m, fallback = 'USD') => {
  const e = sumMap(m);
  if (!e.length) return money(0, fallback);
  return e.map(([cur, v]) => money(v, cur)).join(' + ');
};
const primary = (m) => sumMap(m).reduce((t, [, v]) => t + v, 0);
const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

function lateText(d) {
  if (d < 0) return `due in ${-d} day${-d === 1 ? '' : 's'}`;
  if (d === 0) return 'due today';
  return `${d} day${d === 1 ? '' : 's'} late`;
}

function renderHero() {
  const { totals, counts } = data;
  const owed = primary(totals.owed);
  const lateMap = {};
  for (const k of ['late', 'later', 'critical']) for (const [cur, v] of sumMap(totals[k])) lateMap[cur] = Math.round(((lateMap[cur] || 0) + v) * 100) / 100;
  const lateCount = counts.late + counts.later + counts.critical;
  const seg = data.stages
    .map((s) => {
      const v = primary(totals[s.key]);
      return v ? `<span class="seg-part" style="flex:${v};background:${STAGE_COLOR[s.key]}" title="${esc(s.label)}: ${esc(moneyMap(totals[s.key]))}"></span>` : '';
    })
    .join('');
  $('hero').innerHTML = owed
    ? `<div class="ch-main">
        <span class="muted">Clients owe you</span>
        <div class="ch-big">${esc(moneyMap(totals.owed))}</div>
        <span class="${lateCount ? 'ch-late' : 'muted'}">${lateCount ? `${esc(moneyMap(lateMap))} of it is late, across ${lateCount} invoice${lateCount > 1 ? 's' : ''}` : 'Nothing is late. Nice.'}</span>
      </div>
      <div class="ch-bar">
        <div class="seg-bar">${seg}</div>
        <div class="seg-legend">${data.stages
          .map((s) => `<span><i style="background:${STAGE_COLOR[s.key]}"></i>${esc(s.label)} <b>${esc(moneyMap(totals[s.key]))}</b></span>`)
          .join('')}</div>
      </div>`
    : `<div class="ch-main"><span class="muted">Clients owe you</span><div class="ch-big">${money(0)}</div><span class="muted">Every invoice is paid. When you send new ones, they show up here until the money arrives.</span></div>`;
  $('chaseAll').disabled = !lateCount;
}

function timeline(c) {
  const steps = [`<span class="tl-step"><i></i>Sent ${esc(fmtDate(c.issueDate))}</span>`];
  for (const r of c.reminders.slice(-3)) steps.push(`<span class="tl-step"><i class="${esc(r.tone || 'friendly')}"></i>${esc(r.tone ? r.tone[0].toUpperCase() + r.tone.slice(1) : 'Reminder')} reminder ${esc(fmtDate(r.at))}</span>`);
  if (c.hasLateFee) steps.push('<span class="tl-step"><i class="final"></i>Late fee added</span>');
  return `<div class="tl">${steps.join('')}</div>`;
}

function card(c) {
  const draft = c.drafts[0];
  let actions = '';
  if (!c.actionable) actions = `<span class="muted small">Not on the PayPal account you're connected to.</span>`;
  else if (draft)
    actions = `<button class="btn small" data-review="${esc(draft.id)}">Review ${draft.type === 'add_late_fee' ? 'late fee' : `${esc(draft.tone || '')} reminder`}</button>${c.drafts.length > 1 ? `<span class="muted small">+${c.drafts.length - 1} more draft</span>` : ''}`;
  else
    actions = `<button class="btn ghost small" data-draft="${esc(c.id)}" data-kind="reminder">${c.daysLate > 0 ? 'Draft reminder' : 'Draft heads-up'}</button>${
      c.lateFeeEligible ? `<button class="btn ghost small" data-draft="${esc(c.id)}" data-kind="late_fee">Add ${data.lateFee.percent}% late fee</button>` : ''
    }`;
  return `<article class="ccard ${esc(c.stage)}">
    <div class="cc-top">
      <span class="avatar" aria-hidden="true">${esc(initials(c.client))}</span>
      <div class="cc-who"><b>${esc(c.client)}</b><span class="muted">${esc(c.company || c.email)}</span></div>
      <div class="cc-amt">${esc(money(c.total, c.currency))}</div>
    </div>
    <div class="cc-work"><span class="num">#${esc(c.number)}</span> ${esc(c.work)}</div>
    <div class="cc-tags">
      <span class="chip-late ${esc(c.stage)}">${esc(lateText(c.daysLate))}</span>
      ${c.status === 'PARTIALLY_PAID' ? '<span class="chip-soft">Part paid</span>' : ''}
      ${c.risk && c.risk !== 'none' && c.risk !== 'new' ? `<span class="chip-soft risk-${esc(c.risk)}">${esc(RISK_TEXT[c.risk] || c.risk)} risk</span>` : ''}
      ${c.usuallyLate ? `<span class="chip-soft">usually ${esc(c.usuallyLate)}d late</span>` : ''}
    </div>
    ${timeline(c)}
    <div class="cc-actions">${actions}${c.payerUrl ? `<a class="cc-link" href="${esc(c.payerUrl)}" target="_blank" rel="noopener" title="The page your client gets in their email">Client's view ↗</a>` : ''}</div>
  </article>`;
}

function renderBoard() {
  $('board').innerHTML = data.stages
    .map((s) => {
      const cards = data.cards.filter((c) => c.stage === s.key);
      return `<div class="bcol">
        <div class="bcol-head"><span class="dot" style="background:${STAGE_COLOR[s.key]}"></span><b>${esc(s.label)}</b><span class="muted">${cards.length}</span><span class="bcol-sum">${esc(moneyMap(data.totals[s.key]))}</span></div>
        <p class="bcol-hint">${esc(s.hint)}</p>
        <div class="bcol-cards">${cards.length ? cards.map(card).join('') : '<div class="bcol-empty">Nothing here.</div>'}</div>
      </div>`;
    })
    .join('');
}

function renderRecent() {
  $('recent').innerHTML = data.recent.length
    ? data.recent
        .map(
          (r) => `<li><span class="pill ${r.type === 'add_late_fee' ? 'final' : esc(r.tone)}">${r.type === 'add_late_fee' ? 'late fee' : esc(r.tone)}</span>
            <span>${r.type === 'add_late_fee' ? `Added ${esc(money(r.fee, r.currency))} late fee to` : 'Reminder sent for'} <b>#${esc(r.number)}</b> · ${esc(r.client)}</span>
            <span class="muted">${esc(fmtDate(String(r.at).slice(0, 10)))}</span></li>`
        )
        .join('')
    : '<li class="muted">Nothing sent yet. Reminders and late fees you approve show up here.</li>';
}

async function load() {
  data = await api('/api/collections');
  renderHero();
  renderBoard();
  renderRecent();
}

// ---- review drawer ----
function openDrawer(action) {
  $('drawerTitle').textContent = action.type === 'add_late_fee' ? `Late fee · invoice #${action.payload.number}` : `Reminder · invoice #${action.payload.number}`;
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

$('board').addEventListener('click', async (e) => {
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

$('chaseAll').onclick = async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = 'Writing reminders…';
  try {
    const { created } = await api('/api/followups/scan', { body: {} });
    const nRem = created.filter((a) => a.type === 'send_reminder').length;
    const nFee = created.length - nRem;
    toast(
      created.length
        ? `${[nRem ? `${nRem} reminder${nRem > 1 ? 's' : ''}` : '', nFee ? `${nFee} late fee${nFee > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')} ready to review`
        : 'Every late invoice already has a draft or a recent reminder'
    );
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    b.textContent = 'Chase all late invoices';
    b.disabled = false;
  }
};

// live: refresh when a payment or new draft arrives
window.addEventListener('pp:notification', () => load());
await load();
