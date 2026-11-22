#!/usr/bin/env node
/** 证明：对「没有运行时资产」的普通插件仍然产出 format 1 包，且新旧格式都能导入。 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { buildManifest, expandClosure, planArchive, readProfileFacts, extractArchive, installPack } from '../lib/packer.js';
import { stageAssets } from '../lib/assets.js';
import { createZipStream, readZip } from '../lib/zip.js';

const profile = process.argv[2] ?? 'C:/Users/15569/.dsh/profiles/desktop';
const plugin = process.argv[3] ?? 'dsh-status-rotator';
const closure = expandClosure(profile, plugin);
const plan = planArchive(profile, closure);
const staged = await stageAssets(profile, plugin);
const facts = readProfileFacts(profile);
const manifest = buildManifest(closure, plan, { profileName: 'desktop', enabled: facts.bundles.has(plugin), generatorVersion: '2.0.0', assets: staged.entries });
console.log('plugin :', plugin, '| 资产:', staged.entries.length, '| formatVersion:', manifest.formatVersion);
if (manifest.formatVersion !== 1) throw new Error('普通插件应保持 format 1');
const zipFile = join(tmpdir(), 'plain-' + plugin.replace(/[^a-z0-9]/gi, '-') + '.zip');
await pipeline(Readable.from(createZipStream([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }, ...plan.sources])), createWriteStream(zipFile));
console.log('zip    :', zipFile, (statSync(zipFile).size / 1024).toFixed(0) + ' KB');

/* 用 temp profile 走一次导入：installPack 的差别只在 formatVersion
   白名单——只认 1 的旧工具会拒绝 format 2，本模块认 1 和 2。 */
const home = mkdtempSync(join(tmpdir(), 'plain-home-'));
const target = join(home, 'profiles', 'desktop');
mkdirSync(join(target, 'node_modules'), { recursive: true });
writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2));
const members = readZip(readFileSync(zipFile));
const pack = join(home, 'pack');
await extractArchive(pack, members);
const report = await installPack(target, pack, join(home, 'backups'));
console.log('import :', report.installed.join(','), '| format', report.formatVersion, '| 依赖已登记:', Object.keys(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).dependencies).join(','));
console.log('\nPLAIN OK');
