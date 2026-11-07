// Pay to unlock: attach the final work (a Figma, Drive or Dropbox link) to an invoice. The
// client gets a private PayPilot page that stays locked until the invoice is paid. When PayPal
// reports the payment (webhook or the 2-minute check), the page unlocks by itself and shows
// the link, and the owner is notified. The real link is never shown before payment.
import crypto from 'node:crypto';
import { config } from './config.js';
import { kvGet, kvSet, kvDel, getInvoice, logActivity } from './db.js';
import { notify } from './notify.js';

let lastOrigin = '';
/** Remember how the app is being reached, for building links when PUBLIC_URL isn't set. */
export function noteOrigin(origin) {
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(lastOrigin || '')) return;
  if (origin) lastOrigin = origin;
}
export function publicBase() {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || lastOrigin || `http://localhost:${config.port || 3000}`).replace(/\/+$/, '');
}
export const isLocalBase = () => /^https?:\/\/(localhost|127\.0\.0\.1)/.test(publicBase());

const bad = (m) => Object.assign(new Error(m), { status: 400 });

/** Validate a work link: http(s) only, no credentials in the URL. */
export function cleanWorkUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    throw bad('The final work link must be a full web address, like https://www.figma.com/...');
  }
  if (!['https:', 'http:'].includes(u.protocol)) throw bad('The final work link must start with https://');
  if (u.username || u.password) throw bad("Don't put a password in the link");
  return u.href.slice(0, 1000);
}

export const newToken = () => crypto.randomBytes(18).toString('base64url');
export const unlockLink = (token) => `${publicBase()}/d/${token}`;
export const noteLine = (token) => `Your final files are ready. They unlock automatically as soon as this invoice is paid: ${unlockLink(token)}`;

export function attachDelivery(invoiceId, { url, label = '', token = newToken() }) {
  const clean = cleanWorkUrl(url);
  if (!clean) throw bad('Add the link to the final work');
  const prev = kvGet(`delivery:${invoiceId}`);
  if (prev?.token && prev.token !== token) kvDel(`dtoken:${prev.token}`);
  const d = { url: clean, label: String(label || '').trim().slice(0, 80), token, createdAt: new Date().toISOString(), unlockedAt: prev?.unlockedAt || null, views: prev?.views || 0 };
  kvSet(`delivery:${invoiceId}`, d);
  kvSet(`dtoken:${token}`, invoiceId);
  return { ...d, link: unlockLink(token) };
}

export function getDelivery(invoiceId) {
  const d = kvGet(`delivery:${invoiceId}`);
  return d ? { ...d, link: unlockLink(d.token) } : null;
}

export function removeDelivery(invoiceId) {
  const d = kvGet(`delivery:${invoiceId}`);
  if (d?.token) kvDel(`dtoken:${d.token}`);
  kvDel(`delivery:${invoiceId}`);
}

const PAID = ['PAID', 'MARKED_AS_PAID'];

/** What the public page may show for a token (nothing private before payment). */
export function deliveryView(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  const invoiceId = kvGet(`dtoken:${token}`);
  const inv = invoiceId && getInvoice(invoiceId);
  const d = invoiceId && kvGet(`delivery:${invoiceId}`);
  if (!inv || !d || d.token !== token || inv.status === 'CANCELLED') return null;
  const paid = PAID.includes(inv.status);
  if (paid && !d.unlockedAt) unlockFor(inv);
  return {
    business: config.businessName || 'Your designer',
    number: inv.number,
    total: inv.total,
    currency: inv.currency,
    dueDate: inv.dueDate,
    label: d.label,
    paid,
    payUrl: paid ? null : inv.payerUrl,
    url: paid ? d.url : null,
  };
}

/** Called when an invoice becomes paid. */
export function unlockFor(inv) {
  const d = kvGet(`delivery:${inv.id}`);
  if (!d || d.unlockedAt) return false;
  kvSet(`delivery:${inv.id}`, { ...d, unlockedAt: new Date().toISOString() });
  logActivity('delivery_unlocked', `Final files for invoice #${inv.number} unlocked for the client`);
  notify({ kind: 'payment', title: 'Files unlocked', body: `Invoice #${inv.number} is paid, so the client's download page now shows the final work.`, link: '/dashboard', invoiceId: inv.id });
  return true;
}
