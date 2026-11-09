// Private workspaces for visitors of the hosted demo (VISITOR_WORKSPACES=1).
//
// Each visitor gets a random workspace id in an HttpOnly cookie and their own folder under
// DATA_DIR/spaces/<id>/ with its own SQLite file. Their settings, sample data and any PayPal
// sandbox keys they connect live only there. Nobody else can reach them: the id is 128 random
// bits and is never shown in a URL. Workspaces nobody has opened for 3 days are deleted.
//
// A new workspace opens straight into demo mode with sample data, so a visitor lands on a
// working dashboard instead of a setup form.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { runInSpace, runOutside } from './context.js';
import { kvGet, kvSet } from './db.js';

export const COOKIE = 'pp_space';
const IDLE_MS = 3 * 24 * 3600 * 1000;
const MAX_SPACES = Number(process.env.MAX_WORKSPACES || 400);
const spaces = new Map();
let prepareHook = () => {};

export const spacesEnabled = () => /^(1|true|yes)$/i.test(process.env.VISITOR_WORKSPACES || '');
const rootDir = () => path.join(config.dataDir, 'spaces');
const validId = (id) => /^[a-f0-9]{32}$/.test(String(id || ''));

/** Set by the server: what a brand-new workspace gets (business name, demo data). */
export function onNewSpace(fn) {
  prepareHook = fn;
}

function load(id) {
  const space = { id, dir: path.join(rootDir(), id), conn: null, cfg: {}, state: {}, seen: Date.now(), touched: 0 };
  spaces.set(id, space);
  return space;
}

/** The workspace with this id, if it exists (in memory or on disk). */
export function getSpace(id) {
  if (!validId(id)) return null;
  if (spaces.has(id)) return spaces.get(id);
  return fs.existsSync(path.join(rootDir(), id)) ? load(id) : null;
}

/** A brand-new workspace, ready to use. */
export function createSpace() {
  sweep();
  const space = load(crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(space.dir, { recursive: true });
  runInSpace(space, () => prepareHook(space));
  return space;
}

/** Mark a workspace as used (kept for another 3 days). */
export function touch(space) {
  space.seen = Date.now();
  if (space.seen - space.touched > 60000) {
    space.touched = space.seen;
    try {
      fs.utimesSync(space.dir, new Date(), new Date());
    } catch {}
  }
}

/** Workspaces used in the last day, for background jobs (payment checks, reminders). */
export function activeSpaces() {
  return [...spaces.values()].filter((s) => Date.now() - s.seen < 24 * 3600 * 1000);
}

/** Run fn in each active workspace, one at a time. Errors in one don't stop the others. */
export async function forEachSpace(fn) {
  for (const s of activeSpaces()) {
    try {
      await runInSpace(s, fn);
    } catch (e) {
      console.log(`  [space ${s.id.slice(0, 6)}] ${e.message}`);
    }
  }
}

function remove(id) {
  const s = spaces.get(id);
  try {
    s?.conn?.close();
  } catch {}
  spaces.delete(id);
  fs.rmSync(path.join(rootDir(), id), { recursive: true, force: true });
}

/** Delete workspaces idle for 3 days, and the oldest ones beyond MAX_WORKSPACES. */
export function sweep() {
  let list;
  try {
    list = fs.readdirSync(rootDir()).filter(validId);
  } catch {
    return 0;
  }
  const age = (id) => {
    const live = spaces.get(id)?.seen;
    if (live) return live;
    try {
      return fs.statSync(path.join(rootDir(), id)).mtimeMs;
    } catch {
      return 0;
    }
  };
  let removed = 0;
  const sorted = list.map((id) => [id, age(id)]).sort((a, b) => a[1] - b[1]);
  for (const [i, [id, at]] of sorted.entries()) {
    if (Date.now() - at > IDLE_MS || sorted.length - i > MAX_SPACES - 1) {
      remove(id);
      removed++;
    }
  }
  return removed;
}

// ---- public pages (unlock /d/<token>, receipt /r/<token>) ----
// A client opens these links without the owner's cookie, so the shared database keeps a small
// index from token to workspace. It holds nothing else.

/** Remember which workspace a public token belongs to. */
export function notePublicToken(space, token) {
  if (!space) return;
  runOutside(() => kvSet(`pub:${token}`, space.id));
}

/** The workspace a public token belongs to. */
export function spaceForToken(token) {
  return getSpace(runOutside(() => kvGet(`pub:${token}`)));
}

export const spaceCount = () => {
  try {
    return fs.readdirSync(rootDir()).filter(validId).length;
  } catch {
    return 0;
  }
};
