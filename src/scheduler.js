// Background jobs: check PayPal for payments, create due recurring drafts, and draft
// reminders for overdue invoices. Everything it creates still waits for human approval.
import { config } from './config.js';
import { isMock } from './paypal.js';
import { syncInvoices } from './sync.js';
import { runRecurring } from './recurring.js';
import { scanFollowups } from './followups.js';

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
    lastRun.at = new Date().toISOString();
    lastRun.result = result;
    console.log(`  [jobs] ${JSON.stringify(result)}`);
    return result;
  } finally {
    running = false;
  }
}

/** Start the periodic scheduler (SCHEDULER_INTERVAL_MIN, default 6h; 0 disables it). */
export function startScheduler() {
  const minutes = config.schedulerMinutes;
  if (!(minutes > 0)) return false;
  // first pass shortly after start-up, then on the interval
  setTimeout(() => runJobs().catch(() => {}), 90 * 1000).unref();
  setInterval(() => runJobs().catch(() => {}), minutes * 60 * 1000).unref();
  return true;
}
