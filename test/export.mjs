#!/usr/bin/env node
/**
 * Export smoke test: build a real archive for one installed plugin and verify
 * the structure it promises — package files, manifest, and (only when the
 * plugin declares runtime assets) the asset block.
 *
 * Not part of the shipped package — it is the check used during development.
 *   node test/export.mjs [<plugin>] [<out zip>] [<profile dir>]
 */
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildManifest, expandClosure, planArchive, readProfileFacts } from '../lib/packer.js';
import { stageAssets } from '../lib/assets.js';
import { createZipStream, readZip } from '../lib/zip.js';

const plugin = process.argv[2] ?? 'dsh-plugin-packer';
const outFile = resolve(process.argv[3] ?? join(tmpdir(), 'dsh-packer-export-test.zip'));
const profileDir = resolve(process.argv[4] ?? join(homedir(), '.dsh', 'profiles', 'desktop'));

console.log('profile :', profileDir);
console.log('plugin  :', plugin);

const started = Date.now();
const closure = expandClosure(profileDir, plugin);
const plan = planArchive(profileDir, closure);
console.log('closure :', closure.packages.length, 'packages,', plan.files, 'files,', (plan.total / 1048576).toFixed(2), 'MB');

const staged = await stageAssets(profileDir, plugin);
console.log('assets  :', staged.entries.length, 'asset(s),', staged.totals.files, 'files,', (staged.totals.bytes / 1048576).toFixed(2), 'MB');
for (const entry of staged.entries) console.log('          -', entry.id, '→', entry.installDir);

const facts = readProfileFacts(profileDir);
const manifest = buildManifest(closure, plan, {
  profileName: 'desktop',
  enabled: facts.bundles.has(plugin),
  generatorVersion: '2.1.0',
  assets: staged.entries,
});
console.log('manifest:', 'format', manifest.formatVersion, '| assets', manifest.assets.length, '| files', manifest.totals.files + '+' + manifest.totals.assetFiles);

mkdirSync(dirname(outFile), { recursive: true });
const header = { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') };
const sources = [header, ...plan.sources, ...staged.sources];
await pipeline(Readable.from(createZipStream(sources)), createWriteStream(outFile));
const written = statSync(outFile);
console.log('archive :', outFile);
console.log('          ', (written.size / 1024).toFixed(1), 'KB in', ((Date.now() - started) / 1000).toFixed(2) + 's');

/* Read it back: the importer's view is the one that matters. */
const members = readZip(readFileSync(outFile));
const assetNames = members.filter((member) => member.name.startsWith('assets/'));
const packageNames = members.filter((member) => member.name.startsWith('packages/'));
const parsed = JSON.parse(members.find((member) => member.name === 'manifest.json').data.toString('utf8'));
const expectedFormat = staged.entries.length === 0 ? 1 : 2;
const checks = [
  ['manifest.json 可解析', parsed.format === 'dsh-plugin-pack'],
  ['格式与资产一致（无资产=1，有资产=2）', parsed.formatVersion === expectedFormat],
  ['资产条目与暂存一致', Array.isArray(parsed.assets) && parsed.assets.length === staged.entries.length],
  ['资产文件在包里', assetNames.length === staged.totals.files],
  ['插件文件在包里', packageNames.length > 0],
  ['根插件正确', parsed.root.name === plugin],
  ['清单里没有机器盘符', !/[A-Za-z]:[\\/]/.test(JSON.stringify(parsed))],
  ['只打包 package.json#files 白名单内容', !packageNames.some((member) => /\/(build|node_modules|test)\//.test(member.name))],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log((pass ? '  PASS  ' : '  FAIL  ') + label);
  if (!pass) ok = false;
}
console.log(ok ? '\nEXPORT OK' : '\nEXPORT FAILED');
process.exitCode = ok ? 0 : 1;
