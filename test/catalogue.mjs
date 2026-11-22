#!/usr/bin/env node
/**
 * Fast catalogue check: the list endpoint's dates, ordering and totals.
 *
 * Complements test/host.test.mjs, which exports and imports a 165 MB
 * environment. This one only reads the profile and the loopback API, so it runs
 * in a second and is safe to call on every edit.
 *
 *   node test/catalogue.mjs [profile dir]
 */
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { SORT_KEYS, listPlugins } from '../lib/packer.js';

const profileDir = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop');

const results = [];
function check(label, pass, detail = '') {
  results.push(pass);
  console.log((pass ? '  PASS  ' : '  FAIL  ') + label + (detail === '' ? '' : ' — ' + detail));
}

/* ---- pure catalogue ---- */
const catalogue = listPlugins(profileDir);
check('listPlugins 返回 profile 与排序信息', typeof catalogue.profile === 'string' && SORT_KEYS.includes(catalogue.sort), 'sort=' + catalogue.sort + ', order=' + catalogue.order);
check('默认按更新时间倒序', catalogue.sort === 'updated' && catalogue.order === 'desc');

const installed = catalogue.rows.filter((entry) => entry.installed);
check('每行都带安装日期与更新时间', installed.length > 0 && installed.every((entry) => typeof entry.installedAt === 'string' && typeof entry.updatedAt === 'string'),
  installed.length + ' 个已安装包');
check('日期可被解析', installed.every((entry) => Number.isFinite(Date.parse(entry.installedAt)) && Number.isFinite(Date.parse(entry.updatedAt))));

const linked = catalogue.rows.filter((entry) => entry.installed && entry.linked === true);
const plain = catalogue.rows.filter((entry) => entry.installed && entry.linked === false);
check('区分链接目录与真实安装目录', linked.length > 0 && plain.length > 0, 'linked=' + linked.length + ', 安装=' + plain.length);

const byUpdated = listPlugins(profileDir, { sort: 'updated', order: 'desc' }).rows.filter((entry) => entry.updatedAt !== null);
const descending = byUpdated.every((entry, index) => index === 0 || Date.parse(byUpdated[index - 1].updatedAt) >= Date.parse(entry.updatedAt));
check('按更新时间倒序确实递减', descending, byUpdated.slice(0, 3).map((entry) => entry.name + '@' + entry.updatedAt.slice(0, 10)).join(', '));

const bySize = listPlugins(profileDir, { sort: 'size', order: 'desc' }).rows;
const sizeOk = bySize.every((entry, index) => index === 0 || (bySize[index - 1].bytes ?? -1) >= (entry.bytes ?? -1));
check('按体积倒序确实递减', sizeOk, bySize.slice(0, 3).map((entry) => entry.name + '=' + entry.bytes).join(', '));

const byName = listPlugins(profileDir, { sort: 'name', order: 'asc' }).rows.map((entry) => entry.name);
const nameOk = byName.every((name, index) => index === 0 || byName[index - 1].localeCompare(name) <= 0);
check('按名称升序确实递增', nameOk, byName.slice(0, 3).join(', '));

/* ---- loopback API ---- */
const routes = [];
const ctx = {
  webServer: { register(options) { routes.push(options); return () => {}; } },
  get(name) { return name === 'profileContext' ? { dir: profileDir, name: 'desktop' } : undefined; },
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
const base = 'http://127.0.0.1:' + server.address().port + '/plugin-packer/api';

const list = await (await fetch(base + '/list?sort=installed&order=asc')).json();
check('/api/list 接了 sort/order 参数', list.sort === 'installed' && list.order === 'asc', list.sort + ' ' + list.order);
check('/api/list 有 totals 汇总', typeof list.totals?.bytes === 'number' && typeof list.totals?.plugins === 'number', JSON.stringify(list.totals));
check('/api/list 每行带 installedAt/updatedAt', Array.isArray(list.rows) && list.rows.filter((entry) => entry.installed).every((entry) => 'installedAt' in entry && 'updatedAt' in entry));

const latest = await (await fetch(base + '/latest?names=dsh-plugin-packer')).json();
const entry = latest.versions?.['dsh-plugin-packer'];
check('/api/latest 返回查询结果（离线也算通过）', latest.ok === true && entry !== undefined, JSON.stringify(entry));

server.close();
const failed = results.filter((pass) => pass !== true).length;
console.log('\n' + (failed === 0 ? 'CATALOGUE OK (' + results.length + ' checks)' : 'CATALOGUE FAILED (' + failed + '/' + results.length + ')'));
process.exitCode = failed === 0 ? 0 : 1;
