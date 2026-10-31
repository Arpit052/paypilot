// Notifications: stored in SQLite and pushed live to every open browser tab
// over Server-Sent Events (GET /api/events).
import { insertNotification } from './db.js';

const subscribers = new Set();

export function notify(n) {
  const note = insertNotification(n);
  const payload = `event: notification\ndata: ${JSON.stringify(note)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(payload);
    } catch {
      subscribers.delete(res);
    }
  }
  return note;
}

/** Express handler for the live event stream. */
export function eventStream(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');
  subscribers.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    subscribers.delete(res);
  });
}

export const subscriberCount = () => subscribers.size;
