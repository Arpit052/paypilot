// Background jobs: check PayPal for payments, create due recurring drafts, and draft
// reminders for overdue invoices. Everything it creates still waits for human approval.
import { config } from './config.js';
import { isMock } from './paypal.js';
import { syncInvoices } from './sync.js';
import { runRecurring } from './recurring.js';
import { scanFollowups } from './followups.js';
import { notify } from './notify.js';
import { listInvoices } from './db.js';

let running = false;
export const lastRun = { at: null, result: null };

export async function runJobs() {
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    const result = {};
    if (!isMock) result.sync = await syncInvoices().catch((e) => ({ error: e.message }));
    result.recurringDrafts = runRecurring().length;
    result.reminderDrafts = await scanFollowups({ sync: false })
      .then((r) => r.length)
      .catch((e) => ({ error: e.message }));
    const drafts = (Number(result.recurringDrafts) || 0) + (Number(result.reminderDrafts) || 0);
    if (drafts) {
      notify({
        kind: 'approval',
        title: `${drafts} draft${drafts > 1 ? 's' : ''} waiting for approval`,
        body: [result.recurringDrafts ? `${result.recurringDrafts} recurring invoice${result.recurringDrafts > 1 ? 's' : ''}` : '', result.reminderDrafts ? `${result.reminderDrafts} payment reminder${result.reminderDrafts > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ') + ' ready to review.',
        link: result.reminderDrafts ? '/followups' : '/',
      });
    }
    lastRun.at = new Date().toISOString();
    lastRun.result = result;
    console.log(`  [jobs] ${JSON.stringify(result)}`);
    return result;
  } finally {
    running = false;
  }
}

/**
 * Live payment checks against PayPal (real mode only): every PAYPAL_SYNC_SECONDS (default 120),
 * if there are open invoices. Webhooks are instant when configured; this is the safety net.
 */
function startPaymentWatcher() {
  const secs = Number(process.env.PAYPAL_SYNC_SECONDS ?? 120);
  if (isMock || !(secs > 0)) return;
  setInterval(() => {
    if (listInvoices().some((i) => i.paypalId && ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(i.status))) syncInvoices().catch(() => {});
  }, secs * 1000).unref();
}

/** Start the periodic scheduler (SCHEDULER_INTERVAL_MIN, default 6h; 0 disables it). */
export function startScheduler() {
  startPaymentWatcher();
  const minutes = config.schedulerMinutes;
  if (!(minutes > 0)) return false;
  // first pass shortly after start-up, then on the interval
  setTimeout(() => runJobs().catch(() => {}), 90 * 1000).unref();
  setInterval(() => runJobs().catch(() => {}), minutes * 60 * 1000).unref();
  return true;
}
