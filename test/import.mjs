#!/usr/bin/env node
/**
 * Import smoke test: take an archive and materialise it into a *fresh* DSH
 * home + profile, which is what another machine looks like.
 *
 * Works for any archive: a plain plugin (format 1) installs its packages only;
 * an archive with runtime assets (format 2) also runs the in-package installer
 * and reports what it produced. The scratch home is created in the system temp
 * directory and removed at the end.
 *
 *   node test/import.mjs [<archive.zip>] [<home dir>]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractArchive, installPack } from '../lib/packer.js';
import { installAssets } from '../lib/assets.js';
import { readZip } from '../lib/zip.js';

const archive = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'build', 'dist', 'dsh-plugin-packer-2.1.0.dsh-plugin.zip'));
const home = resolve(process.argv[3] ?? mkdtempSync(join(tmpdir(), 'dsh-packer-import-')));
const profile = join(home, 'profiles', 'desktop');

rmSync(home, { recursive: true, force: true });
mkdirSync(join(profile, 'node_modules'), { recursive: true });
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'scratch', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2));

console.log('archive :', archive);
console.log('home    :', home);

const members = readZip(readFileSync(archive));
console.log('members :', members.length);
const pack = join(home, '.pack');
const copied = await extractArchive(pack, members);
console.log('extracted:', copied, 'files');

const report = await installPack(profile, pack, join(profile, '.plugin-packer', 'backups'));
console.log('packages:', report.installed.join(', '), '| format', report.formatVersion);

const started = Date.now();
const assets = await installAssets({ packDir: report.packDir, profileDir: profile, home, manifest: report.manifest, backupRoot: join(profile, '.plugin-packer', 'backups') });
console.log('assets  :', assets.length, 'in', ((Date.now() - started) / 1000).toFixed(1) + 's');
for (const asset of assets) console.log('          -', asset.id, '→', asset.installDir, asset.replaced ? '(替换旧目录)' : '');

const rootName = String(report.root?.name ?? '');
const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
const assetsPresent = assets.every((asset) => existsSync(asset.installDir));

const checks = [
  ['插件已铺进 node_modules', existsSync(join(profile, 'node_modules', rootName, 'package.json'))],
  ['根插件写进了 dependencies', typeof profileManifest.dependencies?.[rootName] === 'string'],
  ['导入报告格式合法', report.formatVersion === 1 || report.formatVersion === 2],
  ['资产数与清单一致', assets.length === (Array.isArray(report.manifest.assets) ? report.manifest.assets.length : 0)],
  ['资产落点都存在', assetsPresent],
  ['插件本体不含构建产物', !existsSync(join(profile, 'node_modules', rootName, 'build'))],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log((pass ? '  PASS  ' : '  FAIL  ') + label);
  if (!pass) ok = false;
}
rmSync(home, { recursive: true, force: true });
console.log(ok ? '\nIMPORT OK' : '\nIMPORT FAILED');
process.exitCode = ok ? 0 : 1;
