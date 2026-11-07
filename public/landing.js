// Landing page: reveal-on-scroll and feature tabs.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// nav gets a background once you scroll
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('solid', scrollY > 12);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// fade things in as they enter the screen
const io = new IntersectionObserver(
  (es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))),
  { rootMargin: '0px 0px -8% 0px' }
);
document.querySelectorAll('.reveal').forEach((el) => (reduce ? el.classList.add('in') : io.observe(el)));

// feature tabs
const ICON = {
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  receipt: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .7V2l-1 .7-3-2-3 2-3-2-3 2-3-2z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3"/><path d="M3 5v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M21 12h-4a2 2 0 0 0 0 4h4z"/>',
  tax: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
};
const CARDS = {
  paid: [
    ['doc', 'Invoices from a sentence', 'Plain words or a screenshot become a PayPal invoice with tax, deposit and terms, ready to approve.'],
    ['link', 'Pay links anywhere', 'Copy a direct PayPal pay link for WhatsApp, SMS or email. Clients pay faster from a link.'],
    ['lock', 'Pay to unlock', 'Final files stay behind a locked page until PayPal confirms the payment.'],
    ['bolt', 'Early-pay discount', '"2% off if paid in 48 hours", suggested only for clients who need the nudge, removed on PayPal if it lapses.'],
  ],
  track: [
    ['repeat', 'Autopilot follow-ups', 'Friendly, firm, final with an optional late fee, each drafted on the right day and sent when you approve.'],
    ['chat', 'Reminders that know the client', 'Warm for a good client, formal with your terms and the late-fee date for a repeat late payer.'],
    ['receipt', 'Receipts, tracked', 'Every payment gets a numbered receipt. See which customers still need one and send it in a click.'],
    ['bell', 'Paid, the moment it happens', 'PayPal webhooks plus a two-minute check. A notification, and your dashboard updates live.'],
  ],
  plan: [
    ['wallet', 'Budget Estimator', '4,000 simulated futures answer "can I afford it?", after fees, tax and the rent due on the 1st.'],
    ['cal', 'Expected-on dates', 'Each unpaid invoice shows when it will most likely arrive, with a range, from that client\'s history.'],
    ['chart', 'Analytics in plain English', 'Days to get paid, on-time rate, income steadiness and a health label, with what to do about it.'],
    ['tax', 'Tax-ready year end', 'Gross, PayPal fees, quarters with due dates and the 1099 forms to expect, as PDF or CSV.'],
  ],
  grow: [
    ['users', 'Customer segments', 'Champions, loyal, at risk, slipping away: RFM scoring tells you who to call this week.'],
    ['target', 'Where to focus', 'Which services grow, which stall, and which customers bring the most value for the least chasing.'],
    ['repeat', 'Suggested retainers', 'Spots customers who buy every month and prices a plan that works for both of you.'],
    ['spark', 'A growth plan', 'Three priorities for next quarter, written from your own numbers, every claim backed by data.'],
  ],
};
const cards = document.getElementById('cards');
const svg = (k) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
function showTab(t) {
  document.querySelectorAll('.lp-tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  cards.innerHTML = CARDS[t].map(([ic, h, p], i) => `<article class="lp-card" style="--d:${i * 60}ms"><span class="lp-ic">${svg(ic)}</span><b>${h}</b><p>${p}</p></article>`).join('');
  requestAnimationFrame(() => cards.querySelectorAll('.lp-card').forEach((c) => c.classList.add('in')));
}
document.querySelector('.lp-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});
document.querySelector('.lp-tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('.lp-tabs [role=tab]')];
  const i = tabs.findIndex((b) => b.getAttribute('aria-selected') === 'true');
  const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  n.focus();
  showTab(n.dataset.tab);
});
showTab('paid');
