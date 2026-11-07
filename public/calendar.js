import { api, header, esc, money, fmtDate, markPaidButton, copyPayLink } from './common.js';

const $ = (id) => document.getElementById(id);
await header('calendar');

const KIND = {
  overdue: { label: 'Overdue', group: 'due' },
  due: { label: 'Due', group: 'due' },
  paid: { label: 'Paid', group: 'paid' },
  planned: { label: 'Autopilot', group: 'planned' },
  reminded: { label: 'Reminder sent', group: 'reminded' },
  recurring: { label: 'Recurring invoice', group: 'recurring' },
};
const TONE = { friendly: 'Friendly heads-up', firm: 'Firm reminder', final: 'Final reminder' };
// payments, due dates and reminder dates (sent and planned); reminders can be hidden
let showReminders = true;
try { showReminders = localStorage.getItem('pp-cal-reminders') !== '0'; } catch {}
const show = new Set(['due', 'paid', 'recurring', ...(showReminders ? ['planned', 'reminded'] : [])]);
let data = null;
let month = new URLSearchParams(location.search).get('m') || null;
let selected = null;

const entries = (m) => Object.entries(m || {});
const moneyMap = (m, cur = 'USD') => (entries(m).length ? entries(m).map(([c, v]) => money(v, c)).join(' + ') : money(0, cur));
const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const shift = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

function pillText(e) {
  if (e.kind === 'planned') return `${TONE[e.tone] || 'Reminder'} · ${e.client}`;
  if (e.kind === 'reminded') return `${e.tone ? e.tone[0].toUpperCase() + e.tone.slice(1) : ''} reminder · ${e.client}`;
  if (e.kind === 'recurring') return `${e.client} · ${money(e.amount, e.currency)}`;
  return `${money(e.amount, e.currency)} · ${e.client}`;
}

async function load() {
  data = await api(`/api/calendar${month ? `?month=${month}` : ''}`);
  month = data.month;
  if (!selected || !selected.startsWith(month)) selected = data.today.startsWith(month) ? data.today : data.start;
  render();
}

function render() {
  const label = new Date(`${data.start}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('monthLabel').textContent = label;
  const cur = Object.keys(data.totals.due)[0] || Object.keys(data.totals.paid)[0] || 'USD';
  $('calStats').innerHTML = `
    <div class="cs"><span class="cs-l">Received in ${label.split(' ')[0]}</span><b class="cs-v">${esc(moneyMap(data.totals.paid, cur))}</b></div>
    <div class="cs"><span class="cs-l">Due in ${label.split(' ')[0]}</span><b class="cs-v">${esc(moneyMap(data.totals.due, cur))}</b></div>
    <div class="cs"><span class="cs-l">Reminders this month</span><b class="cs-v">${data.counts.planned + data.counts.reminded}</b><span class="cs-s">${data.counts.reminded} sent · ${data.counts.planned} planned</span></div>`;

  const byDay = {};
  for (const e of data.events) if (show.has(KIND[e.kind].group)) (byDay[e.date] ||= []).push(e);
  const first = new Date(`${data.start}T12:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const days = Number(data.end.slice(8));
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-cell pad"></div>');
  for (let d = 1; d <= days; d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    const ev = byDay[iso] || [];
    const money0 = ev.filter((e) => e.kind === 'paid').reduce((t, e) => t + e.amount, 0);
    cells.push(`<button class="cal-cell ${iso === data.today ? 'today' : ''} ${iso === selected ? 'sel' : ''} ${iso < data.today ? 'past' : ''}" data-d="${iso}">
      <span class="cal-n">${d}</span>
      ${ev.slice(0, 2).map((e) => `<span class="cal-ev k-${e.kind}${e.tone ? ` t-${e.tone}` : ''}">${esc(pillText(e))}</span>`).join('')}
      ${ev.length > 2 ? `<span class="cal-more">+${ev.length - 2} more</span>` : ''}
    </button>`);
  }
  while (cells.length % 7) cells.push('<div class="cal-cell pad"></div>');
  $('grid').innerHTML = cells.join('');
  renderDay(byDay[selected] || []);
}

function renderDay(ev) {
  const empty = selected < data.today ? 'Nothing happened with your money on this day.' : 'Nothing planned for this day.';
  $('day').innerHTML = `<div class="cd-h"><span class="muted">${selected === data.today ? 'Today' : selected < data.today ? 'Past' : 'Upcoming'}</span><h2>${esc(longDate(selected))}</h2></div>
    ${
      ev.length
        ? `<ul class="cd-list">${ev
            .map(
              (e) => `<li class="k-${e.kind}">
            <span class="cd-dot"></span>
            <div class="cd-body">
              <b>${esc(e.kind === 'planned' ? TONE[e.tone] : KIND[e.kind].label)}${e.kind === 'paid' && e.late ? ' <span class="muted">(late)</span>' : ''}</b>
              <span>${esc(e.client)}${e.number ? ` · #${esc(e.number)}` : ''} · ${esc(money(e.amount, e.currency))}${e.kind === 'recurring' ? ` · ${esc(e.frequency)}` : ''}</span>
              ${e.kind === 'planned' ? `<span class="muted small">${e.state === 'waiting' ? 'Draft is ready in Invoices' : e.auto ? 'Autopilot writes it this day for your OK' : 'Suggested date. Autopilot is off, so send it from Invoices'}</span>` : ''}
              <div class="cd-acts">
                ${e.invoiceId ? `<a class="linkbtn small" href="/dashboard?inv=${esc(e.invoiceId)}">Open invoice</a>` : ''}
                ${(e.kind === 'due' || e.kind === 'overdue') && e.payerUrl ? `<button class="linkbtn small" data-copy="${esc(e.payerUrl)}">Copy pay link</button>` : ''}
                ${e.kind === 'planned' && e.state === 'waiting' ? `<a class="linkbtn small" href="/invoices">Review draft</a>` : ''}
                ${e.kind === 'due' || e.kind === 'overdue' ? markPaidButton(e.invoiceId) : ''}
              </div>
            </div></li>`
            )
            .join('')}</ul>`
        : `<div class="cd-empty">${empty}</div>`
    }`;
}

$('grid').addEventListener('click', (e) => {
  const c = e.target.closest('[data-d]');
  if (!c) return;
  selected = c.dataset.d;
  render();
});
$('day').addEventListener('click', (e) => {
  const cp = e.target.closest('[data-copy]');
  if (cp) copyPayLink(cp.dataset.copy);
});
$('prev').onclick = () => { month = shift(month, -1); selected = null; load(); };
$('next').onclick = () => { month = shift(month, 1); selected = null; load(); };
$('todayBtn').onclick = () => { month = null; selected = null; load(); };
$('remToggle').setAttribute('aria-pressed', String(showReminders));
$('remToggle').addEventListener('click', () => {
  showReminders = !showReminders;
  $('remToggle').setAttribute('aria-pressed', String(showReminders));
  for (const k of ['planned', 'reminded']) showReminders ? show.add(k) : show.delete(k);
  try { localStorage.setItem('pp-cal-reminders', showReminders ? '1' : '0'); } catch {}
  render();
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'ArrowLeft' && e.altKey) $('prev').click();
  if (e.key === 'ArrowRight' && e.altKey) $('next').click();
});
window.addEventListener('pp:changed', load);
window.addEventListener('pp:notification', load);
await load();
