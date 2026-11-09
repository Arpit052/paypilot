// Hosting platforms: the app must listen on all interfaces, keep its data where the platform
// keeps files, build public links from the platform's address, and see each visitor's real IP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const probe = (env) =>
  JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { config } = await import('./src/config.js');
      const { publicBase } = await import('./src/delivery.js');
      console.log(JSON.stringify({ host: config.host, dataDir: config.dataDir, base: publicBase() }));`], {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    }).trim().split('\n').at(-1),
  );

test('Azure App Service: all interfaces, data in /home, links on the site address', () => {
  const r = probe({ WEBSITE_SITE_NAME: 'paypilot', WEBSITE_HOSTNAME: 'paypilot.azurewebsites.net', PORT: '8080' });
  assert.equal(r.host, '0.0.0.0');
  assert.equal(r.dataDir, '/home/data');
  assert.equal(r.base, 'https://paypilot.azurewebsites.net');
});

test('Render and local defaults are unchanged', () => {
  assert.equal(probe({ RENDER: 'true' }).host, '0.0.0.0');
  const local = probe({});
  assert.equal(local.host, '127.0.0.1');
  assert.match(local.dataDir, /data$/);
  assert.equal(probe({ WEBSITE_SITE_NAME: 'x', DATA_DIR: '/custom' }).dataDir, '/custom', 'DATA_DIR still wins');
});

test('a client IP with a port (as Azure forwards it) counts as one address', async () => {
  const { clientIp } = await import('../src/config.js');
  assert.equal(clientIp({ ip: '203.0.113.5:51234' }), '203.0.113.5');
  assert.equal(clientIp({ ip: '203.0.113.5' }), '203.0.113.5');
  assert.equal(clientIp({ ip: '[2001:db8::1]:443' }), '2001:db8::1');
  assert.equal(clientIp({ ip: '::ffff:10.0.0.1' }), '::ffff:10.0.0.1');
  assert.equal(clientIp({}), 'local');
});
