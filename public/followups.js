import { api, header, esc, renderSlip, toast, fmtDate } from './common.js';

const $ = (id) => document.getElementById(id);
await header('followups');

async function load() {
  const { actions } = await api('/api/actions?type=send_reminder');
  const pending = actions.filter((a) => a.status === 'pending');
  const done = actions.filter((a) => a.status !== 'pending');
  $('pending').innerHTML = '';
  if (!pending.length) {
    $('pending').innerHTML = `<div class="tray-empty">No reminders waiting. Click <b>Find overdue invoices</b> to check now.</div>`;
  }
  pending.forEach((a) => $('pending').append(renderSlip(a, { onDone: (x) => { if (x.status === 'approved') toast('Reminder sent'); setTimeout(load, 1600); } })));
  $('history').innerHTML = done.length
    ? `<table class="data"><thead><tr><th>Invoice</th><th>Client</th><th>Tone</th><th>Subject</th><th>Outcome</th><th>When</th></tr></thead><tbody>${done
        .map(
          (a) => `<tr><td class="num">#${esc(a.payload.number)}</td><td>${esc(a.payload.client)}</td><td><span class="pill ${esc(a.payload.tone)}">${esc(a.payload.tone)}</span></td><td>${esc(a.payload.subject)}</td><td>${a.status === 'approved' ? 'Sent' : 'Discarded'}</td><td>${fmtDate((a.decidedAt || a.createdAt).slice(0, 10))}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '<div class="empty">No reminders sent yet.</div>';
}

$('scanBtn').onclick = async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Checking PayPal…';
  try {
    const { created } = await api('/api/followups/scan', { body: {} });
    toast(created.length ? `Drafted ${created.length} reminder${created.length > 1 ? 's' : ''}` : 'Nothing overdue that needs a reminder right now');
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Find overdue invoices';
  }
};

await load();
