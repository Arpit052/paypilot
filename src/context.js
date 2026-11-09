// Which visitor workspace the current request belongs to.
//
// On the hosted demo every visitor gets a private workspace (own database, own settings, own
// PayPal keys). AsyncLocalStorage carries the workspace through every await of a request, so
// the rest of the code keeps calling sql(), config.x and kvGet() as if there were one user.
// Locally there is no workspace and everything uses the single default database.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/** The workspace of the running request or job, or null (local, single-user mode). */
export const currentSpace = () => als.getStore() || null;

/** Run fn inside a workspace. */
export const runInSpace = (space, fn) => als.run(space, fn);

/** Run fn outside any workspace (the shared default database). */
export const runOutside = (fn) => als.exit(fn);

/**
 * Module state that must not leak between visitors (caches, cursors, timers' flags).
 * Returns an object whose properties live per workspace; outside a workspace it uses one default.
 */
export function perSpace(init) {
  const key = Symbol('state');
  const root = init();
  const obj = () => {
    const s = currentSpace();
    if (!s) return root;
    if (!s.state[key]) s.state[key] = init();
    return s.state[key];
  };
  return new Proxy(
    {},
    {
      get: (_, k) => obj()[k],
      set: (_, k, v) => {
        obj()[k] = v;
        return true;
      },
      has: (_, k) => k in obj(),
      ownKeys: () => Reflect.ownKeys(obj()),
      getOwnPropertyDescriptor: (_, k) => Object.getOwnPropertyDescriptor(obj(), k),
    },
  );
}
