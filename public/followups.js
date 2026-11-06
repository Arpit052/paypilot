import { api, header, esc, renderSlip, toast, fmtDate } from './common.js';

const $ = (id) => document.getElementById(id);
await header('followups');

async function load() {
  const [rem, fees] = await Promise.all([api('/api/actions?type=send_reminder'), api('/api/actions?type=add_late_fee')]);
  const actions = [...rem.actions, ...fees.actions].sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  const pending = actions.filter((a) => a.status === 'pending');
  const done = actions.filter((a) => a.status !== 'pending');
  $('pending').innerHTML = '';
  if (!pending.length) {
    $('pending').innerHTML = `<div class="tray-empty">No reminders or late fees waiting. Click <b>Find overdue invoices</b> to check now.</div>`;
  }
  pending.forEach((a) => $('pending').append(renderSlip(a, { onDone: (x) => { if (x.status === 'approved') toast(x.type === 'add_late_fee' ? 'Late fee added' : 'Reminder sent'); setTimeout(load, 1600); } })));
  $('history').innerHTML = done.length
    ? `<table class="data"><thead><tr><th>Invoice</th><th>Client</th><th>Type</th><th>Details</th><th>Outcome</th><th>When</th></tr></thead><tbody>${done
        .map(
          (a) => `<tr><td class="num">#${esc(a.payload.number)}</td><td>${esc(a.payload.client)}</td>${
            a.type === 'add_late_fee'
              ? `<td><span class="pill final">late fee</span></td><td>${esc(a.payload.percent)}% fee (${esc(a.payload.currency)} ${esc(a.result?.fee ?? a.payload.fee)})</td><td>${a.status === 'approved' ? 'Added' : 'Waived'}</td>`
              : `<td><span class="pill ${esc(a.payload.tone)}">${esc(a.payload.tone)}</span></td><td>${esc(a.payload.subject)}</td><td>${a.status === 'approved' ? 'Sent' : 'Discarded'}</td>`
          }<td>${fmtDate((a.decidedAt || a.createdAt).slice(0, 10))}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '<div class="empty">No reminders sent yet.</div>';
}

$('scanBtn').onclick = async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Checking PayPal…';
  try {
    const { created } = await api('/api/followups/scan', { body: {} });
    const nRem = created.filter((a) => a.type === 'send_reminder').length;
    const nFee = created.length - nRem;
    toast(created.length ? [nRem ? `${nRem} reminder${nRem > 1 ? 's' : ''}` : '', nFee ? `${nFee} late fee${nFee > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ') + ' drafted' : 'Nothing overdue that needs action right now');
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Find overdue invoices';
  }
};

await load();
