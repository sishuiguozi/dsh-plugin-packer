#!/usr/bin/env node
/**
 * Pack this plugin into a `.dsh-plugin.zip` straight from its own source tree,
 * using this package's own packer library — no external tool needed.
 *
 * Only the published files (`package.json#files`) are staged: the working tree
 * also holds `build/` with a 140 MB asset bundle and test scratch space, none of
 * which belongs inside a plugin archive.
 *
 *   node tools/pack-self.mjs [--out <zip>]
 */
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argument(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return typeof value === 'string' && !value.startsWith('--') ? value : fallback;
}

const selfManifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
const outFile = resolve(argument('out', join(REPO, 'build', 'dist', selfManifest.name + '-' + selfManifest.version + '.dsh-plugin.zip')));

/* 1. Stage exactly what npm would publish. */
const staging = join(tmpdir(), 'dsh-packer-stage-' + process.pid);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(join(REPO, 'package.json'), join(staging, 'package.json'));
const shipped = [];
for (const entry of selfManifest.files ?? []) {
  const from = join(REPO, entry);
  if (!existsSync(from)) continue;
  await cp(from, join(staging, entry), { recursive: true });
  shipped.push(entry);
}
console.log('staged    :', shipped.join(', '));

/* 2. Build the archive with this package's own packer. */
const packer = await import(pathToFileURL(join(REPO, 'lib', 'packer.js')).href);
const { createZipStream } = await import(pathToFileURL(join(REPO, 'lib', 'zip.js')).href);

const closure = packer.expandClosure(staging, selfManifest.name, staging);
/* planArchive derives the path below node_modules; the staged tree is not in a
 * node_modules, so build the layout here: one package, one prefix. */
const sources = [];
let total = 0;
for (const file of packer.listFiles(staging)) {
  sources.push({ name: 'packages/' + selfManifest.name + '/' + file.path, file: join(staging, file.path), size: file.size, mtime: file.mtime });
  total += file.size;
}
const plan = { relative: () => 'packages/' + selfManifest.name, sources, total, files: sources.length };
const packManifest = packer.buildManifest(closure, plan, {
  profileName: 'desktop',
  enabled: true,
  generatorVersion: selfManifest.version,
  assets: [],
});
if (packManifest.formatVersion !== 1) throw new Error('a plugin without assets must stay format 1, got ' + packManifest.formatVersion);

await mkdir(dirname(outFile), { recursive: true });
const header = { name: 'manifest.json', data: Buffer.from(JSON.stringify(packManifest, null, 2), 'utf8') };
await pipeline(Readable.from(createZipStream([header, ...plan.sources])), createWriteStream(outFile));
/* The staging tree lives in the system temp directory; drop it so repeated
 * packs never accumulate copies of the published files. */
await rm(staging, { recursive: true, force: true });

console.log('package   :', selfManifest.name + '@' + selfManifest.version);
console.log('files     :', plan.files, '| format', packManifest.formatVersion);
console.log('archive   :', outFile, '(' + (statSync(outFile).size / 1024).toFixed(0) + ' KB)');
console.log('\n下一步：设置 → 插件 → 插件打包 → 导入 zip（或 POST /plugin-packer/api/import）。');
