// Background jobs: check PayPal for payments, create due recurring drafts, and draft
// reminders for overdue invoices. Everything it creates still waits for human approval.
import { config } from './config.js';
import { isMock } from './paypal.js';
import { setupDone } from './settings.js';
import { syncInvoices, importFromPaypal, importIfStale } from './sync.js';
import { runRecurring } from './recurring.js';
import { scanFollowups } from './followups.js';
import { notify } from './notify.js';
import { noteDueDates } from './alerts.js';
import { runAutopilot } from './autopilot.js';
import { listInvoices } from './db.js';

let running = false;
export const lastRun = { at: null, result: null };

export async function runJobs() {
  if (!setupDone()) return { skipped: 'waiting for the welcome screen' }; // nothing to do before PayPal/demo is chosen
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    const result = {};
    if (!isMock()) {
      result.imported = await importFromPaypal().then((r) => r.imported).catch((e) => ({ error: e.message }));
      result.sync = await syncInvoices().catch((e) => ({ error: e.message }));
    }
    result.recurringDrafts = runRecurring().length;
    result.alerts = noteDueDates();
    // Autopilot drafts the reminders that are due today (each still needs your approval)
    const fu = await runAutopilot().catch((e) => ({ error: e.message }));
    result.reminderDrafts = Array.isArray(fu) ? fu.filter((a) => a.type === 'send_reminder').length : fu;
    result.lateFeeDrafts = Array.isArray(fu) ? fu.filter((a) => a.type === 'add_late_fee').length : 0;
    const drafts = (Number(result.recurringDrafts) || 0) + (Number(result.reminderDrafts) || 0) + result.lateFeeDrafts;
    if (drafts) {
      notify({
        kind: 'approval',
        title: `${drafts} draft${drafts > 1 ? 's' : ''} waiting for approval`,
        body: [result.recurringDrafts ? `${result.recurringDrafts} recurring invoice${result.recurringDrafts > 1 ? 's' : ''}` : '', result.reminderDrafts ? `${result.reminderDrafts} payment reminder${result.reminderDrafts > 1 ? 's' : ''}` : '', result.lateFeeDrafts ? `${result.lateFeeDrafts} late fee${result.lateFeeDrafts > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ') + ' ready to review.',
        link: result.reminderDrafts || result.lateFeeDrafts ? '/followups' : '/',
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
  if (!(secs > 0)) return;
  const tick = () => {
    if (isMock() || !setupDone()) return;
    importIfStale(10)
      .catch(() => {})
      .then(() => syncInvoices())
      .catch(() => {});
  };
  setTimeout(tick, 5000).unref();
  setInterval(tick, secs * 1000).unref();
}

/** Start the periodic scheduler (SCHEDULER_INTERVAL_MIN, default 6h; 0 disables it). */
export function startScheduler() {
  startPaymentWatcher();
  // due-date alerts for the bell: soon after start, then every 30 minutes
  const alerts = () => {
    if (!setupDone()) return;
    noteDueDates();
    runAutopilot().catch(() => {});
  };
  setTimeout(alerts, 8000).unref();
  setInterval(alerts, 30 * 60 * 1000).unref();
  const minutes = config.schedulerMinutes;
  if (!(minutes > 0)) return false;
  // first pass shortly after start-up, then on the interval
  setTimeout(() => runJobs().catch(() => {}), 90 * 1000).unref();
  setInterval(() => runJobs().catch(() => {}), minutes * 60 * 1000).unref();
  return true;
}
