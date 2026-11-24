#!/usr/bin/env node
/**
 * Host access-gate test: the API must honour `ctx.connection.requestRejection`
 * when the host publishes one, and keep working when it does not.
 *
 * Three mounts against the same throwaway profile:
 *   A — gate answers 403  → every route must be refused
 *   B — gate answers undefined → routes work as before
 *   C — no connection service at all (older host) → routes work as before
 *
 *   node test/gate.mjs
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const work = mkdtempSync(join(tmpdir(), 'dsh-packer-gate-'));
const profileDir = join(work, 'profiles', 'gate');
mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify({ name: 'gate', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
);

const results = [];
function check(label, pass, detail = '') {
  results.push(pass);
  console.log((pass ? '  PASS  ' : '  FAIL  ') + label + (detail === '' ? '' : ' — ' + detail));
}

async function mount(connection) {
  const routes = [];
  const calls = [];
  const ctx = {
    webServer: { register(options) { routes.push(options); return () => {}; } },
    get(name) {
      if (name === 'profileContext') return { dir: profileDir, name: 'gate' };
      if (name === 'connection') return connection === null ? undefined : connection;
      return undefined;
    },
    effect() {},
    logger: { info: () => {}, warn: () => {} },
  };
  apply(ctx, {});
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    const route = routes.find((entry) => url === entry.path || url.startsWith(entry.path + '/'));
    if (route === undefined) { response.writeHead(404).end('no route'); return; }
    route.handler(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500).end(String(error));
      else response.destroy();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { base: 'http://127.0.0.1:' + server.address().port + '/plugin-packer/api', server, calls };
}

try {
  /* A — the host refuses. */
  const refusing = await mount({ requestRejection: (request) => { refusing.calls?.push(request); return 403; } });
  const refused = await fetch(refusing.base + '/health');
  check('宿主拒绝时返回 403', refused.status === 403, 'status ' + refused.status);
  const refusedBody = await refused.json();
  check('拒绝理由可读', String(refusedBody?.error?.message ?? '').includes('access policy'), refusedBody?.error?.message ?? '');
  refusing.server.close();

  /* B — the host admits. */
  let gateCalled = 0;
  const admitting = await mount({ requestRejection: () => { gateCalled += 1; return undefined; } });
  const allowed = await fetch(admitting.base + '/health');
  check('宿主放行时正常工作', allowed.status === 200, 'status ' + allowed.status);
  check('放行时确实问过宿主', gateCalled > 0, '调用 ' + gateCalled + ' 次');
  admitting.server.close();

  /* C — an older host without the service. */
  const legacy = await mount(null);
  const legacyResponse = await fetch(legacy.base + '/health');
  check('旧宿主（无 connection）仍可用', legacyResponse.status === 200, 'status ' + legacyResponse.status);
  legacy.server.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((pass) => pass !== true).length;
console.log('\n' + (failed === 0 ? 'GATE OK (' + results.length + ' checks)' : 'GATE FAILED (' + failed + '/' + results.length + ')'));
process.exitCode = failed === 0 ? 0 : 1;
