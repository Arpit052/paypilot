import { api, header, esc, money, fmtDate } from './common.js';

await header('clientview');
const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('inv');
if (!id) location.href = '/dashboard';
const v = await api(`/api/invoices/${encodeURIComponent(id)}/client-view`);
const d = v.document;
const m = (x) => money(x, d.currency);
const first = d.client.name.split(' ')[0] || 'there';
const paid = d.paid;
const biz = d.business || 'Your business';
$('lede').textContent = `Invoice #${d.invoice} for ${d.client.name}, step by step from their side.`;

const lines = d.items.map((i) => `<tr><td>${esc(i.name)}${i.quantity !== 1 ? ` <span class="cv-q">× ${i.quantity}</span>` : ''}</td><td class="r">${m(i.amount)}</td></tr>`).join('');
const sums = `${d.discount ? `<tr class="cv-s"><td>Early-pay discount</td><td class="r">−${m(d.discount)}</td></tr>` : ''}${d.tax ? `<tr class="cv-s"><td>Sales tax (${d.taxPercent}%)</td><td class="r">${m(d.tax)}</td></tr>` : ''}<tr class="cv-t"><td>Total</td><td class="r">${m(d.total)}</td></tr>`;
const ep = v.earlyPay && v.earlyPay.status === 'active' ? `<div class="cv-offer">Pay by ${esc(new Date(v.earlyPay.until).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} to keep the ${m(v.earlyPay.amount)} early-pay discount.</div>` : '';

const STEPS = [
  {
    key: 'email',
    title: 'The invoice email',
    sub: 'Sent by PayPal from your business name',
    html: () => `<div class="cv-mail">
      <div class="cv-mail-h"><div><b>${esc(v.email.from)}</b><span>to ${esc(v.email.to)}</span></div><em>${esc(fmtDate(d.issueDate))}</em></div>
      <div class="cv-mail-s">${esc(v.email.subject)}</div>
      <div class="cv-paper">
        <div class="cv-from">${esc(biz)}</div>
        <div class="cv-big">${m(d.total)}</div>
        <div class="cv-due">Due ${esc(fmtDate(d.dueDate))} · Invoice #${esc(d.invoice)}</div>
        ${ep}
        ${d.depositAmount ? `<div class="cv-offer">A deposit of ${m(d.depositAmount)} can be paid now; the rest by the due date.</div>` : ''}
        ${v.payerUrl ? `<a class="cv-btn" href="${esc(v.payerUrl)}" target="_blank" rel="noopener">View and pay</a>` : '<span class="cv-btn">View and pay</span>'}
        <table class="cv-lines">${lines}${sums}</table>
        ${d.note ? `<p class="cv-note">${esc(d.note).replace(/\n/g, '<br>')}</p>` : ''}
      </div>
      <p class="cv-cap">This is the email PayPal sends to ${esc(d.client.name)} when you approve the invoice. Reminders arrive in the same thread.</p>
    </div>`,
  },
  {
    key: 'pay',
    title: 'The payment page',
    sub: 'Card or PayPal, on PayPal itself',
    html: () => `<div class="cv-pay">
      <div class="cv-paper">
        <div class="cv-pay-h"><b>Pay ${esc(biz)}</b><span>Invoice #${esc(d.invoice)}</span></div>
        <table class="cv-lines">${lines}${sums}</table>
        <div class="cv-methods"><span>Pay with PayPal</span><span>Debit or credit card</span></div>
        ${paid || !v.payerUrl ? `<span class="cv-btn">${paid ? 'Already paid' : `Pay ${m(d.total)}`}</span>` : `<a class="cv-btn" href="${esc(v.payerUrl)}" target="_blank" rel="noopener">Pay ${m(d.total)}</a>`}
      </div>
      <p class="cv-cap">${v.demo ? 'Click Pay to open the checkout your client gets. In demo mode it is a practice checkout and no money moves; with PayPal sandbox connected, the same button opens PayPal\'s own payment page for this invoice.' : 'Click Pay to open PayPal\'s own payment page for this invoice, exactly as your client sees it. PayPilot hears about the payment from PayPal straight away.'}</p>
    </div>`,
  },
  {
    key: 'receipt',
    title: 'The receipt',
    sub: paid ? `${d.receipt}, paid ${fmtDate(d.paidDate)}` : 'What they get once they pay',
    html: () => `<div class="cv-pay">
      <div class="cv-paper cv-receipt ${paid ? '' : 'preview'}">
        ${paid ? '' : '<span class="cv-wm">Preview</span>'}
        <div class="cv-pay-h"><b>Receipt ${esc(d.receipt)}</b><span>${paid ? `Paid ${esc(fmtDate(d.paidDate))} by ${esc(d.method === 'PayPal' ? 'PayPal' : d.method)}` : 'Not paid yet'}</span></div>
        <div class="cv-tick">${paid ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</div>
        <div class="cv-big">${m(d.total)}</div>
        <div class="cv-due">Thank you, ${esc(first)}.</div>
        <table class="cv-lines">${lines}${sums}</table>
      </div>
      <p class="cv-cap">${paid ? (d.method === 'PayPal' ? 'PayPal emailed its own receipt. This numbered receipt is yours to send or print as well.' : 'Paid outside PayPal, so PayPal didn\'t send a receipt. Send this one from Receipts.') : 'Once paid, PayPal emails a receipt, and PayPilot keeps a numbered one you can send or print.'}</p>
      ${v.receiptLink ? `<div class="cv-row"><a class="btn small" href="${esc(v.receiptLink)}" target="_blank" rel="noopener">Open the receipt page</a><a class="btn ghost small" href="/receipts?inv=${encodeURIComponent(id)}">Track it in Receipts</a></div>` : ''}
    </div>`,
  },
];
if (v.delivery)
  STEPS.push({
    key: 'files',
    title: 'Their files',
    sub: v.delivery.unlockedAt ? 'Unlocked' : 'Locked until paid',
    html: () => `<div class="cv-pay"><div class="cv-paper cv-files"><div class="cv-lock ${v.delivery.unlockedAt ? 'open' : ''}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="${v.delivery.unlockedAt ? 'M8 11V7a4 4 0 0 1 7.5-2' : 'M8 11V7a4 4 0 0 1 8 0v4'}"/></svg></div>
      <b>${v.delivery.unlockedAt ? 'Thank you, your files are ready' : 'Your files are ready'}</b><p>${v.delivery.unlockedAt ? 'The invoice is paid, so the final work is unlocked.' : 'They unlock by themselves as soon as the invoice is paid.'}</p><span class="cv-btn">${v.delivery.unlockedAt ? 'Open your files' : 'Pay with PayPal'}</span></div>
      <p class="cv-cap">The link in the invoice note goes to this page. The real file link is never shown before payment.</p>
      <a class="btn ghost small" href="${esc(v.delivery.link)}" target="_blank" rel="noopener">Open their page</a></div>`,
  });

let cur = paid ? 2 : 0;
function show(i) {
  cur = i;
  $('steps').innerHTML = STEPS.map((s, k) => `<li role="presentation"><button role="tab" aria-selected="${k === i}" data-k="${k}"><span>${k + 1}</span><div><b>${esc(s.title)}</b><em>${esc(s.sub)}</em></div></button></li>`).join('');
  $('stage').innerHTML = STEPS[i].html();
}
$('steps').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]');
  if (b) show(Number(b.dataset.k));
});
show(cur);
