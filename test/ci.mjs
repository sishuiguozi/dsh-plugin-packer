#!/usr/bin/env node
/**
 * Self-contained check for CI: no real DSH profile, no system state.
 *
 * It builds a throwaway profile with a synthetic plugin (and a dependency),
 * exports it, verifies the archive layout, imports it into a second profile and
 * checks the result. The synthetic plugin also carries a `build/` directory that
 * is NOT in its `files` list, which proves the whitelist actually prunes.
 *
 *   node test/ci.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { buildManifest, expandClosure, extractArchive, installPack, planArchive, readProfileFacts } from '../lib/packer.js';
import { stageAssets } from '../lib/assets.js';
import { createZipStream, readZip } from '../lib/zip.js';

const work = mkdtempSync(join(tmpdir(), 'dsh-packer-ci-'));
const sourceHome = join(work, 'source');
const sourceProfile = join(sourceHome, 'profiles', 'ci');
const targetHome = join(work, 'target');
const targetProfile = join(targetHome, 'profiles', 'ci');
const archiveFile = join(work, 'fixture.dsh-plugin.zip');

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function writeText(file, text) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

function buildFixture() {
  writeJson(join(sourceProfile, 'package.json'), {
    name: 'ci-profile',
    private: true,
    dependencies: { 'fixture-plugin': '^1.0.0' },
    dsh: { profile: { bundles: ['fixture-plugin'] } },
  });
  const pluginDir = join(sourceProfile, 'node_modules', 'fixture-plugin');
  writeJson(join(pluginDir, 'package.json'), {
    name: 'fixture-plugin',
    version: '1.0.0',
    description: 'synthetic plugin used by CI',
    main: 'lib/index.js',
    files: ['lib', 'README.md'],
    dependencies: { 'fixture-dep': '^2.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: [] } },
  });
  writeText(join(pluginDir, 'cordis.patch.yml'), '- insert:\n    - id: fixture-plugin\n');
  writeText(join(pluginDir, 'README.md'), '# fixture\n');
  writeText(join(pluginDir, 'lib', 'index.js'), 'export function apply() {}\n');
  /* Outside the whitelist: must never reach the archive. */
  writeText(join(pluginDir, 'build', 'secret.txt'), 'do not ship');
  writeText(join(pluginDir, 'test', 'plugin.test.mjs'), 'throw new Error("do not ship")');

  const depDir = join(sourceProfile, 'node_modules', 'fixture-dep');
  writeJson(join(depDir, 'package.json'), { name: 'fixture-dep', version: '2.0.0', main: 'index.js' });
  writeText(join(depDir, 'index.js'), 'module.exports = 42;\n');
}

const results = [];
function check(label, pass, detail = '') {
  results.push(pass);
  console.log((pass ? '  PASS  ' : '  FAIL  ') + label + (detail === '' ? '' : ' — ' + detail));
}

try {
  buildFixture();

  /* ---- export ---- */
  const closure = expandClosure(sourceProfile, 'fixture-plugin');
  const plan = planArchive(sourceProfile, closure);
  const staged = await stageAssets(sourceProfile, 'fixture-plugin');
  const facts = readProfileFacts(sourceProfile);
  const manifest = buildManifest(closure, plan, {
    profileName: 'ci',
    enabled: facts.bundles.has('fixture-plugin'),
    generatorVersion: '2.1.1',
    assets: staged.entries,
  });

  const names = plan.sources.map((entry) => entry.name);
  const header = { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') };
  await pipeline(Readable.from(createZipStream([header, ...plan.sources])), createWriteStream(archiveFile));

  check('闭包含插件与依赖', closure.packages.length === 2, closure.packages.map((entry) => entry.name).join(', '));
  check('白名单内的文件进包', names.some((name) => name.endsWith('packages/fixture-plugin/lib/index.js')));
  check('白名单外的 build/ 不进包', !names.some((name) => name.includes('/build/')));
  check('白名单外的 test/ 不进包', !names.some((name) => name.includes('/test/')));
  check('依赖包完整进包', names.some((name) => name.includes('packages/fixture-dep/index.js')));
  check('无资产时为 format 1', manifest.formatVersion === 1);
  check('清单里没有机器盘符', !/[A-Za-z]:[\\/]/.test(JSON.stringify(manifest)));

  /* ---- import into a fresh profile ---- */
  const members = readZip(readFileSync(archiveFile));
  const packDir = join(work, 'extracted');
  await extractArchive(packDir, members);
  writeJson(join(targetProfile, 'package.json'), { name: 'ci-target', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } });
  mkdirSync(join(targetProfile, 'node_modules'), { recursive: true });
  const report = await installPack(targetProfile, packDir, join(targetProfile, '.plugin-packer', 'backups'));

  const installed = JSON.parse(readFileSync(join(targetProfile, 'package.json'), 'utf8'));
  check('导入铺回插件', existsSync(join(targetProfile, 'node_modules', 'fixture-plugin', 'package.json')));
  check('导入铺回依赖', existsSync(join(targetProfile, 'node_modules', 'fixture-dep', 'package.json')));
  check('根插件写进 dependencies', typeof installed.dependencies?.['fixture-plugin'] === 'string');
  check('导入报告格式为 1', report.formatVersion === 1);
  check('导入后不含构建产物', !existsSync(join(targetProfile, 'node_modules', 'fixture-plugin', 'build')));
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((pass) => pass !== true).length;
console.log('\n' + (failed === 0 ? 'CI OK (' + results.length + ' checks)' : 'CI FAILED (' + failed + '/' + results.length + ')'));
process.exitCode = failed === 0 ? 0 : 1;
