#!/usr/bin/env node
/**
 * HTTP self-test for the host half: mount the real `apply()` behind a real
 * server on a loopback port and drive it with real requests — the same code the
 * settings tab talks to after a restart.
 *
 * Two servers, because export reads and import writes:
 *   A — the live profile: health / list / assets / export this plugin
 *   B — a throwaway DSH home: import the archive A produced
 *
 * The archive is small on purpose: this test exercises the API, not the size of
 * any particular plugin's runtime assets.
 *
 *   node test/host.test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const REAL_PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop');
const TEMP_HOME = mkdtempSync(join(tmpdir(), 'dsh-packer-home-'));
const TEMP_PROFILE = join(TEMP_HOME, 'profiles', 'desktop');
const SUBJECT = 'dsh-plugin-packer';

function contextFor(profileDir) {
  const routes = [];
  return {
    routes,
    ctx: {
      webServer: {
        register(options) {
          routes.push(options);
          return () => {};
        },
      },
      get(name) {
        if (name === 'profileContext') return { dir: profileDir, name: 'desktop' };
        return undefined;
      },
      effect() {},
      logger: { info: () => {}, warn: (message) => console.warn('  [warn]', message) },
    },
  };
}

async function mount(profileDir) {
  const { routes, ctx } = contextFor(profileDir);
  apply(ctx, {});
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    const route = routes.find((entry) => url === entry.path || url.startsWith(entry.path + '/'));
    if (route === undefined) {
      response.writeHead(404).end('no route');
      return;
    }
    route.handler(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500).end(String(error));
      else response.destroy();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, server, routes };
}

const results = [];
function check(label, pass, detail = '') {
  results.push(pass);
  console.log((pass ? '  PASS  ' : '  FAIL  ') + label + (detail === '' ? '' : ' — ' + detail));
}

/* ---------------------------------------------------------------- *
 * A — live profile: read-only endpoints plus the export
 * ---------------------------------------------------------------- */
const live = await mount(REAL_PROFILE);
console.log('A', live.base, '(live profile)');
const health = await (await fetch(live.base + '/plugin-packer/api/health')).json();
check('health 报出格式版本', health.ok === true && Array.isArray(health.acceptsFormats), 'format ' + health.packFormatVersion + ', accepts ' + JSON.stringify(health.acceptsFormats));

const list = await (await fetch(live.base + '/plugin-packer/api/list')).json();
const row = (list.rows ?? []).find((entry) => entry.name === SUBJECT);
check('list 返回本次插件', row !== undefined, row === undefined ? '没有该行' : 'version=' + row.version);
check('list 行带日期与链接标记', row !== undefined && typeof row.updatedAt === 'string' && typeof row.linked === 'boolean');
check('list 带 totals 汇总', typeof list.totals?.bytes === 'number');

const assets = await (await fetch(live.base + '/plugin-packer/api/assets')).json();
check('assets 端点可读且不泄露盘符', assets.ok === true && !/[A-Za-z]:[\\/]/.test(JSON.stringify(assets)), 'descriptors=' + (assets.descriptors?.length ?? 0));

const exportResponse = await fetch(live.base + '/plugin-packer/api/export?name=' + SUBJECT);
const archive = Buffer.from(await exportResponse.arrayBuffer());
const archiveFile = join(TEMP_HOME, 'http-export.zip');
writeFileSync(archiveFile, archive);
check('export 返回 zip 且文件名带日期', exportResponse.ok && /-\d{8}\.dsh-plugin\.zip/.test(exportResponse.headers.get('content-disposition') ?? ''), (archive.length / 1024).toFixed(1) + ' KB');
live.server.close();

/* ---------------------------------------------------------------- *
 * B — throwaway home: import what A produced
 * ---------------------------------------------------------------- */
rmSync(TEMP_HOME, { recursive: true, force: true });
mkdirSync(join(TEMP_PROFILE, 'node_modules'), { recursive: true });
writeFileSync(join(TEMP_PROFILE, 'package.json'), JSON.stringify({ name: 'scratch', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2));

const scratch = await mount(TEMP_PROFILE);
console.log('B', scratch.base, '(throwaway profile)');
const started = Date.now();
const importResponse = await fetch(scratch.base + '/plugin-packer/api/import', {
  method: 'POST',
  headers: { 'content-type': 'application/zip' },
  body: archive,
});
const imported = await importResponse.json();
check('import 成功', importResponse.ok && imported.ok === true, importResponse.ok ? ((Date.now() - started) / 1000).toFixed(1) + 's' : JSON.stringify(imported).slice(0, 200));
check('导入报告格式为 1 或 2', imported.formatVersion === 1 || imported.formatVersion === 2, 'format ' + imported.formatVersion);
check('插件铺进 node_modules', existsSync(join(TEMP_PROFILE, 'node_modules', SUBJECT, 'package.json')));
check('根插件写进了 dependencies', (() => {
  try {
    const manifest = JSON.parse(readFileSync(join(TEMP_PROFILE, 'package.json'), 'utf8'));
    return typeof manifest.dependencies?.[SUBJECT] === 'string';
  } catch {
    return false;
  }
})());
scratch.server.close();

const failed = results.filter((pass) => pass !== true).length;
rmSync(TEMP_HOME, { recursive: true, force: true });
console.log('\n' + (failed === 0 ? 'HTTP OK (' + results.length + ' checks)' : 'HTTP FAILED (' + failed + '/' + results.length + ')'));
process.exitCode = failed === 0 ? 0 : 1;
